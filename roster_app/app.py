# -*- coding: utf-8 -*-
"""
app.py — 排班系統統一後端 (Flask)
=========================================================
一支檔案取代原本的 api.asp，所有資料的「上拋與寫入」都由這裡處理。

● 啟動伺服器
    python app.py
    → 直接執行 app.run()，監聽 0.0.0.0:5000
      統一入口： http://127.0.0.1:5000/api?action=...

  支援的 action（GET / POST 視動作而定）：
    auth            登入（POST，只需 工號；目前忽略密碼）→ 回傳 True + 角色/姓名
    roster_load     讀取該站值班名單 data/<site>/roster.json
    roster_add      值班納編新增（工號唯一性檢查 → 同寫 roster + users.json）(POST)
    roster_save     覆寫該站值班名單（編輯/移除標記同步）            (POST)
    load_schedule   讀取某站台的月份班表檔（顯示用）
    save_schedule   寫入某站台的月份班表檔 + meta (POST)  ★顯示與寫入同一份★
    load            (相容)讀取 alldata.json
    save            (相容)寫入 alldata.json            (POST)
    backup          建立備份（打包月份檔）           (POST)
    backups         列出備份清單
    status          伺服器狀態
    rb_load         讀取工號權限綁定（全廠共用）
    rb_save         寫入工號權限綁定（全廠共用）  (POST)
    lock_check      查 Leader 鎖
    lock_acquire    取得 Leader 鎖                (POST)
    lock_heartbeat  Leader 鎖續命                 (POST)
    lock_release    釋放 Leader 鎖                (POST)
  站台以 ?site=A3|KL|NK 指定（預設 A3），各站資料存於 data/<site>/。

● 管理帳號（工號 / 密碼 / 角色 / 顯示姓名）→ 直接編輯 users.json
    {
      "users": [
        {"account": "ADM-001", "name": "系統管理員", "role": "LEADER", "password": "admin123"},
        {"account": "F1234",   "name": "王小明",     "role": "ENG",    "password": "eng123"}
      ]
    }
    role 可為 ADMIN、LEADER 或 ENG。
    若要加密，改放 password_hash 欄位，後端會優先以雜湊驗證。

安裝套件：
    pip install -r requirements.txt        (Flask, Flask-Cors)
"""
import os
import sys
import json
from datetime import datetime
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from loguru import logger
from ldap3 import Server, Connection, ALL, NTLM # type: ignore
from ldap3.core.exceptions import LDAPException, LDAPBindError # type: ignore

HERE = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(HERE, "users.json")
DATA_DIR = os.path.join(HERE, "data")
RB_FILE = os.path.join(DATA_DIR, "rolebindings.json")  # 工號權限綁定：全廠共用

LOCK_TIMEOUT_SEC = 90          # Leader 鎖逾時（無心跳視為失效）
VERSION = "4.0.0"

