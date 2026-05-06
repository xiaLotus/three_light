## 🎨 視覺參數修改指南（index.html）

### 1. 左側標籤文字大小
位置：`v-for station` 區塊內的標籤 div
```html
style="... font-size:12px; ..."
```
> 修改 `12px` → 想要的大小

---

### 2. 時間軸刻度文字大小
位置：x 軸 `<span>` 的 `:style` 物件內
```js
fontSize:'10px',
```
> 修改 `10px` → 想要的大小

---

### 3. 每條列高（需同時改 2 處）
位置：同一個 `v-for station` 區塊，row div 與 bar div

```html
<!-- 第 1 處：外層 row -->
style="display:flex; align-items:center; height:100px;"

<!-- 第 2 處：內層 bar 區域 -->
style="flex:1; min-width:0; height:100px; position:relative; ..."
```
> 兩個 `100px` 必須改成相同數值

---

### 🔍 快速搜尋關鍵字（Ctrl+F）

| 想改的項目 | 搜尋關鍵字 |
|---|---|
| 左側標籤字大小 | `font-size:12px` |
| 時間刻度字大小 | `fontSize:'10px'` |
| 列高 | `height:100px`（共 2 處） |

> ⚠️ `app.js` 不需要修改，以上全部在 `index.html`