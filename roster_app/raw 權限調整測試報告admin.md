# 權限調整測試報告 — 新增 ADMIN 角色（三級權限）

日期：2026-06-10
範圍：營運組值班排班管理系統 — 角色由「LEADER / ENG」兩級擴充為「**ADMIN / LEADER / ENG**」三級

---

## 一、需求與最終權限定義

| 功能 | ADMIN | LEADER | ENG |
|---|:--:|:--:|:--:|
| 瀏覽（Dashboard／排班／行事曆／分析） | ✅ | ✅ | ✅ |
| 排班編輯（每日格子、重設、整批、存檔） | ✅ | ✅ | ❌ |
| 人員管理（排班名冊：新增／編輯／刪除人員） | ✅ | ✅ | ❌ |
| 系統設定、備份（匯出／匯入／重置） | ✅ | ✅ | ❌ |
| 帳號管理：**新增 ENG**、**刪除 ENG**、**改 ENG 姓名** | ✅ | ✅ | ❌ |
| 帳號管理：新增／刪除 LEADER、ADMIN | ✅ | ❌ | ❌ |
| 帳號管理：**調整任何人的角色**（含設為 LEADER／ADMIN） | ✅ | ❌ | ❌ |
| 改／刪自己 | ❌ | ❌ | ❌ |

重點規則：
- LEADER 喪失「把人設為 LEADER」「把人設為 ADMIN」的資格；帳號管理對 LEADER 只剩「新增 ENG／刪除 ENG／改 ENG 姓名」。
- 只有 ADMIN 能調整別人的角色（角色下拉只有 ADMIN 看得到、改得動）。
- ADMIN 具備 LEADER 全部功能。
- ADMIN 與 LEADER 在「編輯排班」時共用同一把「同廠同時一位編輯者」的鎖。
- 兩道保護：任何人不可改／刪自己；不可刪除或降級「最後一個 ADMIN」。

---

## 二、實作方式（雙角色概念）

- **真實角色 `myIntendedRole`（ADMIN／LEADER／ENG）**：來自 `users.json`，登入後固定、不受站台鎖影響。用於「帳號管理」的可見性與權限（`data-trole`）。
- **有效角色 `currentRole`**：考量該站台編輯鎖後的結果；若是編輯者（LEADER／ADMIN）但鎖被他人持有 → 該站降為 ENG 唯讀（`data-role`）。用於排班／人員／設定等「該站編輯」動作。
- 因此：ADMIN 即使在某廠因鎖被佔而暫為唯讀，**仍可進行帳號管理**（帳號管理屬全域、依真實角色）。

涉及檔案：`app.py`、`app.js`、`index.html`、`login.html`、`styles.css`。

---

## 三、後端 API 測試（實測結果）

測試資料：`ADM1/ADM2`(ADMIN)、`LDR1`(LEADER)、`ENG1`(ENG)

| # | 測試 | 結果 |
|---|---|:--:|
| 1 | `auth` 回傳角色：ADM1→ADMIN、LDR1→LEADER、ENG1→ENG | ✅ |
| 2 | `users_load` 正確回傳三種角色（不含密碼） | ✅ |
| 3 | `users_add` 新增 ADMIN 帳號成功 | ✅ |
| 4 | `users_update` 把 ENG1 升為 LEADER，檔案已寫入（密碼保留） | ✅ |
| 5 | 重複新增既有工號 → 409 擋下 | ✅ |
| 6 | **刪除最後一個 ADMIN → 409「不可刪除最後一個 ADMIN」** | ✅ |
| 7 | **把最後一個 ADMIN 降級 → 409「不可降級最後一個 ADMIN」** | ✅ |
| 8 | 先補一個 ADMIN，再降原 ADMIN → 200 成功 | ✅ |
| 9 | 刪除不存在工號 → 404 | ✅ |

---

## 四、自動化迴歸測試

沿用既有測試套件，並新增 ADMIN 認證案例。

- 主測試 `run_tests.js`：**41 / 41 PASS**
  （認證/角色 9〔含 ADMX→ADMIN〕、載入 5、新增 4、編輯 1、刪除 3、站台獨立 4、編輯鎖 7、權限綁定 2、備份 2、其他 4）
- 更改人員資訊 `edit_person_test.js`：**10 / 10 PASS**
- **合計 51 / 51 PASS**，無回歸。

---

## 五、前端三級權限靜態檢查（12 / 12 OK）

