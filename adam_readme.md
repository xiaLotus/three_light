# 上拋觸發流程

## 1. 首次啟動（無歷史紀錄）

程式啟動 → load_last_state() 回傳 None
  └─ 強制上拋 ALARM
       ├─ post_state()             → TV 看板
       ├─ post_dashboard_alarm()   → Dashboard（僅送新狀態開始，跳過舊狀態結束）
       ├─ write_log()              → 設備 log 檔
       └─ save_last_state()        → 寫入 state/{MachineID}.json

---

## 2. 重開程式 / 斷線重連（有歷史紀錄）

### 2a. 狀態未變（檔案紀錄 == 當下設備狀態）

程式啟動 → load_last_state() = "BUSY"
  └─ 讀到設備狀態 = "BUSY"
       └─ state == last_state → 不上拋 ✅

### 2b. 狀態已變（檔案紀錄 != 當下設備狀態）

程式啟動 → load_last_state() = "BUSY"
  └─ 讀到設備狀態 = "ALARM"
       └─ state != last_state → 觸發上拋
            ├─ post_state()             → TV 看板
            ├─ post_dashboard_alarm()   → Dashboard（is_startup=True，跳過舊狀態結束，只送新狀態開始）
            ├─ write_log()              → 設備 log 檔
            ├─ save_last_state()        → 更新 state/{MachineID}.json
            └─ is_startup = False       → 後續恢復正常雙送邏輯

---

## 3. 正常運行中狀態切換

設備狀態由 BUSY → ALARM（或 ALARM → BUSY）
  └─ state != last_state → 觸發上拋
       ├─ post_state()             → TV 看板
       ├─ post_dashboard_alarm()   → Dashboard
       │    ├─ 1️⃣ 舊狀態結束（反轉 Flag）
       │    └─ 2️⃣ 新狀態開始（原始 Flag）
       ├─ write_log()              → 設備 log 檔
       └─ save_last_state()        → 更新 state/{MachineID}.json

---

## 4. 定時派報（每天 07:30 / 19:30）

時間符合 + 該分鐘尚未派報
  └─ 強制上拋當下真實狀態
       └─ post_state() → TV 看板（僅此一項，不觸發 Dashboard）

---

## 不觸發上拋的情境

| 情境 | 原因 |
|---|---|
| 重開程式，狀態未變 | state == last_state |
| 斷線重連，狀態未變 | state == last_state |
| 每秒輪詢，狀態未變 | state == last_state |
| 定時派報 | 只送 TV，不送 Dashboard |