# ════════════════════════════════════════════════════════════
#  審計日誌（loguru）：logs/audit_YYYY-MM-DD.log
#  每日 00:00 輪替新檔，自動保留 90 天（逾期自動刪除）
# ════════════════════════════════════════════════════════════
LOG_DIR = os.path.join(HERE, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
logger.remove()
logger.add(sys.stderr, level="INFO",
           format="{time:HH:mm:ss} | {level:<7} | {message}")
logger.add(os.path.join(LOG_DIR, "audit_{time:YYYY-MM-DD}.log"),
           rotation="00:00", retention="90 days", encoding="utf-8",
           enqueue=True, level="INFO",
           format="{time:YYYY-MM-DD HH:mm:ss} | {level:<7} | {message}")


def get_operator():
    """前端每個 API 請求以 X-Operator 標頭帶操作者工號。"""
    return (request.headers.get("X-Operator") or "").strip()


def audit(action, detail="", level="INFO", operator=None):
    """寫一筆審計紀錄：[動作] 操作者=工號(姓名/角色) IP=來源 內容"""
    op = operator if operator is not None else get_operator()
    u = find_user(op) if op else None
    who = (op or "未知") + (
        "(" + u.get("name", "") + "/" + (u.get("role", "") or "ENG").upper() + ")"
        if u else "")
    ip = request.remote_addr or "-"
    site = (request.args.get("site") or "A3").strip().upper()
    msg = f"[{action}] 站台={site} 操作者={who} IP={ip}" + ((" " + detail) if detail else "")
    logger.log(level, msg)


# ════════════════════════════════════════════════════════════
#  共用：檔案 / 路徑
# ════════════════════════════════════════════════════════════
def ensure_dirs(site):
    site_dir = os.path.join(DATA_DIR, site)
    os.makedirs(os.path.join(site_dir, "backups"), exist_ok=True)
    return site_dir


def normalize_site(raw):
    s = (raw or "").strip().upper()
    return s if s in ("A3", "KL", "NK") else "A3"


def site_paths(site):
    site_dir = ensure_dirs(site)
    return {
        "dir": site_dir,
        "all": os.path.join(site_dir, "alldata.json"),
        "lock": os.path.join(site_dir, "leader_lock.json"),
        "backups": os.path.join(site_dir, "backups"),
    }


def read_text(path):
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def now_stamp():
    return datetime.now().strftime("%Y%m%d_%H%M%S")


# ════════════════════════════════════════════════════════════
#  users.json（帳號 / 密碼 / 角色 / 姓名）
# ════════════════════════════════════════════════════════════
def load_users():
    if not os.path.exists(USERS_FILE):
        return {"users": []}
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("users", [])
        return data
    except Exception as e:
        print(f"WARN 讀取 users.json 失敗: {e}")
        return {"users": []}


def save_users(data):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def find_user(account):
    """以帳號或顯示姓名比對（去空白、不分大小寫）。"""
    if not account:
        return None
    key = account.strip().lower()
    for u in load_users()["users"]:
        if u.get("account", "").strip().lower() == key:
            return u
        if u.get("name", "").strip().lower() == key:
            return u
    return None



def authenticate_user(username, password):
    try:
        server = Server('ldap://KHADDC02.kh.asegroup.com', get_info=ALL)
        user = f'kh\\{username}'
        conn = Connection(server, user=user, password=password, authentication=NTLM)
        return bool(conn.bind())
    except Exception:
        return False



# ════════════════════════════════════════════════════════════
#  Leader 鎖
# ════════════════════════════════════════════════════════════
def read_lock(paths):
    txt = read_text(paths["lock"])
    if not txt:
        return None
    try:
        return json.loads(txt)
    except Exception:
        return None


def lock_is_active(lock):
    """回傳 (是否有效, holder名稱, holder token)。"""
    if not lock:
        return False, "", ""
    tok = lock.get("token", "")
    nm = lock.get("name", "")
    lb = lock.get("lastBeat", "")
    if not tok or not lb:
        return False, "", ""
    try:
        last = datetime.strptime(lb, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return False, "", ""
    if (datetime.now() - last).total_seconds() > LOCK_TIMEOUT_SEC:
        return False, "", ""
    return True, nm, tok


def write_lock(paths, token, name, role, acquired_at, last_beat):
    write_text(paths["lock"], json.dumps({
        "token": token, "name": name, "role": role,
        "lastBeat": last_beat, "acquiredAt": acquired_at,
    }, ensure_ascii=False))


# ════════════════════════════════════════════════════════════
#  排班逐格差異比對（審計日誌用）
# ════════════════════════════════════════════════════════════
def diff_schedule_changes(paths, site, months):
    """比對「即將寫入的月份資料」與「磁碟上的舊檔」，回傳逐格變更清單。
    回傳：(changes, new_months)
      changes    : ["F8129 2026-06-05 type:ON→LEAVE,ot:0→1", ...]
      new_months : ["202610(64人)", ...]  全新建立的月份
    """
    changes, new_months = [], []
    for ym, content in (months or {}).items():
        if not (isinstance(ym, str) and len(ym) == 6 and ym.isdigit()):
            continue
        fp = os.path.join(paths["dir"], f"{site}_schedule_{ym}.json")
        if not os.path.exists(fp):
            n = sum(len(p or []) for p in (content.get("shifts") or {}).values())
            new_months.append(f"{ym}({n}人)")
            continue
        try:
            old = json.loads(read_text(fp))
        except Exception:
            old = {}
        oldmap = {}
        for ppl in (old.get("shifts") or {}).values():
            for p in ppl or []:
                for dd, day in (p.get("days") or {}).items():
                    oldmap[(p.get("id"), dd)] = day or {}
        newids, oldids = set(), set()
        for ppl in (old.get("shifts") or {}).values():
            for p in ppl or []:
                oldids.add(p.get("id"))
        for ppl in (content.get("shifts") or {}).values():
            for p in ppl or []:
                pid = p.get("id")
                newids.add(pid)
                for dd, day in (p.get("days") or {}).items():
                    o = oldmap.get((pid, dd))
                    if o is None:
                        continue
                    day = day or {}
                    diffs = [f"{k}:{o.get(k)}→{day.get(k)}"
                             for k in ("type", "loc", "leave", "ot")
                             if o.get(k) != day.get(k)]
                    if diffs:
                        changes.append(
                            f"{pid} {ym[:4]}-{ym[4:]}-{dd} " + ",".join(diffs))
        for pid in sorted(newids - oldids):
            changes.append(f"{ym} 新增人員 {pid}")
        for pid in sorted(oldids - newids):
            changes.append(f"{ym} 名單移除 {pid}")
    return changes, new_months


# ════════════════════════════════════════════════════════════
#  Flask 伺服器
# ════════════════════════════════════════════════════════════

app = Flask(__name__)
CORS(app, resources={r"/api*": {"origins": "*"}})

def raw_json(text):
    return Response(text, mimetype="application/json")

@app.route("/api", methods=["GET", "POST", "OPTIONS"])
def api():
    if request.method == "OPTIONS":
        return ("", 204)

    action = (request.args.get("action") or "").strip().lower()
    site = normalize_site(request.args.get("site"))
    paths = site_paths(site)

    # ── 登入：只驗工號（不驗密碼）──
    if action == "auth":
        body = request.get_json(silent=True) or {}
        account = (body.get("account") or "").strip()
        if not account:
            return jsonify(success=False, error="missing_account",
                           message="請輸入工號"), 400
        user = find_user(account)
        if not user:
            audit("登入失敗", f"工號={account} 原因=查無此工號",
                  level="WARNING", operator=account)
            return jsonify(success=False, error="invalid",
                           message="查無此工號"), 401
        role = (user.get("role", "ENG") or "ENG").upper()
        if role not in ("ADMIN", "LEADER", "ENG"):
            role = "ENG"
        name = user.get("name") or user.get("account") or account
        audit("登入成功", f"工號={user.get('account', account)} 姓名={name} 角色={role}",
              operator=user.get("account", account))
        return jsonify(success=True,
                       account=user.get("account", account),
                       name=name, role=role, token=now_stamp())

    # ════════════════════════════════════════════════════
    #  值班名單 roster：每站台獨立檔 data/<site>/roster.json
    #  與 users.json（登入帳號）分開維護；新增時做工號唯一性檢查
    # ════════════════════════════════════════════════════

    # ── 讀取該站台值班名單 ──
    if action == "roster_load":
        rp = os.path.join(paths["dir"], "roster.json")
        if not os.path.exists(rp):
            return jsonify(success=True, site=site, people=[])
        try:
            data = json.loads(read_text(rp))
            return jsonify(success=True, site=site,
                           people=data.get("people", []))
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500

    # ── 值班納編新增人員：body {person:{id,name,shift,group,...}} ──
    #    規則：工號若已存在 users.json → 409 不允許新增；
    #          不存在 → 同時寫入 該站 roster.json ＋ users.json(ENG)
    if action == "roster_add":
        body = request.get_json(silent=True) or {}
        person = body.get("person") or {}
        pid = str(person.get("id", "")).strip()
        name = str(person.get("name", "")).strip() or pid
        if not pid:
            return jsonify(success=False, error="請輸入工號"), 400

        # 1) 工號唯一性：users.json 已存在 → 拒絕
        udata = load_users()
        if any(u.get("account", "").strip().lower() == pid.lower()
               for u in udata["users"]):
            audit("值班納編拒絕", f"工號={pid} 原因=已存在 users.json", level="WARNING")
            return jsonify(success=False, error="duplicate_account",
                           message="工號已存在 users.json，不允許新增：" + pid), 409

        # 2) 該站 roster 內也不可重複（保險）
        rp = os.path.join(paths["dir"], "roster.json")
        try:
            roster = json.loads(read_text(rp)) if os.path.exists(rp) \
                     else {"site": site, "people": []}
        except Exception:
            roster = {"site": site, "people": []}
        if any(str(p.get("id", "")).strip().lower() == pid.lower()
               for p in roster.get("people", [])):
            return jsonify(success=False, error="duplicate_roster",
                           message="工號已存在本站值班名單：" + pid), 409

        # 3) 雙寫入：roster.json + users.json
        entry = {
            "id": pid, "name": name,
            "shift": str(person.get("shift", "4A")),
            "group": str(person.get("group", "")),
            "title": str(person.get("title", "工程師")),
            "seniority": person.get("seniority", 0),
            "note": str(person.get("note", "")),
            "factory": site,
            "hiredate": str(person.get("hiredate", "")),
            "isMaintenance": bool(person.get("isMaintenance", False)),
            "inactiveFromYm": "",
        }
        roster.setdefault("people", []).append(entry)
        udata["users"].append({"account": pid, "name": name,
                               "role": "ENG", "password": ""})
        try:
            write_text(rp, json.dumps(roster, ensure_ascii=False, indent=2))
            save_users(udata)
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500
        audit("值班納編", f"新增 {pid}({name}) 班別={entry['shift']}/{entry['group']} "
                        f"職稱={entry['title']}；users.json 已建立 ENG 帳號")
        return jsonify(success=True, person=entry)

    # ── 覆寫該站值班名單（編輯姓名/班別/移除標記後同步）──
    #    body {people:[...]}；不動 users.json
    if action == "roster_save":
        body = request.get_json(silent=True) or {}
        people = body.get("people")
        if not isinstance(people, list):
            return jsonify(success=False, error="people must be a list"), 400
        rp = os.path.join(paths["dir"], "roster.json")
        old_people = []
        if os.path.exists(rp):
            try:
                old_people = (json.loads(read_text(rp)) or {}).get("people", [])
            except Exception:
                old_people = []
        try:
            write_text(rp, json.dumps({"site": site, "people": people},
                                      ensure_ascii=False, indent=2))
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500
        # 名冊差異：新增 / 移除 / 改名 / 移除標記
        oldmap = {str(p.get("id")): p for p in old_people}
        newmap = {str(p.get("id")): p for p in people}
        rd = []
        for pid in sorted(set(newmap) - set(oldmap)):
            rd.append(f"新增 {pid}({newmap[pid].get('name','')})")
        for pid in sorted(set(oldmap) - set(newmap)):
            rd.append(f"移出名冊 {pid}({oldmap[pid].get('name','')})")
        for pid in sorted(set(oldmap) & set(newmap)):
            o, n = oldmap[pid], newmap[pid]
            if o.get("name") != n.get("name"):
                rd.append(f"{pid} 改名 {o.get('name')}→{n.get('name')}")
            if (o.get("shift"), o.get("group")) != (n.get("shift"), n.get("group")):
                rd.append(f"{pid} 班別 {o.get('shift')}/{o.get('group')}→{n.get('shift')}/{n.get('group')}")
            if o.get("inactiveFromYm") != n.get("inactiveFromYm"):
                rd.append(f"{pid} 移除生效月 {o.get('inactiveFromYm') or '無'}→{n.get('inactiveFromYm') or '無'}")
        if rd:
            audit("名冊更新", "；".join(rd))
        return jsonify(success=True, count=len(people))

    # ── 讀取帳號清單（給「帳號權限管理」用，不含密碼）──
    if action == "users_load":
        users = [{"account": u.get("account", ""),
                  "name": u.get("name", ""),
                  "role": (u.get("role", "ENG") or "ENG").upper()}
                 for u in load_users()["users"]]
        return jsonify(success=True, users=users)

    # ── 新增帳號：body {account, name, role, password?} ──
    if action == "users_add":
        body = request.get_json(silent=True) or {}
        account = (body.get("account") or "").strip()
        name = (body.get("name") or "").strip() or account
        role = (body.get("role") or "ENG").strip().upper()
        if role not in ("ADMIN", "LEADER", "ENG"):
            role = "ENG"
        password = body.get("password") or ""
        if not account:
            return jsonify(success=False, error="請輸入工號"), 400
        data = load_users()
        if any(u.get("account", "").strip().lower() == account.lower()
               for u in data["users"]):
            return jsonify(success=False, error="工號已存在：" + account), 409
        data["users"].append({"account": account, "name": name,
                              "role": role, "password": password})
        try:
            save_users(data)
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500
        audit("帳號新增", f"工號={account} 姓名={name} 角色={role}")
        return jsonify(success=True, account=account)

    # ── 刪除帳號：body {account}（保護：不可刪掉最後一個 ADMIN）──
    if action == "users_delete":
        body = request.get_json(silent=True) or {}
        account = (body.get("account") or "").strip().lower()
        if not account:
            return jsonify(success=False, error="缺少工號"), 400
        data = load_users()
        target = next((u for u in data["users"]
                       if u.get("account", "").strip().lower() == account), None)
        if not target:
            return jsonify(success=False, error="找不到工號"), 404
        admin_total = sum(1 for u in data["users"]
                          if (u.get("role", "") or "").upper() == "ADMIN")
        if (target.get("role", "").upper() == "ADMIN") and admin_total <= 1:
            audit("帳號刪除拒絕", f"工號={account} 原因=最後一個 ADMIN", level="WARNING")
            return jsonify(success=False,
                           error="不可刪除最後一個 ADMIN"), 409
        data["users"] = [u for u in data["users"]
                         if u.get("account", "").strip().lower() != account]
        try:
            save_users(data)
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500
        audit("帳號刪除", f"工號={account} 姓名={target.get('name','')} 角色={target.get('role','')}")
        return jsonify(success=True)

    # ── 批次更新姓名與角色：body {users:[{account,name,role}]}（保留密碼）──
    #    保護：更新後不可使 ADMIN 數量降到 0（不可降掉最後一個 ADMIN）
    if action == "users_update":
        body = request.get_json(silent=True) or {}
        rows = body.get("users") or []
        if not isinstance(rows, list):
            return jsonify(success=False, error="users must be a list"), 400
        wanted = {}
        for it in rows:
            acc = str(it.get("account", "")).strip().lower()
            if acc:
                role = str(it.get("role", "ENG")).strip().upper()
                wanted[acc] = {
                    "name": str(it.get("name", "")).strip(),
                    "role": role if role in ("ADMIN", "LEADER", "ENG") else "ENG",
                }
        data = load_users()
        # 先模擬套用後的 ADMIN 數量
        admin_before = sum(1 for u in data["users"]
                           if (u.get("role", "") or "").upper() == "ADMIN")
        admin_after = 0
        for u in data["users"]:
            acc = u.get("account", "").strip().lower()
            final_role = wanted[acc]["role"] if acc in wanted else (u.get("role", "") or "").upper()
            if final_role == "ADMIN":
                admin_after += 1
        if admin_before >= 1 and admin_after == 0:
            audit("帳號更新拒絕", "原因=不可降級最後一個 ADMIN", level="WARNING")
            return jsonify(success=False,
                           error="不可降級最後一個 ADMIN"), 409
        updated = 0
        change_log = []
        for u in data["users"]:
            acc = u.get("account", "").strip().lower()
            if acc in wanted:
                w = wanted[acc]
                changed = False
                if w["name"] and u.get("name") != w["name"]:
                    change_log.append(f"{u.get('account')} 改名 {u.get('name')}→{w['name']}")
                    u["name"] = w["name"]; changed = True
                if u.get("role") != w["role"]:
                    change_log.append(f"{u.get('account')} 角色 {u.get('role')}→{w['role']}")
                    u["role"] = w["role"]; changed = True
                if changed:
                    updated += 1
        try:
            save_users(data)
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500
        if change_log:
            audit("帳號更新", "；".join(change_log))
        return jsonify(success=True, updated=updated)

    # ── 讀取舊版資料 alldata.json（相容用）──
    if action == "load":
        if site != "A3":
            return raw_json(
                '{"engineers":null,'
                '"scheduleData":null,'
                '"config":null,'
                '"legacyDisabled":true}'
            )

        txt = read_text(paths["all"])
        if txt:
            return raw_json(txt)

        return raw_json('{"engineers":null,"scheduleData":null,"config":null}')

    # ── 讀取月份班表檔：data/<site>/<site>_schedule_<YYYYMM>.json ──
    #    回傳 { success, site, months:{ "202606":{...}, ... }, meta:{...} }
    if action == "load_schedule":
        months = {}
        prefix = site + "_schedule_"
        if os.path.isdir(paths["dir"]):
            for fn in sorted(os.listdir(paths["dir"])):
                if fn.startswith(prefix) and fn.lower().endswith(".json"):
                    ym = fn[len(prefix):-5]   # 取出 YYYYMM
                    try:
                        months[ym] = json.loads(
                            read_text(os.path.join(paths["dir"], fn)))
                    except Exception:
                        pass
        meta = {}
        mp = os.path.join(paths["dir"], "meta.json")
        if os.path.exists(mp):
            try:
                meta = json.loads(read_text(mp))
            except Exception:
                meta = {}
        return jsonify(success=True, site=site, months=months, meta=meta)

    # ── 寫入月份班表檔（顯示與寫入同一份檔）──
    #    body: { site, months:{ "202606":{site,year,month,ym,shifts}, ... }, meta:{...} }
    #    逐月寫出 <site>_schedule_<YYYYMM>.json，並寫 meta.json（設定/最後修改）
    if action == "save_schedule":
        body = request.get_json(silent=True) or {}
        months = body.get("months") or {}
        meta = body.get("meta")
        changes, new_months = diff_schedule_changes(paths, site, months)
        written = []
        try:
            for ym, content in months.items():
                if not (isinstance(ym, str) and len(ym) == 6 and ym.isdigit()):
                    continue
                fp = os.path.join(paths["dir"], f"{site}_schedule_{ym}.json")
                write_text(fp, json.dumps(content, ensure_ascii=False, indent=2))
                written.append(ym)
            if meta is not None:
                write_text(os.path.join(paths["dir"], "meta.json"),
                           json.dumps(meta, ensure_ascii=False, indent=2))
            if new_months:
                audit("排班存檔", "新建月份 " + "、".join(new_months))
            if changes:
                shown = changes[:30]
                more = len(changes) - len(shown)
                audit("排班修改", "；".join(shown) + (f"；…等共 {len(changes)} 格" if more > 0 else ""))
            return jsonify(success=True, savedAt=now_iso(), written=sorted(written))
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500


    # ── 寫入舊版資料 alldata.json（相容用）──
    # 正式存檔請使用 save_schedule。
    # 為避免 KL / NK 產生舊版 alldata.json，只允許 A3 相容寫入。
    if action == "save":
        if site != "A3":
            return jsonify(
                success=False,
                error="legacy_save_disabled_for_site",
                message="KL / NK 不允許寫入舊版 alldata.json，請使用 save_schedule"
            ), 403

        body = request.get_data(as_text=True) or ""

        try:
            write_text(paths["all"], body)
            return jsonify(success=True, savedAt=now_iso())
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500

    # ── 建立備份（打包該站所有月份檔 + meta 成單一備份檔）──
    if action == "backup":
        prefix = site + "_schedule_"
        months = {}
        if os.path.isdir(paths["dir"]):
            for fn in sorted(os.listdir(paths["dir"])):
                if fn.startswith(prefix) and fn.lower().endswith(".json"):
                    ym = fn[len(prefix):-5]
                    try:
                        months[ym] = json.loads(
                            read_text(os.path.join(paths["dir"], fn)))
                    except Exception:
                        pass
        if not months:
            return jsonify(success=False, error="No schedule files to backup")
        meta = {}
        mp = os.path.join(paths["dir"], "meta.json")
        if os.path.exists(mp):
            try:
                meta = json.loads(read_text(mp))
            except Exception:
                meta = {}
        stamp = now_stamp()
        dst = os.path.join(paths["backups"], f"backup_{stamp}.json")
        write_text(dst, json.dumps({"site": site, "months": months,
                                    "meta": meta, "backupAt": now_iso()},
                                   ensure_ascii=False, indent=2))
        audit("建立備份", f"檔名=backup_{stamp}.json 月份數={len(months)}")
        return jsonify(success=True, file=f"backup_{stamp}.json")

    # ── 列出備份 ──
    if action == "backups":
        items = []
        if os.path.isdir(paths["backups"]):
            for fn in os.listdir(paths["backups"]):
                if fn.lower().endswith(".json"):
                    fp = os.path.join(paths["backups"], fn)
                    st = os.stat(fp)
                    items.append({
                        "name": fn, "size": st.st_size,
                        "date": datetime.fromtimestamp(st.st_mtime)
                                        .strftime("%Y-%m-%d %H:%M:%S"),
                    })
        return jsonify(success=True, backups=items)

    # ── 伺服器狀態 ──
    if action == "status":
        return jsonify(success=True, status="online",
                       hasData=os.path.exists(paths["all"]),
                       serverTime=now_iso(), version=VERSION)

    # ── 工號權限綁定（全廠共用）：讀 ──
    if action == "rb_load":
        txt = read_text(RB_FILE)
        return raw_json('{"success":true,"roleBindings":' +
                        (txt if txt else "{}") + "}")

    # ── 工號權限綁定（全廠共用）：寫 ──
    if action == "rb_save":
        body = request.get_data(as_text=True) or "{}"
        try:
            write_text(RB_FILE, body)
            audit("權限綁定更新", f"內容長度={len(body)}字元")
            return jsonify(success=True, savedAt=now_iso())
        except Exception as e:
            return jsonify(success=False, error=str(e)), 500

    # ── 鎖：檢查 ──
    if action == "lock_check":
        lock = read_lock(paths)
        active, hname, _ = lock_is_active(lock)
        if active:
            return jsonify(success=True, locked=True, holder=hname,
                           acquiredAt=lock.get("acquiredAt", ""),
                           lastBeat=lock.get("lastBeat", ""))
        return jsonify(success=True, locked=False)

    # ── 鎖：取得 ──
    if action == "lock_acquire":
        body = request.get_json(silent=True) or {}
        token = (body.get("token") or "").strip()
        name = (body.get("name") or "").strip()
        role = (body.get("role") or "").strip()
        if not token or not name:
            return jsonify(success=False, error="token / name required")
        lock = read_lock(paths)
        active, hname, htoken = lock_is_active(lock)
        # 被別人鎖住才擋；若持鎖者是同一人(姓名相同)，視為重新登入 → 允許拿回自己的鎖
        if active and htoken != token and hname != name:
            audit("編輯權被擋", f"申請者={name}({role}) 持有者={hname}", level="WARNING")
            return jsonify(success=False, locked=True, holder=hname,
                           acquiredAt=lock.get("acquiredAt", ""))
        cur = now_iso()
        if active and (htoken == token or hname == name):
            acq = lock.get("acquiredAt") or cur   # 同一人重登：保留原取得時間
        else:
            acq = cur
        write_lock(paths, token, name, role, acq, cur)
        audit("取得編輯權", f"持有者={name}({role})")
        return jsonify(success=True, locked=False, token=token,
                       holder=name, acquiredAt=acq)

    # ── 鎖：強制接管（ADMIN 專用，前端限定）→ 無視現有持鎖者直接改寫 ──
    if action == "lock_force_acquire":
        body = request.get_json(silent=True) or {}
        token = (body.get("token") or "").strip()
        name = (body.get("name") or "").strip()
        role = (body.get("role") or "").strip()
        if not token or not name:
            return jsonify(success=False, error="token / name required")
        lock = read_lock(paths)
        active, hname, htoken = lock_is_active(lock)
        prev_holder = hname if (active and htoken != token) else ""
        cur = now_iso()
        write_lock(paths, token, name, role, cur, cur)
        audit("強制接管編輯權",
              f"接管者={name}({role})" + (f" 原持有者={prev_holder}" if prev_holder else ""),
              level="WARNING")
        return jsonify(success=True, locked=False, token=token,
                       holder=name, acquiredAt=cur, takenFrom=prev_holder)
    if action == "lock_heartbeat":
        body = request.get_json(silent=True) or {}
        token = (body.get("token") or "").strip()
        if not token:
            return jsonify(success=False, error="token required")
        lock = read_lock(paths)
        active, _, htoken = lock_is_active(lock)
        if active and htoken == token:
            acq = lock.get("acquiredAt") or now_iso()
            write_lock(paths, token, lock.get("name", ""),
                       lock.get("role", ""), acq, now_iso())
            return jsonify(success=True, kept=True)
        return jsonify(success=False, kept=False, error="lock_lost")

    # ── 鎖：釋放 ──
    if action == "lock_release":
        body = request.get_json(silent=True) or {}
        token = (body.get("token") or "").strip()
        lock = read_lock(paths)
        active, _, htoken = lock_is_active(lock)
        if active and htoken == token and os.path.exists(paths["lock"]):
            os.remove(paths["lock"])
            audit("釋放編輯權", f"持有者={lock.get('name','')}")
        return jsonify(success=True, released=True)

    # ── 未知動作 ──
    return jsonify(success=False, error="Unknown action"), 400

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify(success=True, status="online",
                   users=len(load_users()["users"]), version=VERSION)



# ════════════════════════════════════════════════════════════
#  進入點
# ════════════════════════════════════════════════════════════
if __name__ == "__main__":
    logger.info(f"[系統啟動] 排班系統後端 v{VERSION} 啟動於 0.0.0.0:5000；"
                f"審計日誌目錄={LOG_DIR}（每日輪替、保留 90 天）")
    app.run(host="0.0.0.0", port=5000, debug=False)