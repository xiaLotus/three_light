// 與 index.html / app.js 同一個後端入口
const API_URL = "http://127.0.0.1:5000/api";

const $ = (id) => document.getElementById(id);
const btn = $("login-btn");

function showErr(msg) {
  $("err-text").textContent = msg;
  $("err").style.display = "block";
}
function clearErr() {
  $("err").style.display = "none";
}

async function doLogin() {
  clearErr();
  const account = $("account").value.trim();
  const password = $("password").value;
  const engOnly = $("eng-only").checked;
  if (!account || !password) {
    showErr("請輸入工號與密碼");
    return;
  }

  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 驗證中…';

  try {
    const r = await fetch(API_URL + "?action=auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, password }),
    });
    const d = await r.json();

    // 只有後端回傳 success:true 才放行進入 index.html
    if (r.ok && d && d.success) {
      const role =
        d.role === "ADMIN" ? "ADMIN" : d.role === "LEADER" ? "LEADER" : "ENG";
      // 勾「以唯讀(ENG)登入」→ 一律 ENG；否則用真實角色（ADMIN/LEADER/ENG）
      const intended = engOnly ? "ENG" : role;

      sessionStorage.setItem("dsm_site", "A3");
      sessionStorage.setItem(
        "dsm_login",
        JSON.stringify({
          account: d.account || account,
          name: d.name || account,
          role: role,
          intended: intended,
          loginAt: new Date().toISOString(),
        }),
      );
      location.href = "index.html";
    } else {
      showErr(d && d.message ? d.message : "工號或密碼錯誤");
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  } catch (e) {
    showErr("無法連線到伺服器，請確認後端已啟動（" + API_URL + "）");
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

btn.addEventListener("click", doLogin);
$("password").addEventListener("keypress", (e) => {
  if (e.key === "Enter") doLogin();
});
$("account").addEventListener("keypress", (e) => {
  if (e.key === "Enter") $("password").focus();
});

// 進入登入頁時清除舊的登入工作階段 → 可無條件重新登入（換人/重登）
try {
  sessionStorage.removeItem("dsm_login");
} catch (e) {}
