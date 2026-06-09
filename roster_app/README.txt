═══════════════════════════════════════════════════════════════
  排班系統 — 安裝與使用說明  (月份班表檔：讀寫同源)
═══════════════════════════════════════════════════════════════

【架構重點】
  ● 登入獨立成 login.html：輸入「工號＋密碼」→ 後端 app.py 比對成功(回傳 True+身分)後，才導向 index.html
  ● 密碼存於後端 users.json（後台可見、可管理）；前端不做密碼判斷
  ● index.html 有守門：未登入（無登入工作階段）會自動導回 login.html
  ● 角色由 users.json 的 role 決定（LEADER 可編輯 / ENG 唯讀）
  ● 後端 app.py(Flask) 取代 ASP，處理所有讀寫
  ● 班表資料以「每站台、每月一檔」存放，顯示與寫入都對著同一份：
        data/<站台>/<站台>_schedule_<YYYYMM>.json
    例：data/A3/A3_schedule_202606.json
  ● 前端打：http://127.0.0.1:5000/api?action=...

【檔案結構】
  login.html                          登入頁（工號＋密碼）★入口從這裡開始★
  index.html / styles.css / app.js    主系統（需登入後才進得來）
  app.py                              後端（Flask 伺服器）
  users.json                          登入帳號（account/password/role/name）
  requirements.txt                    Flask、Flask-Cors
  data/
    A3/  A3_schedule_2026xx.json（A3 已有資料）、meta.json、backups/
    KL/  (空白；在 KL 編輯存檔後自動產生 KL_schedule_YYYYMM.json)
    NK/  (南科，空白；同上)

【登入流程】
  1. 開 login.html → 輸入工號 + 密碼（可勾「以唯讀ENG登入」不佔 Leader 鎖）
  2. 送到後端 auth 比對；成功才回傳 True + 角色/姓名
  3. 前端存登入工作階段 → 導向 index.html
  4. index.html 載入時若無登入工作階段 → 自動導回 login.html
  5. 登出 → 釋放 Leader 鎖、清除工作階段、導回 login.html
  （工作階段存於該分頁 sessionStorage，關閉分頁即失效，需重新登入）

  範例帳號（工號 / 密碼 / 角色）：
    ADM-001 / admin123  / LEADER（系統管理員）
    F5678   / leader123 / LEADER（李組長）
    F1234   / eng123    / ENG  （王小明）

【管理帳號（工號 / 密碼 / 角色 / 顯示姓名）→ 直接編輯 users.json】
  範例：
    {
      "users": [
        {"account": "ADM-001", "name": "系統管理員", "role": "LEADER", "password": "admin123"},
        {"account": "F1234",   "name": "王小明",     "role": "ENG",    "password": "eng123"}
      ]
    }
  ● role 只能是 LEADER 或 ENG
  ● password 為明文，後台(此檔)可直接檢視與修改
  ● 改完存檔後重新啟動 app.py 即生效
  ● 若要加密：把該帳號改放 password_hash 欄位（取代 password），
    後端會優先以雜湊驗證（可用 werkzeug.security.generate_password_hash 產生）

【安裝】
  pip install -r requirements.txt

【啟動】
  python app.py        # 直接執行 app.run() 啟動 (0.0.0.0:5000)
                       # 瀏覽器開 login.html 開始登入

【資料流：顯示與寫入同一份月份檔】
  讀取：前端 → load_schedule → 讀 data/<站台>/<站台>_schedule_YYYYMM.json
        (+ meta.json 取設定/最後修改) → 組成畫面
  寫入：畫面任何修改 → 1.5 秒後自動存檔 → save_schedule
        → 依月份寫回各 <站台>_schedule_YYYYMM.json + meta.json
  ⇒ 你在畫面上看到的，就是寫回檔案的內容；重整後仍是同一份。

  載入優先序：月份班表檔 → (後備)舊版 alldata.json → localStorage 快取 → 預設
  ● A3：首次無檔時用「內建範本(64 人)」顯示
  ● KL / NK：首次為「空白名單」，需以 Leader 至「人員管理」新增各廠自己的人；
             一旦在該站編輯存檔，就會自動建立其月份檔。

【後端 action 一覽】
  auth load_schedule save_schedule backup backups status
  rb_load rb_save lock_check lock_acquire lock_heartbeat lock_release
  (load / save 為相容舊 alldata.json 保留，平常不會用到)
  站台 ?site=A3|KL|NK（預設 A3）。

【月份檔格式】
  {
    "site":"A3","year":2026,"month":6,"ym":"202606",
    "shifts":{
      "4A":[ {id,name,shift,group,title,seniority,note,isMaintenance,
              days:{ "01":{date,type,typeLabel,loc,leave,ot}, ... }}, ... ],
      "4B":[...], "5A":[...], "5B":[...]
    }
  }
  type: ON出勤 / REST休息 / HOLIDAY例假 / LEAVE加班日
  loc 工作地點、leave 是否請假(0/1)、ot 加班OT(0/1)

【前端後端不同機時】
  改 app.js / login.html 最上方：const API_URL = 'http://<伺服器IP>:5000/api';

【離線單機測試】
  app.js 把 PREVIEW_MODE 設 true → 不連後端，資料存瀏覽器 localStorage。
  （注意：登入仍需後端比對；離線模式主要用於資料層測試。）

【正式部署】
  pip install waitress
  waitress-serve --host=0.0.0.0 --port=5000 app:create_app
═══════════════════════════════════════════════════════════════