| # | 檢查項 | 結果 |
|---|---|:--:|
| 1 | 有效編輯角色含 ADMIN（`isLeader` = LEADER／ADMIN） | OK |
| 2 | 真實角色守門 `requireAdmin` / `requireAccountEditor` 存在 | OK |
| 3 | 新增帳號：非 ADMIN 一律強制 ENG | OK |
| 4 | 刪除：LEADER 只能刪 ENG | OK |
| 5 | 改角色：只有 ADMIN 才出現角色下拉（含 ADMIN 選項） | OK |
| 6 | `saveOneUser`：LEADER 僅能改 ENG 姓名且不可改角色 | OK |
| 7 | 最後一個 ADMIN 在前端顯示鎖定（不給刪除鈕） | OK |
| 8 | 不可改／刪自己（本人列鎖定） | OK |
| 9 | 「系統設定」選單改用真實角色顯示（`editor-only-hide`），帳號管理不被站台鎖隱藏 | OK |
| 10 | 帳號區 `editor-only-hide`、角色選單 `admin-only-hide` | OK |
| 11 | 排班／人員／備份仍受 `requireLeader`（編輯者＋持有鎖）控管 | OK |
| 12 | ADMIN 與 LEADER 共用站台編輯鎖 | OK |

---

## 六、各角色實際畫面行為摘要

**ENG**：只能瀏覽；看不到「人員管理」「系統設定」。

**LEADER**：
- 可編輯排班、人員名冊、系統設定、備份（需持有該站編輯鎖）。
- 可進入「系統設定 → 帳號權限管理」，但只看得到：新增帳號（固定 ENG，無角色選單）、ENG 列可改姓名、ENG 列可刪除。
- LEADER／ADMIN 的列：角色顯示為徽章（不可改）、不可刪除、姓名不可改。

**ADMIN**：
- LEADER 全部功能。
- 帳號權限管理完整：新增（可選 ENG／LEADER／ADMIN）、刪除任一（自己與最後一個 ADMIN 除外）、改任何人姓名、用下拉改任何人角色（ENG／LEADER／ADMIN）。

---

## 六之二、ADMIN 強制接管編輯權（新增）

問題：原本「同廠同時一位編輯者」的鎖不分階級，若 LEADER 正在編輯，ADMIN 進同一廠只會被降為唯讀、得等對方登出或鎖逾時。對最高權限的 ADMIN 不合理。

解法：給 **ADMIN 強制接管**。
- ADMIN 進入某廠、因鎖被他人佔而被降為唯讀時，儀表板「Leader 編輯權限」卡片會出現 **「強制接管」** 按鈕（只有被降權的 ADMIN 看得到）。
- 按下（跳確認）→ 後端 `lock_force_acquire` 無視現有持鎖者直接改寫成 ADMIN 的鎖；ADMIN 立即恢復可編輯。
- 原編輯者在下一次心跳（≤30 秒）收到鎖失效 → 自動降為 ENG 唯讀並提示。
- 規則：僅 **ADMIN** 能強制接管（`requireAdmin` 把關）；可從 LEADER 或其他 ADMIN 手上接管。LEADER 撞鎖仍只能等。

實測（A3）：

| 步驟 | 結果 |
|---|:--:|
| LEADER(tk1) 取得 A3 鎖 | ✅ holder=組長 |
| ADMIN(tk2) `lock_force_acquire` 接管 | ✅ holder=管理員，takenFrom=組長 |
| 原 LEADER(tk1) 心跳 → 失效（kept:false）→ 前端自動降 ENG | ✅ |
| ADMIN(tk2) 心跳 → 保持（kept:true） | ✅ |
| `lock_check` A3 持有者 = 管理員 | ✅ |
| KL 站不受影響（站台獨立） | ✅ |

副作用：被接管者最後一兩秒未存檔（自動存檔停手約 1.5 秒才寫）的變動可能遺失或互相覆蓋——接管本質即「蓋過對方」，無法完全消除，僅以通知與建議重新整理因應。

---

## 七、已知限制（誠實告知）

1. **權限以前端為主**：ENG／LEADER 的限制主要由前端控管（隱藏選單、`requireLeader`／`requireAdmin` 攔截）。後端帳號 API 未做登入身分驗證，理論上若有人繞過畫面直接打 API，仍可執行。唯獨「最後一個 ADMIN 不可刪／降」這道**結構性保護已在後端強制**。
2. 若日後要連「繞過畫面直接打 API」也擋住（真正的後端強制），需加「登入發 token、API 驗 token 並比對角色／本人」這層，屬較大改動。

---

## 八、交付檔案

- `app.py`、`app.js`、`index.html`、`login.html`、`styles.css`（覆蓋即可）
- `users.json` 角色欄位現支援 `ADMIN`／`LEADER`／`ENG`；要產生第一個 ADMIN，直接在 `users.json` 把某帳號的 `role` 設為 `ADMIN` 即可。