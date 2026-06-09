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
    auth            登入（POST，需 工號+密碼）→ 後端比對成功才回傳 True + 角色/姓名
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
#  users.json（帳號 / 角色，無密碼）
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

        # ── 登入：比對工號+密碼，成功才回傳角色 ──
        if action == "auth":
            body = request.get_json(silent=True) or {}
            account = (body.get("account") or "").strip()
            password = body.get("password") or ""
            if not account or not password:
                return jsonify(success=False, error="missing_fields",
                               message="請輸入工號與密碼"), 400
            user = find_user(account)
            if not user:
                return jsonify(success=False, error="invalid",
                               message="工號或密碼錯誤"), 401
            # 驗證密碼：優先用 password_hash（雜湊），否則比對明文 password
            ok = False
            if user.get("password_hash"):
                try:
                    from werkzeug.security import check_password_hash
                    ok = check_password_hash(user["password_hash"], password)
                except Exception:
                    ok = False
            else:
                ok = (str(user.get("password", "")) == str(password))
            if not ok:
                return jsonify(success=False, error="invalid",
                               message="工號或密碼錯誤"), 401
            role = (user.get("role", "ENG") or "ENG").upper()
            if role not in ("LEADER", "ENG"):
                role = "ENG"
            name = user.get("name") or user.get("account") or account
            return jsonify(success=True,
                           account=user.get("account", account),
                           name=name, role=role, token=now_stamp())

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
            if active and htoken != token:
                return jsonify(success=False, locked=True, holder=hname,
                               acquiredAt=lock.get("acquiredAt", ""))
            cur = now_iso()
            if active and htoken == token:
                acq = lock.get("acquiredAt") or cur
            else:
                acq = cur
            write_lock(paths, token, name, role, acq, cur)
            return jsonify(success=True, locked=False, token=token,
                           holder=name, acquiredAt=acq)

        # ── 鎖：心跳 ──
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