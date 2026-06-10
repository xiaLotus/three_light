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
    role 只能是 LEADER 或 ENG；password 為明文（後台可見可改）。
    若要加密，改放 password_hash 欄位，後端會優先以雜湊驗證。

安裝套件：
    pip install -r requirements.txt        (Flask, Flask-Cors)
"""
import os
import json
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(HERE, "users.json")
DATA_DIR = os.path.join(HERE, "data")
RB_FILE = os.path.join(DATA_DIR, "rolebindings.json")  # 工號權限綁定：全廠共用

LOCK_TIMEOUT_SEC = 90          # Leader 鎖逾時（無心跳視為失效）
VERSION = "4.0.0"


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
#  Flask 伺服器
# ════════════════════════════════════════════════════════════
def create_app():
    from flask import Flask, request, jsonify, Response
    from flask_cors import CORS

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

        # ── 登入：只認工號（忽略密碼驗證），並把收到的工號+密碼印到後端 console ──
        if action == "auth":
            body = request.get_json(silent=True) or {}
            account = (body.get("account") or "").strip()
            password = body.get("password") or ""
            # 印出到執行 app.py 的終端機（含密碼，僅內部後台可見）
            print(f"[登入] 工號(account)={account!r}  密碼(password)={password!r}",
                  flush=True)
            if not account:
                return jsonify(success=False, error="missing_account",
                               message="請輸入工號"), 400
            user = find_user(account)
            if not user:
                return jsonify(success=False, error="invalid",
                               message="查無此工號"), 401
            role = (user.get("role", "ENG") or "ENG").upper()
            if role not in ("ADMIN", "LEADER", "ENG"):
                role = "ENG"
            name = user.get("name") or user.get("account") or account
            return jsonify(success=True,
                           account=user.get("account", account),
                           name=name, role=role, token=now_stamp())

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
                return jsonify(success=False,
                               error="不可刪除最後一個 ADMIN"), 409
            data["users"] = [u for u in data["users"]
                             if u.get("account", "").strip().lower() != account]
            try:
                save_users(data)
            except Exception as e:
                return jsonify(success=False, error=str(e)), 500
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
                return jsonify(success=False,
                               error="不可降級最後一個 ADMIN"), 409
            updated = 0
            for u in data["users"]:
                acc = u.get("account", "").strip().lower()
                if acc in wanted:
                    w = wanted[acc]
                    changed = False
                    if w["name"] and u.get("name") != w["name"]:
                        u["name"] = w["name"]; changed = True
                    if u.get("role") != w["role"]:
                        u["role"] = w["role"]; changed = True
                    if changed:
                        updated += 1
            try:
                save_users(data)
            except Exception as e:
                return jsonify(success=False, error=str(e)), 500
            return jsonify(success=True, updated=updated)

        # ── 讀取資料 ──
        if action == "load":
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
                return jsonify(success=True, savedAt=now_iso(), written=sorted(written))
            except Exception as e:
                return jsonify(success=False, error=str(e)), 500


        # ── 寫入資料 ──
        if action == "save":
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
                return jsonify(success=False, locked=True, holder=hname,
                               acquiredAt=lock.get("acquiredAt", ""))
            cur = now_iso()
            if active and (htoken == token or hname == name):
                acq = lock.get("acquiredAt") or cur   # 同一人重登：保留原取得時間
            else:
                acq = cur
            write_lock(paths, token, name, role, acq, cur)
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
            return jsonify(success=True, released=True)

        # ── 未知動作 ──
        return jsonify(success=False, error="Unknown action"), 400

    @app.route("/api/health", methods=["GET"])
    def health():
        return jsonify(success=True, status="online",
                       users=len(load_users()["users"]), version=VERSION)

    return app


# ════════════════════════════════════════════════════════════
#  進入點
# ════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)