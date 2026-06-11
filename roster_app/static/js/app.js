/* ── Shared constants used by both login & persistence layers ── */
/* 🟢 PREVIEW_MODE 預設為 false（IIS 部署模式）。
   若要在沒有 IIS 的本機直接以瀏覽器開啟測試，
   請將 PREVIEW_MODE 改為 true，所有後端 API 呼叫會自動跳過，
   資料改用 localStorage，Leader 鎖視為單機模式（永遠允許登入）。 */
const PREVIEW_MODE = false;

/* 🔗 後端 API 統一入口（Flask, app.py）。
   - 所有動作都打同一支：http://127.0.0.1:5000/api?action=...
     auth(登入) / load / save / backup / status / rb_load / rb_save /
     lock_check / lock_acquire / lock_heartbeat / lock_release
   - 已移除 ASP；資料的上拋與寫入皆由後端 app.py 處理。
   - 若 Flask 跑在別台機器（多人連線），把 127.0.0.1 改成該主機 IP，
     例如 'http://192.168.1.50:5000/api'。 */
const API_URL = 'http://127.0.0.1:5000/api';

/* ── 審計日誌：所有打向後端的請求自動附上操作者工號（X-Operator）──
   後端 loguru 據此記錄「誰、何時、做了什麼、改了哪一格」。 */
(function(){
  const _fetch = window.fetch.bind(window);
  window.fetch = function(url, opt){
    try{
      if(typeof url === 'string' && url.indexOf(API_URL) === 0){
        const login = JSON.parse(sessionStorage.getItem('dsm_login') || 'null');
        if(login && login.account){
          opt = opt || {};
          opt.headers = Object.assign({}, opt.headers || {},
                                      {'X-Operator': String(login.account)});
        }
      }
    }catch(e){}
    return _fetch(url, opt);
  };
})();
/* 在 API 動作後附加站台參數，使每個站台讀寫各自的 data/<site>/ 資料夾 */
function siteQ(){ return '&site=' + currentSite; }

/* ════════════════════════════════════════════════════════
   🔐 LOGIN / PERMISSION SYSTEM
   - 兩種角色：LEADER（完整權限）／ENG（唯讀）
   - 已移除密碼：登入只需「帳號(工號/姓名)」，角色由後端 users.json 決定
       （帳號在清單中設為 LEADER 才有編輯權，否則一律 ENG 唯讀）
   - 後端 Leader 鎖：同站台同時間只允許一位 Leader 編輯
       其他 Leader 嘗試登入時自動降級為 ENG（唯讀）
   - 登入狀態存於 sessionStorage（關閉瀏覽器即失效）
   - 心跳每 30 秒呼叫一次保持 Leader 鎖；超過 90 秒未回應自動釋放
   ════════════════════════════════════════════════════════ */
const LS_KEY_SESSION = 'dsm_session_v2';

/* ── 多廠區（站台）設定 ──
   三個分頁：A3 / KL / 南科。每個站台資料獨立（人員、排班、Leader 鎖各自分開）。
   工號權限綁定（roleBindings）為全廠共用。 */
const SITES = [
  {id:'A3', name:'A3'},
  {id:'KL', name:'KL'},
  {id:'NK', name:'南科'}
];
function siteName(id){ const s=SITES.find(x=>x.id===id); return s?s.name:id; }
let currentSite = 'A3';
try{
  const savedSite = sessionStorage.getItem('dsm_site');
  if(savedSite && SITES.some(s=>s.id===savedSite)) currentSite = savedSite;
}catch(e){}
function cacheKey(site){ return 'dsm_cache_v2_' + (site||currentSite); }

/* ── 工號權限綁定（全廠共用）──
   { "K25091":"LEADER", ... }
   ★ v3.7 起預設規則：未綁定工號一律 ENG；只有綁定為 LEADER 者才能登入 Leader。 */
let roleBindings = {};
const RB_CACHE_KEY = 'dsm_rolebindings';
function loadRoleBindingsFromCache(){
  try{
    const raw = localStorage.getItem(RB_CACHE_KEY);
    if(raw){ const o = JSON.parse(raw); if(o && typeof o==='object') roleBindings = o; }
  }catch(e){}
}
loadRoleBindingsFromCache();

function saveRoleBindings(){
  try{ localStorage.setItem(RB_CACHE_KEY, JSON.stringify(roleBindings)); }catch(e){}
  if(!PREVIEW_MODE){
    try{
      fetch(API_URL+'?action=rb_save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(roleBindings)});
    }catch(e){}
  }
}

async function loadRoleBindingsFromServer(){
  if(PREVIEW_MODE) return;
  try{
    const r = await fetch(API_URL+'?action=rb_load',{cache:'no-store'});
    const d = await r.json();
    if(d && d.success && d.roleBindings && typeof d.roleBindings==='object'){
      roleBindings = d.roleBindings;
      try{ localStorage.setItem(RB_CACHE_KEY, JSON.stringify(roleBindings)); }catch(e){}
    }
  }catch(e){}
}

/* 依輸入（工號或姓名）查綁定權限，回傳 'LEADER' | 'ENG' | null */
function lookupRoleBinding(input){
  if(!input) return null;
  const v = String(input).trim().toLowerCase();
  if(!v) return null;
  // 1. 直接比對工號（不分大小寫）
  for(const id in roleBindings){
    if(String(id).trim().toLowerCase() === v) return roleBindings[id];
  }
  // 2. 用姓名比對 → 找到工程師工號 → 查綁定
  try{
    if(typeof engineers !== 'undefined' && Array.isArray(engineers)){
      const eng = engineers.find(e => e.name === String(input).trim());
      if(eng && roleBindings[eng.id]) return roleBindings[eng.id];
    }
  }catch(e){}
  return null;
}

let currentRole = null;           // 'LEADER' | 'ENG' | null（在目前站台的有效角色）
let myIntendedRole = 'ENG';       // 登入者本身的權限上限（LEADER 表示可在任一站台爭取編輯權）
let selectedLoginRole = 'LEADER'; // 選中但尚未送出的角色
let myName = '';                  // 登入者姓名
let myAccount = '';               // 登入者工號（不能修改/刪除自己）
let myLockToken = '';             // Leader 鎖 token（僅 LEADER 持有）
let myAuthToken = '';             // Flask 認證 token（登入成功後由後端發給，可用於後續驗證）
let _heartbeatTimer = null;
let _lockPollTimer = null;
let _lastModifiedInfo = { savedAt:null, savedBy:null };

// 目前站台「有效角色」可編輯者：LEADER 或 ADMIN（需持有該站編輯鎖）
function isLeader(){ return currentRole === 'LEADER' || currentRole === 'ADMIN'; }
function requireLeader(action){
  if(!isLeader()){
    showToast('⚠️ 此功能需編輯權限（LEADER / ADMIN），您目前為 ENG 唯讀模式','warning');
    return false;
  }
  return true;
}
// 依「真實登入角色」(myIntendedRole) 判定，帳號管理用，不受站台鎖影響
function trueIsAdmin(){ return myIntendedRole === 'ADMIN'; }
function trueIsAccountEditor(){ return myIntendedRole === 'ADMIN' || myIntendedRole === 'LEADER'; }
function requireAdmin(){
  if(!trueIsAdmin()){ showToast('⚠️ 此功能僅限 ADMIN','warning'); return false; }
  return true;
}
function requireAccountEditor(){
  if(!trueIsAccountEditor()){ showToast('⚠️ 此功能僅限 LEADER / ADMIN','warning'); return false; }
  return true;
}

/* 產生簡易 token（前端） */
function genToken(){
  return 'tk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,10);
}

function selectLoginRole(role){
  selectedLoginRole=role;
  document.getElementById('role-btn-LEADER').classList.toggle('active',role==='LEADER');
  document.getElementById('role-btn-ENG').classList.toggle('active',role==='ENG');
  const errEl=document.getElementById('login-error');
  if(errEl) errEl.style.display='none';
  const nmEl=document.getElementById('login-name');
  if(nmEl){ nmEl.focus(); }

  // 切換到 LEADER 時若已有人持有鎖，提前提示
  const hint = document.getElementById('login-lock-hint');
  if(hint){
    if(role==='LEADER') refreshLoginLockHint();
    else hint.style.display='none';
  }
}

/* 登入畫面：顯示目前是否已有 Leader 在線（提示用） */
async function refreshLoginLockHint(){
  const hint = document.getElementById('login-lock-hint');
  if(!hint) return;
  if(PREVIEW_MODE){ hint.style.display='none'; return; }
  try{
    const r = await fetch(API_URL+'?action=lock_check'+siteQ(),{cache:'no-store'});
    const d = await r.json();
    if(d && d.success && d.locked){
      hint.innerHTML = '<i class="bi bi-info-circle-fill me-1"></i>目前已有 Leader 在線：<b>'+escapeHtml(d.holder||'未知')+'</b>　登入後將自動降為 ENG 唯讀模式';
      hint.style.display='block';
    }else{
      hint.style.display='none';
    }
  }catch(e){
    hint.style.display='none';
  }
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* 登入畫面：輸入姓名/工號時，依綁定提示權限（預設 ENG，只有綁 Leader 才可 Leader）*/
function onLoginNameInput(){
  const nameEl = document.getElementById('login-name');
  const hint = document.getElementById('login-bind-hint');
  if(!nameEl || !hint) return;
  const v = nameEl.value.trim();
  const bound = lookupRoleBinding(v);
  const hasAnyLeaderBinding = Object.values(roleBindings).some(r => r === 'LEADER');
  const bL=document.getElementById('role-btn-LEADER');
  const bE=document.getElementById('role-btn-ENG');
  if(bound === 'LEADER'){
    selectedLoginRole = 'LEADER';
    if(bL){ bL.classList.add('active'); }
    if(bE) bE.classList.remove('active');
    hint.innerHTML = '<i class="bi bi-shield-fill-check me-1" style="color:#0098ff"></i>此工號具 <b style="color:#0098ff">Leader</b> 權限（也可改選 ENG 唯讀登入）';
    hint.style.color = '#0098ff';
    hint.style.display = 'block';
  }else if(!hasAnyLeaderBinding && v){
    // Bootstrap：尚未設定任何 Leader → 提示登入後可做初次設定
    hint.innerHTML = '<i class="bi bi-info-circle-fill me-1" style="color:#b37400"></i>系統尚未設定任何 Leader 工號，登入後即可做初次設定';
    hint.style.color = '#b37400';
    hint.style.display = 'block';
  }else if(v){
    selectedLoginRole = 'ENG';
    if(bL) bL.classList.remove('active');
    if(bE) bE.classList.add('active');
    hint.innerHTML = '<i class="bi bi-person-badge me-1" style="color:#7b5ea7"></i>此工號為 <b style="color:#7b5ea7">ENG</b> 唯讀權限（預設）';
    hint.style.color = '#7b5ea7';
    hint.style.display = 'block';
  }else{
    hint.style.display = 'none';
  }
}

async function doLogin(){
  const nameEl = document.getElementById('login-name');
  const nameVal = (nameEl?.value||'').trim();
  const errEl = document.getElementById('login-error');

  if(!nameVal){
    errEl.style.display='block';
    document.getElementById('login-error-text').textContent='請輸入您的姓名/工號';
    nameEl?.focus();
    return;
  }

  // ★ 無密碼登入：只用「帳號(工號/姓名)」向後端查角色。
  //   - 後端 app.py 讀 users.json：帳號設為 LEADER 才有編輯權，否則一律 ENG 唯讀。
  //   - 具 Leader 權限者仍可在登入畫面選「ENG」以唯讀身分登入。
  //   - PREVIEW_MODE（離線單機）時，角色改由前端 roleBindings 判斷。
  let boundRole = null;
  let effectiveRole = 'ENG';
  let displayName = nameVal;

  if(PREVIEW_MODE){
    // ── 離線預覽模式：角色由 roleBindings 決定（無後端、無密碼）──
    boundRole = lookupRoleBinding(nameVal);
    const hasAnyLeaderBinding = Object.values(roleBindings).some(r => r === 'LEADER');
    const canBeLeader = hasAnyLeaderBinding ? (boundRole === 'LEADER') : true;
    effectiveRole = canBeLeader ? ((selectedLoginRole === 'ENG') ? 'ENG' : 'LEADER') : 'ENG';
  }else{
    // ── 正式模式：呼叫後端查詢此帳號的角色（不需密碼）──
    let auth = null;
    try{
      const r = await fetch(API_URL + '?action=auth', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ account: nameVal })
      });
      auth = await r.json();
    }catch(e){
      errEl.style.display='block';
      document.getElementById('login-error-text').textContent =
        '無法連線後端伺服器（' + API_URL + '），請確認 app.py 已啟動';
      return;
    }
    if(!auth || !auth.success){
      errEl.style.display='block';
      document.getElementById('login-error-text').textContent =
        (auth && auth.message) || '登入失敗，請重試';
      return;
    }
    // 後端回傳的 role = 此帳號的權限上限
    boundRole    = (auth.role === 'LEADER') ? 'LEADER' : 'ENG';
    myAuthToken  = auth.token || '';
    if(auth.name) displayName = auth.name;
    // 具 Leader 權限者仍可自選 ENG 唯讀登入
    effectiveRole = (boundRole === 'LEADER' && selectedLoginRole !== 'ENG') ? 'LEADER' : 'ENG';
  }

  myName = displayName;
  myIntendedRole = effectiveRole;   // 記錄本身權限上限（供跨站台切換時判斷）
  let finalRole = effectiveRole;

  // 若有效角色為 Leader → 嘗試取得「目前站台」的鎖
  if(effectiveRole === 'LEADER'){
    const lockResult = await tryAcquireLeaderLock(nameVal);
    if(!lockResult.success){
      // 該站台鎖已被他人持有 → 在此站台降為 ENG 唯讀
      finalRole = 'ENG';
      myLockToken = '';
      showToast('⚠️ ['+siteName(currentSite)+'] 已有 Leader 在線：'+(lockResult.holder||'未知')+'，您在此廠將為 ENG 唯讀','warning');
    }else{
      finalRole = 'LEADER';
      startHeartbeat();
    }
  }

  currentRole = finalRole;
  try{
    sessionStorage.setItem(LS_KEY_SESSION, JSON.stringify({role:currentRole, intended:myIntendedRole, name:myName, token:myLockToken, site:currentSite}));
  }catch(e){}

  applyRoleToUI();
  document.getElementById('login-overlay').style.display='none';

  try{
    if(typeof renderSchedule==='function')renderSchedule();
    if(typeof renderPersonnel==='function')renderPersonnel();
    if(typeof buildDashboard==='function')buildDashboard();
  }catch(e){}

  // 啟動鎖狀態輪詢（讓 ENG / Dashboard 也看得到目前 Leader）
  startLockPolling();

  setTimeout(()=>{
    if(typeof showToast==='function'){
      if(boundRole){
        showToast('✓ 工號 '+myName+' 綁定權限：'+finalRole+(finalRole==='LEADER'?'｜完整編輯權限':'｜唯讀模式'),'success');
      }else if(currentRole==='LEADER'){
        showToast('✓ Leader 已登入｜完整編輯權限','success');
      }else if(effectiveRole==='LEADER'){
        showToast('您目前為 ENG 唯讀模式（已有 Leader 在線）','info');
      }else{
        showToast('✓ ENG 已登入｜唯讀模式','success');
      }
    }
  },200);
}

/* 嘗試取得 Leader 鎖 */
async function tryAcquireLeaderLock(name){
  const token = genToken();
  if(PREVIEW_MODE){
    // 預覽模式：單機，永遠允許登入，不啟動真實鎖
    myLockToken = '';
    return {success:true, fallback:true};
  }
  try{
    const r = await fetch(API_URL+'?action=lock_acquire'+siteQ(),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({token, name, role:'LEADER'})
    });
    const d = await r.json();
    if(d.success){
      myLockToken = token;
      return {success:true};
    }
    return {success:false, holder:d.holder||'未知'};
  }catch(e){
    console.warn('lock_acquire failed:', e);
    // 後端無回應 → 視為單機模式，允許單一 LEADER（不啟動鎖）
    myLockToken = '';
    return {success:true, fallback:true};
  }
}

/* ADMIN 強制接管：無視現有持鎖者，直接取得本廠編輯權 */
async function forceTakeoverLock(){
  if(!requireAdmin()) return;   // 僅限真實角色 ADMIN
  if(!confirm('確定要強制接管「'+siteName(currentSite)+'」的編輯權？\n目前正在編輯者會被轉為唯讀，其最後數秒未存檔的變動可能遺失。')) return;
  const token = myLockToken || genToken();
  try{
    const r = await fetch(API_URL+'?action=lock_force_acquire'+siteQ(),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token, name: myName, role: myIntendedRole })
    });
    const d = await r.json();
    if(d && d.success){
      myLockToken = token;
      currentRole = myIntendedRole;   // 取回編輯權（ADMIN）
      try{ sessionStorage.setItem(LS_KEY_SESSION, JSON.stringify({role:currentRole, intended:myIntendedRole, name:myName, token:myLockToken, site:currentSite})); }catch(e){}
      startHeartbeat();
      applyRoleToUI();
      try{ renderSchedule(); renderPersonnel(); buildDashboard(); }catch(e){}
      refreshLockStatus();
      showToast('已強制接管編輯權'+(d.takenFrom?('（原編輯者：'+d.takenFrom+'）'):'')+'，您現在可編輯','success');
    }else{
      showToast('接管失敗：'+((d&&d.error)||'未知錯誤'),'error');
    }
  }catch(e){ showToast('接管失敗：'+e.message,'error'); }
}

function startHeartbeat(){
  if(PREVIEW_MODE) return; // 預覽模式無心跳
  if(_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(async ()=>{
    if(!isLeader() || !myLockToken) return;
    try{
      const r = await fetch(API_URL+'?action=lock_heartbeat'+siteQ(),{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({token: myLockToken})
      });
      const d = await r.json();
      if(!d.success && !d.kept){
        // 鎖已被他人取走 → 自動降為 ENG
        showToast('⚠️ Leader 鎖已失效，自動切換為 ENG 唯讀模式','warning');
        stopHeartbeat();
        myLockToken = '';
        currentRole = 'ENG';
        try{ sessionStorage.setItem(LS_KEY_SESSION, JSON.stringify({role:'ENG', name:myName, token:''})); }catch(e){}
        applyRoleToUI();
        try{ renderSchedule(); renderPersonnel(); buildDashboard(); }catch(e){}
      }
    }catch(e){
      // 網路問題不主動降權
    }
  }, 30000);
}

function stopHeartbeat(){
  if(_heartbeatTimer){ clearInterval(_heartbeatTimer); _heartbeatTimer=null; }
}

/* Dashboard：定期更新 Leader 在線狀態 */
function startLockPolling(){
  if(_lockPollTimer) clearInterval(_lockPollTimer);
  refreshLockStatus();
  if(PREVIEW_MODE) return; // 預覽模式只更新一次
  _lockPollTimer = setInterval(refreshLockStatus, 15000);
}

async function refreshLockStatus(){
  const stat  = document.getElementById('dash-leader-status');
  const since = document.getElementById('dash-leader-since');
  const icon  = document.getElementById('dash-leader-icon');
  const tk    = document.getElementById('dash-takeover-btn');
  const hideTk = ()=>{ if(tk) tk.style.display='none'; };
  if(!stat || !since){ hideTk(); return; }
  if(PREVIEW_MODE){
    stat.textContent = '預覽模式（單機）';
    stat.style.color = '#b37400';
    since.textContent = '此為離線預覽版，未啟動 Leader 鎖機制';
    if(icon){ icon.style.background='rgba(255,165,2,.12)'; icon.style.color='var(--warning)'; icon.firstElementChild.className='bi bi-laptop'; }
    hideTk();
    return;
  }
  try{
    const r = await fetch(API_URL+'?action=lock_check'+siteQ(),{cache:'no-store'});
    const d = await r.json();
    if(d && d.success && d.locked){
      stat.textContent = '🔒 '+(d.holder||'未知')+' 編輯中';
      stat.style.color = '#0095b3';
      since.textContent = '取得時間：'+(d.acquiredAt||'—');
      if(icon){ icon.style.background='rgba(0,212,255,.12)'; icon.style.color='var(--accent)'; icon.firstElementChild.className='bi bi-shield-fill-check'; }
      // 被降權的 ADMIN（鎖在別人手上）→ 顯示「強制接管」
      const heldByOther = (d.holder || '') !== myName;
      if(tk) tk.style.display = (trueIsAdmin() && currentRole!=='ADMIN' && heldByOther) ? 'inline-flex' : 'none';
    }else{
      stat.textContent = '無人持有（可登入 Leader）';
      stat.style.color = '#6b7280';
      since.textContent = '若有人正以 Leader 編輯，會顯示於此';
      if(icon){ icon.style.background='rgba(107,114,128,.1)'; icon.style.color='#6b7280'; icon.firstElementChild.className='bi bi-unlock-fill'; }
      hideTk();
    }
  }catch(e){
    // 後端無回應 → 顯示為單機模式
    if(stat){ stat.textContent='單機 / 離線模式'; stat.style.color='#b37400'; }
    if(since){ since.textContent='伺服器未連線，鎖機制不啟用'; }
    hideTk();
  }
}


async function doLogout(){
  if(!confirm('確定要登出系統嗎？')) return;

  // 釋放目前站台 Leader 鎖
  if(isLeader() && myLockToken && !PREVIEW_MODE){
    try{
      await fetch(API_URL+'?action=lock_release'+siteQ(),{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({token: myLockToken})
      });
    }catch(e){}
  }

  stopHeartbeat();

  myLockToken = '';
  currentRole = null;
  myIntendedRole = 'ENG';
  myName = '';
  myAccount = '';

  try{
    sessionStorage.removeItem(LS_KEY_SESSION);
    sessionStorage.removeItem('dsm_login');

    // 重點：清掉站台記憶，避免下次登入自動進 KL / NK
    sessionStorage.removeItem('dsm_site');
  }catch(e){}

  location.replace('login.html');
}


function applyRoleToUI(){
  document.body.setAttribute('data-role', currentRole||'NONE');
  document.body.setAttribute('data-trole', myIntendedRole||'NONE');   // 真實角色（帳號管理用）
  const badge=document.getElementById('sidebar-role-badge');
  const txt  =document.getElementById('sidebar-role-text');
  if(badge && txt){
    badge.classList.remove('role-LEADER','role-ENG','role-ADMIN');
    if(currentRole==='ADMIN'){
      badge.classList.add('role-ADMIN');
      badge.querySelector('i').className='bi bi-gem';
      txt.textContent='ADMIN';
    }else if(currentRole==='LEADER'){
      badge.classList.add('role-LEADER');
      badge.querySelector('i').className='bi bi-shield-fill-check';
      txt.textContent='LEADER';
    }else if(currentRole==='ENG'){
      badge.classList.add('role-ENG');
      badge.querySelector('i').className='bi bi-person-badge';
      txt.textContent='ENG';
    }
  }
  // 側邊欄顯示姓名 / 角色
  const sn=document.getElementById('sidebar-admin-name');
  const sr=document.getElementById('sidebar-admin-role');
  const sv=document.getElementById('sidebar-avatar');
  const roleLabel = currentRole==='ADMIN' ? 'Admin｜最高權限'
                  : currentRole==='LEADER' ? 'Leader｜編輯權限'
                  : 'ENG｜唯讀模式';
  if(sn) sn.textContent = myName || (isLeader()?'系統管理員':'值班工程師');
  if(sr) sr.textContent = roleLabel;
  if(sv) sv.textContent = (myName && myName[0]) ? myName[0] : (currentRole==='ADMIN'?'A':currentRole==='LEADER'?'L':'E');
}

/* 嘗試還原 session（重新整理頁面後不必再登入） */
async function tryRestoreSession(){
  try{
    const raw = sessionStorage.getItem(LS_KEY_SESSION);
    if(!raw) return false;
    const sess = JSON.parse(raw);
    if(!sess || !['ADMIN','LEADER','ENG'].includes(sess.role)) return false;

    currentRole = sess.role;
    myIntendedRole = sess.intended || sess.role || 'ENG';
    myName = sess.name || '';
    myLockToken = sess.token || '';
    if(sess.site && SITES.some(s=>s.id===sess.site)) currentSite = sess.site;

    // 若是編輯者(LEADER/ADMIN)，要重新確認鎖還在自己手上
    if(currentRole==='LEADER' || currentRole==='ADMIN'){
      if(PREVIEW_MODE){
        // 預覽模式：永遠保留 LEADER 不需要核對鎖
      }else if(myLockToken){
        try{
          const r = await fetch(API_URL+'?action=lock_acquire'+siteQ(),{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({token: myLockToken, name: myName, role:'LEADER'})
          });
          const d = await r.json();
          if(!d.success){
            // 鎖已被別人拿走 → 降為 ENG
            currentRole = 'ENG';
            myLockToken = '';
            showToast('原 Leader 鎖已被他人取得，您已降為 ENG 唯讀','warning');
          }else{
            startHeartbeat();
          }
        }catch(e){
          // 離線 → 保留 LEADER 但不啟動心跳
        }
      }else{
        // 沒有 token → 視為 ENG
        currentRole = 'ENG';
      }
    }

    applyRoleToUI();
    document.getElementById('login-overlay').style.display='none';
    startLockPolling();
    return true;
  }catch(e){ return false; }
}

/* 進入主頁時建立工作階段：
   讀取 login.html 寫入的 dsm_login（工號/姓名/角色/intended）；
   沒有就導回 login.html。若 intended=LEADER 則嘗試取得該站 Leader 鎖。 */
async function initSession(){
  let sess = null;
  try{ sess = JSON.parse(sessionStorage.getItem('dsm_login') || 'null'); }catch(e){}
  if(!sess || !sess.account || !['ADMIN','LEADER','ENG'].includes(sess.intended)){
    location.replace('login.html');
    return false;
  }
  myName = sess.name || sess.account;
  myAccount = (sess.account || '').trim();   // 登入者工號（用於「不能改自己權限」）
  myIntendedRole = sess.intended;   // 真實角色（ADMIN/LEADER/ENG）

  if(myIntendedRole === 'LEADER' || myIntendedRole === 'ADMIN'){
    if(PREVIEW_MODE){
      currentRole = myIntendedRole;
    }else{
      const lock = await tryAcquireLeaderLock(myName);
      if(lock.success){
        currentRole = myIntendedRole;   // 取得編輯鎖 → 維持真實角色
        startHeartbeat();
      }else{
        currentRole = 'ENG';            // 該站已有編輯者 → 此站降為唯讀（帳號管理仍依真實角色）
        showToast('['+siteName(currentSite)+'] 已有編輯者在線：'+(lock.holder||'未知')+'，您在此廠為 ENG 唯讀','warning');
      }
    }
  }else{
    currentRole = 'ENG';
  }

  // 記錄目前工作階段（供站台切換等內部使用）
  try{
    sessionStorage.setItem(LS_KEY_SESSION, JSON.stringify({
      role: currentRole, intended: myIntendedRole, name: myName,
      token: myLockToken, site: currentSite
    }));
  }catch(e){}

  applyRoleToUI();
  startLockPolling();
  return true;
}

/* ========================================================
   💾 LOCAL STORAGE PERSISTENCE  (跨電腦可攜版)
   ═══════════════════════════════════════════════════════════
   伺服器持久化儲存 — 透過 Flask 後端 app.py 讀寫 JSON 檔案
   多人線上即時存取，資料存於 Server 端 data/ 資料夾
   ======================================================== */
let _serverOnline = false;
let _saveTimer = null;
let _saving = false;
let _lastSaveTime = null;

// ─── 伺服器狀態檢查 ───
async function checkServerStatus(){
  if(PREVIEW_MODE){
    _serverOnline = false;
    updateStatusUI();
    return null;
  }
  try{
    const r = await fetch(API_URL+'?action=status',{cache:'no-store'});
    const d = await r.json();
    _serverOnline = d.success;
    updateStatusUI();
    return d;
  }catch(e){
    _serverOnline = false;
    updateStatusUI();
    return null;
  }
}

function updateStatusUI(){
  const dot = document.querySelector('.status-dot');
  const txt = document.querySelector('.system-status span');
  if(dot && txt){
    if(PREVIEW_MODE){
      dot.style.background='var(--accent)'; dot.style.boxShadow='0 0 8px rgba(0,212,255,.5)';
      txt.textContent='✓ 本機預覽模式';
    } else if(_serverOnline){
      dot.style.background='var(--success)'; dot.style.boxShadow='0 0 8px rgba(0,255,136,.5)';
      txt.textContent='伺服器連線中';
    } else {
      dot.style.background='var(--warning)'; dot.style.boxShadow='0 0 8px rgba(255,165,2,.5)';
      txt.textContent='離線模式（localStorage）';
    }
  }
  // Save indicator
  const saveInd = document.getElementById('save-indicator');
  if(saveInd && _lastSaveTime){
    const t = new Date(_lastSaveTime);
    saveInd.textContent = '已儲存 '+t.toLocaleTimeString('zh-TW',{hour12:false});
    saveInd.style.color = 'var(--success)';
  }
}


function scheduleMonthsToData(months){
  const engMap = {};
  const sched  = {};

  Object.keys(months).forEach(ym => {
    const md = months[ym] || {};
    const shifts = md.shifts || md;

    ['4A','4B','5A','5B'].forEach(sh => {
      (shifts[sh] || []).forEach(p => {
        if(!p || !p.id) return;

        if(!engMap[p.id]){
          engMap[p.id] = {
            id: p.id,
            name: p.name,
            shift: p.shift || sh,
            group: p.group,
            title: p.title,
            seniority: (p.seniority != null ? p.seniority : 0),
            note: p.note || '',
            factory: p.factory || currentSite,
            hiredate: p.hiredate || '',
            inactiveFromYm: p.inactiveFromYm || ''
          };
        }

        if(p.inactiveFromYm){
          engMap[p.id].inactiveFromYm = p.inactiveFromYm;
        }

        sched[p.id] = sched[p.id] || {};

        const days = p.days || {};

        Object.keys(days).forEach(dd => {
          const c = days[dd] || {};
          const key = c.date || (ym.slice(0,4) + '-' + ym.slice(4,6) + '-' + dd);

          sched[p.id][key] = {
            type: c.type || 'ON',
            loc:  c.loc  || '',
            leave: c.leave || 0,
            ot:   c.ot    || 0,
            leaveTemp: c.leaveTemp || 0
          };
        });
      });
    });
  });

  return {
    engineers: Object.values(engMap),
    scheduleData: sched,
    config: null
  };
}


async function serverLoadAllData(){
  if(PREVIEW_MODE){
    _serverOnline = false;
    return null;
  }

  // 1. 月份班表檔：主要來源
  try{
    const r = await fetch(API_URL + '?action=load_schedule' + siteQ(), {cache:'no-store'});

    if(r.ok){
      const d = await r.json();
      _serverOnline = true;

      // 只要後端有回傳 months，而且有任何月份 key，就代表該站台已有正式資料。
      // 即使 engineers.length === 0，也要視為有效空白資料。
      if(d && d.success && d.months && Object.keys(d.months).length){
        const conv = scheduleMonthsToData(d.months);
        const meta = d.meta || {};

        if(meta.savedAt || meta.savedBy){
          _lastModifiedInfo = {
            savedAt: meta.savedAt || null,
            savedBy: meta.savedBy || null
          };
        }

        conv.config = meta.config || null;

        console.log(
          '✅ [' + siteName(currentSite) + '] 由月份班表檔載入：' +
          Object.keys(d.months).sort().join(', ') +
          '，人員數：' + conv.engineers.length
        );

        return conv;
      }
    }
  }catch(e){
    console.warn('load_schedule failed:', e.message);
    _serverOnline = false;
    return null;
  }

  // 2. 舊版 alldata.json fallback
  // 只允許 A3 使用，避免 KL / NK 被舊資料污染。
  if(currentSite === 'A3'){
    try{
      const r2 = await fetch(API_URL + '?action=load' + siteQ(), {cache:'no-store'});

      if(r2.ok){
        const data = await r2.json();

        if(data && Array.isArray(data.engineers) && data.scheduleData){
          _serverOnline = true;
          _lastModifiedInfo = {
            savedAt: data.savedAt || null,
            savedBy: data.savedBy || null
          };

          return {
            engineers: data.engineers,
            scheduleData: data.scheduleData,
            config: data.config || null
          };
        }
      }
    }catch(e){}
  }

  // KL / NK 沒有正式月份檔時，直接回 null，讓 initLoadData 建立空白名單
  return null;
}


function dataToScheduleMonths(){
  const TYPE_LABEL = { ON:'出勤', REST:'休息', HOLIDAY:'例假', LEAVE:'加班日' };
  const months = {};

  function ensureMonth(ym){
    if(!months[ym]){
      months[ym] = {
        site: currentSite,
        year: parseInt(ym.slice(0,4), 10),
        month: parseInt(ym.slice(4,6), 10),
        ym,
        shifts: {'4A':[],'4B':[],'5A':[],'5B':[]},
        _map: {}
      };
    }

    return months[ym];
  }

  engineers.forEach(eng => {
    const sd = scheduleData[eng.id] || {};

    Object.keys(sd).forEach(dateKey => {
      const ym = ymFromDateKey(dateKey);
      if(!ym) return;

      if(eng.inactiveFromYm && ym >= eng.inactiveFromYm){
        return;
      }

      const M = ensureMonth(ym);
      let person = M._map[eng.id];

      if(!person){
        const sh = (eng.shift && M.shifts[eng.shift]) ? eng.shift : '4A';

        person = {
          id: eng.id,
          name: eng.name,
          shift: eng.shift || sh,
          group: eng.group,
          title: eng.title,
          seniority: (eng.seniority != null ? eng.seniority : 0),
          note: eng.note || '',
          factory: eng.factory || currentSite,
          hiredate: eng.hiredate || '',
          isMaintenance: eng.title === '保養組',
          days: {}
        };

        if(eng.inactiveFromYm){
          person.inactiveFromYm = eng.inactiveFromYm;
        }

        M._map[eng.id] = person;
        M.shifts[sh].push(person);
      }

      const c = sd[dateKey] || {};
      const dd = dateKey.slice(8, 10);

      person.days[dd] = {
        date: dateKey,
        type: c.type || 'ON',
        typeLabel: TYPE_LABEL[c.type] || (c.type || 'ON'),
        loc: c.loc || '',
        leave: c.leave || 0,
        ot: c.ot || 0,
        leaveTemp: c.leaveTemp || 0
      };
    });
  });

  try{
    AVAIL_MONTHS.forEach(({year, month}) => {
      const ym = ymFromYearMonth(year, month);
      ensureMonth(ym);
    });
  }catch(e){
    console.warn('ensure empty months failed:', e);
  }

  Object.values(months).forEach(M => {
    delete M._map;
  });

  return months;
}

/* ════════════════════════════════════════════════════════
   值班名單 roster：每站台獨立檔 data/<site>/roster.json
   - 與 users.json（登入帳號）分離；正式名單來源
   - 新增人員：後端 roster_add 做工號唯一性檢查（users.json
     已存在 → 409 拒絕），通過後同寫 roster.json + users.json(ENG)
   ════════════════════════════════════════════════════════ */
async function fetchRoster(){
  if(PREVIEW_MODE) return [];
  try{
    const r = await fetch(API_URL + '?action=roster_load&site=' + encodeURIComponent(currentSite), {cache:'no-store'});
    const d = await r.json();
    if(r.ok && d && d.success && Array.isArray(d.people)) return d.people;
  }catch(e){ console.warn('讀取值班名單 roster.json 失敗：', e); }
  return [];
}

// 移除是否已生效（inactiveFromYm ≤ 本月 → 此人已不在現役名冊）
function isRosterExpired(p){
  if(!p || !p.inactiveFromYm) return false;
  const now = todayNow();
  const nowYm = ymFromYearMonth(now.getFullYear(), now.getMonth());
  return String(p.inactiveFromYm) <= nowYm;
}

// 把目前 engineers 同步回該站 roster.json（編輯姓名/班別/移除標記後呼叫）
// roster.json = 現役名冊：移除已生效者不寫入（歷史排班仍保留於月份檔）；
// 未來才生效的移除 → 保留並帶 inactiveFromYm 標記，時間到自動清除。
async function syncRosterSave(){
  if(PREVIEW_MODE) return;
  try{
    const people = engineers.filter(e => !isRosterExpired(e)).map(e => ({
      id: e.id, name: e.name, shift: e.shift, group: e.group,
      title: e.title, seniority: e.seniority || 0, note: e.note || '',
      factory: e.factory || currentSite, hiredate: e.hiredate || '',
      isMaintenance: !!(e.isMaintenance || e.title === '保養組'),
      inactiveFromYm: e.inactiveFromYm || ''
    }));
    await fetch(API_URL + '?action=roster_save&site=' + encodeURIComponent(currentSite), {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({people})
    });
  }catch(e){ console.warn('同步 roster.json 失敗：', e); }
}


// ─── 儲存到伺服器（寫入月份班表檔，與顯示同一份）───
async function serverSave(){
  if(_saving) return;
  _saving = true;
  const saveInd = document.getElementById('save-indicator');
  if(saveInd){ saveInd.textContent='儲存中...'; saveInd.style.color='var(--warning)'; }

  const cfg = {
    adminName: document.getElementById('setting-admin-name')?.value||'系統管理員',
    adminId:   document.getElementById('setting-admin-id')?.value||'ADM-001'
  };
  const meta = {
    config: cfg,
    savedAt: new Date().toISOString(),
    savedBy: myName || (currentRole==='LEADER'?'Leader':'System'),
    savedRole: currentRole || 'UNKNOWN',
    version: '4.0.0'
  };
  // localStorage 快取仍用 engineers+scheduleData 形式（離線載入用）
  const cachePayload = { engineers, scheduleData, config: cfg, savedAt: meta.savedAt, savedBy: meta.savedBy };

  // 預覽模式：直接寫 localStorage 就好
  if(PREVIEW_MODE){
    try{
      localStorage.setItem(cacheKey(), JSON.stringify(cachePayload));
      _lastSaveTime = new Date();
      _lastModifiedInfo = { savedAt: meta.savedAt, savedBy: meta.savedBy };
      refreshLastModifiedUI();
    }catch(e){}
    _saving = false; updateStatusUI(); return;
  }

  // 將目前資料轉成月份班表檔格式後寫回
  const months = dataToScheduleMonths();

  try{
    const r = await fetch(API_URL+'?action=save_schedule'+siteQ(),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ site: currentSite, months, meta })
    });
    const d = await r.json();
    if(d.success){
      _lastSaveTime = new Date();
      _serverOnline = true;
      _lastModifiedInfo = { savedAt: meta.savedAt, savedBy: meta.savedBy };
      refreshLastModifiedUI();
      try{ localStorage.setItem(cacheKey(), JSON.stringify(cachePayload)); }catch(e){}
    } else {
      throw new Error(d.error||'Save failed');
    }
  }catch(e){
    console.warn('Server save failed, saving to localStorage only',e);
    _serverOnline = false;
    try{
      localStorage.setItem(cacheKey(), JSON.stringify(cachePayload));
      _lastModifiedInfo = { savedAt: meta.savedAt, savedBy: meta.savedBy };
      refreshLastModifiedUI();
    }catch(e2){}
  }
  _saving = false;
  updateStatusUI();
}

// ─── 防抖自動儲存 (修改後 1.5 秒自動存檔) ───
function lsSave(){
  // 立即存 localStorage 快取
  try{
    const cfg = {
      adminName: document.getElementById('setting-admin-name')?.value||'系統管理員',
      adminId:   document.getElementById('setting-admin-id')?.value||'ADM-001'
    };
    localStorage.setItem(cacheKey(), JSON.stringify({engineers, scheduleData, config:cfg}));
  }catch(e){}
  
  // 防抖 → 伺服器存檔
  if(_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(()=>{
    serverSave();
  }, 1500);
  
  // 更新 UI 提示
  const saveInd = document.getElementById('save-indicator');
  if(saveInd){ saveInd.textContent='修改中...'; saveInd.style.color='var(--accent)'; }
}


function sleepMs(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 切換頁面前，如果有防抖存檔尚未執行，先強制寫入後端
async function flushPendingSaveBeforeReload(){
  try{
    if(_saveTimer){
      clearTimeout(_saveTimer);
      _saveTimer = null;
      await serverSave();
    }

    // 如果剛好正在存檔，等它結束
    const start = Date.now();
    while(_saving && Date.now() - start < 5000){
      await sleepMs(100);
    }
  }catch(e){
    console.warn('flushPendingSaveBeforeReload failed:', e);
  }
}

// 只重新撈目前站台資料，不吃 localStorage、不建預設資料
async function reloadCurrentSiteDataFromServer(){
  if(PREVIEW_MODE) return false;

  // 先把目前修改寫入，避免重撈時被舊資料蓋掉
  await flushPendingSaveBeforeReload();

  try{
    const serverData = await serverLoadAllData();

    if(
      serverData &&
      Array.isArray(serverData.engineers) &&
      serverData.scheduleData &&
      typeof serverData.scheduleData === 'object'
    ){
      engineers = serverData.engineers;
      scheduleData = serverData.scheduleData;

      if(serverData.config){
        const c = serverData.config;

        const nameEl = document.getElementById('setting-admin-name');
        const idEl   = document.getElementById('setting-admin-id');

        if(nameEl && c.adminName) nameEl.value = c.adminName;
        if(idEl && c.adminId) idEl.value = c.adminId;

        if(typeof applyAdminConfig === 'function'){
          applyAdminConfig(c);
        }
      }

      // 補建目前可見月份，但不建立 KL / NK 預設人員
      try{
        if(typeof ensureVisibleMonthsBuilt === 'function'){
          ensureVisibleMonthsBuilt();
        }
      }catch(e){}

      try{
        refreshLastModifiedUI();
        updateStatusUI();
      }catch(e){}

      console.log('✅ [' + currentSite + '] sidebar 切換時已重新撈取後端資料，目前人員數：' + engineers.length);

      return true;
    }

    console.warn('reloadCurrentSiteDataFromServer：後端沒有有效資料');
    return false;
  }catch(e){
    console.warn('reloadCurrentSiteDataFromServer failed:', e);
    return false;
  }
}

// 依照目前頁面重新渲染
function renderCurrentPage(page){
  if(page === 'dashboard') buildDashboard();
  if(page === 'schedule') renderSchedule();
  if(page === 'calendar') renderCalendar();
  if(page === 'personnel') renderPersonnel();
  if(page === 'analysis') renderAnalysis();
  if(page === 'settings') renderRoleBindings();
}


// ─── 初始載入 (伺服器 → localStorage 快取 → 預設) ───
async function initLoadData(){
  let loadedFrom = null;
  // 1. 先嘗試伺服器（當前站台）
  const serverData = await serverLoadAllData();
  if(serverData && serverData.engineers && serverData.scheduleData){
    engineers = serverData.engineers;
    scheduleData = serverData.scheduleData;
    if(serverData.config){
      const c = serverData.config;
      const nameEl=document.getElementById('setting-admin-name');
      const idEl=document.getElementById('setting-admin-id');
      if(nameEl&&c.adminName) nameEl.value=c.adminName;
      if(idEl&&c.adminId) idEl.value=c.adminId;
      // 向下相容：v3.6 以前 roleBindings 存在 config 內；若全廠綁定為空則一次性沿用
      if(c.roleBindings && typeof c.roleBindings==='object' && Object.keys(roleBindings).length===0){
        roleBindings = c.roleBindings; saveRoleBindings();
      }
      applyAdminConfig(c);
    }
    loadedFrom = 'server';
  }
  
  // 2. 嘗試 localStorage 快取（當前站台）
  if(!loadedFrom){
    try{
      const cache = localStorage.getItem(cacheKey());
      if(cache){
        const c = JSON.parse(cache);
        if(c.engineers && c.scheduleData){
          engineers = c.engineers;
          scheduleData = c.scheduleData;
          if(c.config){
            applyAdminConfig(c.config);
            if(c.config.roleBindings && typeof c.config.roleBindings==='object' && Object.keys(roleBindings).length===0){
              roleBindings = c.config.roleBindings; saveRoleBindings();
            }
          }
          loadedFrom = 'cache';
        }
      }
    }catch(e){}
  }

  // 3. 若步驟 1、2 載入成功 → 執行 schema migration（保養組僅屬 A3）
  if(loadedFrom){
    // ── 值班工程師名冊真實來源：data/<site>/roster.json（各廠獨立）──
    // 名冊（人員與屬性：姓名/班別/組別/職稱…）以 roster.json 為準；
    // 月份檔只負責排班資料(days)。
    // 月份檔有、roster 沒有的人 → 視為 roster 建檔前新增，自動遷移寫回 roster.json。
    try{
      const rosterPeople = await fetchRoster();
      if(rosterPeople.length > 0){
        const legacy = engineers;                       // 月份檔/快取載入的舊名單
        const legacyMap = new Map(legacy.map(e => [String(e.id), e]));
        let dirty = false, migrated = 0, joined = 0;

        engineers = rosterPeople.map(p => {
          const out = {...p, factory: p.factory || currentSite};
          const old = legacyMap.get(String(p.id));
          // 移除標記：月份檔已有設定而 roster 尚未記錄 → 帶回並回寫
          if(old && old.inactiveFromYm && !out.inactiveFromYm){
            out.inactiveFromYm = old.inactiveFromYm; dirty = true;
          }
          if(isRosterExpired(out)) dirty = true;        // 移除已生效 → 觸發回寫時自 roster 清除
          if(!old) joined++;                            // roster 有、月份檔沒有 → 新人入列
          return out;
        });

        legacy.forEach(e => {                           // 月份檔有、roster 沒有
          if(!engineers.some(x => String(x.id) === String(e.id))){
            engineers.push({...e});                     // 進記憶體（歷史月份仍要顯示）
            if(!isRosterExpired(e)){                    // 僅「現役/未來移除」才遷移進 roster
              migrated++; dirty = true;
            }
          }
        });

        if(joined > 0 || migrated > 0){
          AVAIL_MONTHS.forEach(({year, month}) => buildScheduleForMonth(year, month));
          try{ serverSave(); }catch(e){}
        }
        if(dirty) syncRosterSave();
        if(migrated > 0) console.log('✅ 月份檔 ' + migrated + ' 位人員已遷移至 roster.json');
        if(joined > 0) console.log('✅ 依 roster.json 補入 ' + joined + ' 位值班人員');
      }else if(engineers.length > 0){
        // roster.json 不存在/被清空，但月份檔有人 → 自我修復：用現有名單重建 roster.json
        syncRosterSave();
        console.log('ℹ️ roster.json 為空，已依月份檔名單重建');
      }
    }catch(e){ console.warn('roster 名冊同步失敗：', e); }
    if(loadedFrom === 'server'){
      console.log('✅ ['+currentSite+'] 資料從伺服器載入');
      showToast(
        '[' + siteName(currentSite) + '] 資料已載入（' + getCurrentMonthPersonCountText() + '）',
        'success'
      );
    } else {
      console.log('✅ ['+currentSite+'] 資料從本機快取載入');
      showToast('['+siteName(currentSite)+'] '+(PREVIEW_MODE?'預覽資料已載入':'快取資料已載入'),'info');
    }
    return;
  }
  
  // 4. 嘗試舊版 localStorage（僅 A3 沿用舊單站資料）
// 只允許 A3 使用本機快取。
// KL / NK 不吃 localStorage，避免舊測試資料自動出現。
if(currentSite === 'A3'){
  try{
    const raw = localStorage.getItem(cacheKey());
    if(raw){
      const data = JSON.parse(raw);
      if(data && Array.isArray(data.engineers) && data.scheduleData){
        engineers = data.engineers;
        scheduleData = data.scheduleData;
        loadedFrom = 'cache';
      }
    }
  }catch(e){}
}
  
  // 5. 此站台尚無資料 → 建立預設（A3 用完整範本；KL/NK 為空白，待使用者新增人員）
  await buildDefaultData();
  console.log('ℹ️ ['+currentSite+'] 建立預設資料（'+engineers.length+' 人）');
  if(engineers.length > 0){
    showToast('['+siteName(currentSite)+'] 已建立預設資料，可開始編輯','info');
    setTimeout(()=>{ try{ serverSave(); }catch(e){} }, 500);
  }else{
    showToast('['+siteName(currentSite)+'] 尚無人員，請以 Leader 至「人員管理」新增','info');
  }
}

/* 建立預設資料：名單一律來自該站 data/<site>/roster.json
   - A3：roster.json 內含 64 人（含保養組）
   - KL / NK：roster.json 目前為空 → 空白名單，由 Leader 於「人員管理」新增 */
async function buildDefaultData(){
  engineers = (await fetchRoster()).map(e => ({...e, factory: e.factory || currentSite}));
  if(engineers.length > 0){
    buildSchedule();
  }else{
    scheduleData = {};
  }
}

/* ════════════════════════════════════════════════════════
   🏭 切換廠區（分頁）
   ════════════════════════════════════════════════════════ */
let _switchingSite = false;
async function switchSite(siteId){
  if(_switchingSite) return;
  if(siteId === currentSite){ return; }
  if(!SITES.some(s=>s.id===siteId)) return;
  _switchingSite = true;

  // 1. 先存目前站台資料
  try{ lsSave(); }catch(e){}

  // 2. 若我在目前站台持有 Leader 鎖 → 釋放
  if(currentRole==='LEADER' && myLockToken && !PREVIEW_MODE){
    try{
      await fetch(API_URL+'?action=lock_release'+siteQ(),{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({token: myLockToken})
      });
    }catch(e){}
  }
  stopHeartbeat();
  myLockToken='';

  // 3. 切換站台
  currentSite = siteId;
  try{ sessionStorage.setItem('dsm_site', currentSite); }catch(e){}

  // 4. 載入新站台資料
  await initLoadData();
  ensureVisibleMonthsBuilt();   // 補建該站尚無資料的可見月份（空白站台則略過）

  // 5. 重新評估在新站台的角色（具編輯權者 LEADER/ADMIN 才爭取編輯鎖）
  if(myIntendedRole === 'LEADER' || myIntendedRole === 'ADMIN'){
    const lockResult = await tryAcquireLeaderLock(myName);
    if(lockResult.success){
      currentRole = myIntendedRole;
      startHeartbeat();
    }else{
      currentRole = 'ENG';
      showToast('['+siteName(currentSite)+'] 已有編輯者在線：'+(lockResult.holder||'未知')+'，您在此廠為 ENG 唯讀','warning');
    }
  }else{
    currentRole = 'ENG';
  }
  try{
    sessionStorage.setItem(LS_KEY_SESSION, JSON.stringify({role:currentRole, intended:myIntendedRole, name:myName, token:myLockToken, site:currentSite}));
  }catch(e){}

  // 6. 更新分頁 UI + 重新渲染（每個獨立 try，避免單一失敗影響其他視圖）
  applyRoleToUI();
  updateSiteTabsUI();
  startLockPolling();
  safeRun('buildDashboard', buildDashboard);
  safeRun('renderSchedule', renderSchedule);
  safeRun('renderCalendar', renderCalendar);
  safeRun('renderPersonnel', renderPersonnel);
  safeRun('renderAnalysis', renderAnalysis);
  safeRun('renderRoleBindings', renderRoleBindings);
  safeRun('updateStatusUI', updateStatusUI);

  showToast('已切換至 '+siteName(currentSite)+' 廠區','success');
  _switchingSite = false;
}

/* 安全執行渲染函式：單一失敗不影響其他視圖，並印出錯誤方便除錯 */
function safeRun(label, fn){
  try{ fn(); }
  catch(e){ console.error('[render error] '+label+':', e && e.message ? e.message : e); }
}

function updateSiteTabsUI(){
  document.querySelectorAll('.site-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-site')===currentSite);
  });
  // 更新側邊欄 / 標題的廠區標示
  const lbl = document.getElementById('current-site-label');
  if(lbl) lbl.textContent = siteName(currentSite);
}

function applyAdminConfig(c){
  if(!c) return;
  // 管理員設定只回填到「系統設定」表單，不覆蓋側邊欄的「登入身分」
  const ni=document.getElementById('setting-admin-name');
  const ei=document.getElementById('setting-admin-id');
  if(ni && c.adminName) ni.value=c.adminName;
  if(ei && c.adminId)   ei.value=c.adminId;
}

// 保留向下相容
function lsLoad(){ /* 由 initLoadData 取代 */ }
function lsLoadConfig(){ /* 由 initLoadData 取代 */ }

/* ── 匯出備份 ── */
function exportBackup(){
  if(!requireLeader()) return;
  // 1. 伺服器端備份（預覽模式跳過）
  if(_serverOnline && !PREVIEW_MODE){
    fetch(API_URL+'?action=backup'+siteQ(),{method:'POST'}).then(r=>r.json()).then(d=>{
      if(d.success) showToast('伺服器端備份已建立：'+d.file,'success');
    }).catch(e=>{});
  }
  // 2. 同時下載本機備份
  const data={engineers,scheduleData,exportedAt:new Date().toISOString(),version:'3.0.0'};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='排班備份_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();URL.revokeObjectURL(a.href);
  showToast('本機備份檔案已下載！','success');
}

/* ── 匯入備份 ── */
function importBackup(){
  if(!requireLeader()) return;
  const input=document.createElement('input');
  input.type='file';input.accept='.json';
  input.onchange=e=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const data=JSON.parse(ev.target.result);
        if(!data.engineers||!data.scheduleData){showToast('備份格式錯誤！','danger');return;}
        engineers=data.engineers;
        scheduleData=data.scheduleData;
        lsSave(); // 會同步到伺服器
        buildDashboard();renderSchedule();renderCalendar();renderPersonnel();renderAnalysis();
        showToast('備份匯入成功！共 '+engineers.length+' 筆人員資料','success');
      }catch(err){showToast('匯入失敗：'+err.message,'danger');}
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ── 清除所有資料（重置） ── */
async function resetAllData(){
  if(!requireLeader()) return;
  if(!confirm('⚠️ 確定要清除所有已儲存的資料，回復到初始狀態嗎？\n此操作無法復原！')) return;
  try{ localStorage.removeItem(cacheKey()); localStorage.removeItem('dsm_engineers_v1'); localStorage.removeItem('dsm_schedule_v1'); localStorage.removeItem('dsm_config_v1'); }catch(e){}
  engineers = (await fetchRoster()).map(e => ({...e}));
  buildSchedule();
  lsSave();
  buildDashboard();renderSchedule();renderCalendar();renderPersonnel();renderAnalysis();
  showToast('已重置為預設資料','info');
}

/* ========================================================
   結構設定（人員名單已外移至 data/<site>/roster.json）
   ======================================================== */
const GROUPS_MAP={'4A':['A1','A2','A3'],'5A':['Z1','Z2','Z3'],'4B':['C1','C2','C3'],'5B':['X1','X2','X3']};




// (Month stats are now computed dynamically from scheduleData via getMonthStats())

// ═══════════════════════════════════════════════════════════
// 2026 REAL CALENDAR DATA — parsed from 2026行事曆_公告版.xlsx
// Each entry: {day: 'ON'|'REST'|'LEAVE'|'HOLIDAY'}
// LEAVE (休假日/藍) = OT加班日
// ═══════════════════════════════════════════════════════════
const CAL_2026 = {
  // 4A / 5A shift group 1 (A1,Z1 suffix): sheet A1,A4,A7,Z1,Z4,Z7,B1,B4,B7
  // 4B / 5B shift group 1 (C1,X1 suffix): sheet C1,C4,C7,X1,X4,X7,D1,D4,D7
  // Groups: A1→4A, A2→4A, A3→4A, Z1→5A, Z2→5A, Z3→5A, C1→4B, C2→4B, C3→4B, X1→5B, X2→5B, X3→5B
  '4A_G1': { // A1 group (groups A1 = 4A-g1, Z1 = 5A-g1)
    M6:{1:'LEAVE',2:'ON',3:'ON',4:'REST',5:'HOLIDAY',6:'ON',7:'ON',8:'LEAVE',9:'REST',10:'ON',11:'ON',12:'HOLIDAY',13:'LEAVE',14:'ON',15:'ON',16:'REST',17:'HOLIDAY',18:'ON',19:'ON',20:'LEAVE',21:'REST',22:'ON',23:'ON',24:'HOLIDAY',25:'LEAVE',26:'ON',27:'ON',28:'LEAVE',29:'HOLIDAY',30:'ON'},
    M7:{1:'ON',2:'LEAVE',3:'REST',4:'ON',5:'ON',6:'HOLIDAY',7:'LEAVE',8:'ON',9:'ON',10:'REST',11:'HOLIDAY',12:'ON',13:'ON',14:'LEAVE',15:'REST',16:'ON',17:'ON',18:'HOLIDAY',19:'LEAVE',20:'ON',21:'ON',22:'REST',23:'HOLIDAY',24:'ON',25:'ON',26:'LEAVE',27:'REST',28:'ON',29:'ON',30:'HOLIDAY',31:'LEAVE'},
    M8:{1:'ON',2:'ON',3:'LEAVE',4:'HOLIDAY',5:'ON',6:'ON',7:'LEAVE',8:'REST',9:'ON',10:'ON',11:'HOLIDAY',12:'LEAVE',13:'ON',14:'ON',15:'REST',16:'HOLIDAY',17:'ON',18:'ON',19:'LEAVE',20:'REST',21:'ON',22:'ON',23:'HOLIDAY',24:'LEAVE',25:'ON',26:'ON',27:'REST',28:'HOLIDAY',29:'ON',30:'ON',31:'LEAVE'}
  },
  '4A_G2': { // A2 group
    M6:{1:'HOLIDAY',2:'ON',3:'ON',4:'LEAVE',5:'REST',6:'ON',7:'ON',8:'HOLIDAY',9:'LEAVE',10:'ON',11:'ON',12:'REST',13:'HOLIDAY',14:'ON',15:'ON',16:'LEAVE',17:'REST',18:'ON',19:'ON',20:'HOLIDAY',21:'LEAVE',22:'ON',23:'ON',24:'REST',25:'HOLIDAY',26:'ON',27:'ON',28:'LEAVE',29:'REST',30:'ON'},
    M7:{1:'ON',2:'HOLIDAY',3:'LEAVE',4:'ON',5:'ON',6:'LEAVE',7:'HOLIDAY',8:'ON',9:'ON',10:'LEAVE',11:'REST',12:'ON',13:'ON',14:'HOLIDAY',15:'LEAVE',16:'ON',17:'ON',18:'REST',19:'HOLIDAY',20:'ON',21:'ON',22:'LEAVE',23:'REST',24:'ON',25:'ON',26:'HOLIDAY',27:'LEAVE',28:'ON',29:'ON',30:'REST',31:'HOLIDAY'},
    M8:{1:'ON',2:'ON',3:'LEAVE',4:'REST',5:'ON',6:'ON',7:'HOLIDAY',8:'LEAVE',9:'ON',10:'ON',11:'REST',12:'HOLIDAY',13:'ON',14:'ON',15:'LEAVE',16:'REST',17:'ON',18:'ON',19:'HOLIDAY',20:'LEAVE',21:'ON',22:'ON',23:'LEAVE',24:'HOLIDAY',25:'ON',26:'ON',27:'LEAVE',28:'REST',29:'ON',30:'ON',31:'HOLIDAY'}
  },
  '4A_G3': { // A3 group
    M6:{1:'REST',2:'ON',3:'ON',4:'HOLIDAY',5:'LEAVE',6:'ON',7:'ON',8:'LEAVE',9:'HOLIDAY',10:'ON',11:'ON',12:'LEAVE',13:'REST',14:'ON',15:'ON',16:'HOLIDAY',17:'LEAVE',18:'ON',19:'ON',20:'REST',21:'HOLIDAY',22:'ON',23:'ON',24:'LEAVE',25:'REST',26:'ON',27:'ON',28:'HOLIDAY',29:'LEAVE',30:'ON'},
    M7:{1:'ON',2:'REST',3:'HOLIDAY',4:'ON',5:'ON',6:'LEAVE',7:'REST',8:'ON',9:'ON',10:'HOLIDAY',11:'LEAVE',12:'ON',13:'ON',14:'REST',15:'HOLIDAY',16:'ON',17:'ON',18:'LEAVE',19:'REST',20:'ON',21:'ON',22:'HOLIDAY',23:'LEAVE',24:'ON',25:'ON',26:'LEAVE',27:'HOLIDAY',28:'ON',29:'ON',30:'LEAVE',31:'REST'},
    M8:{1:'ON',2:'ON',3:'HOLIDAY',4:'LEAVE',5:'ON',6:'ON',7:'REST',8:'HOLIDAY',9:'ON',10:'ON',11:'LEAVE',12:'REST',13:'ON',14:'ON',15:'HOLIDAY',16:'LEAVE',17:'ON',18:'ON',19:'REST',20:'HOLIDAY',21:'ON',22:'ON',23:'LEAVE',24:'REST',25:'ON',26:'ON',27:'HOLIDAY',28:'LEAVE',29:'ON',30:'ON',31:'LEAVE'}
  },
  '4B_G1': { // C1/X1 group
    M6:{1:'ON',2:'LEAVE',3:'REST',4:'ON',5:'ON',6:'HOLIDAY',7:'LEAVE',8:'ON',9:'ON',10:'REST',11:'HOLIDAY',12:'ON',13:'ON',14:'LEAVE',15:'REST',16:'ON',17:'ON',18:'HOLIDAY',19:'LEAVE',20:'ON',21:'ON',22:'LEAVE',23:'HOLIDAY',24:'ON',25:'ON',26:'LEAVE',27:'REST',28:'ON',29:'ON',30:'HOLIDAY'},
    M7:{1:'LEAVE',2:'ON',3:'ON',4:'REST',5:'HOLIDAY',6:'ON',7:'ON',8:'LEAVE',9:'REST',10:'ON',11:'ON',12:'HOLIDAY',13:'LEAVE',14:'ON',15:'ON',16:'REST',17:'HOLIDAY',18:'ON',19:'ON',20:'LEAVE',21:'REST',22:'ON',23:'ON',24:'HOLIDAY',25:'LEAVE',26:'ON',27:'ON',28:'REST',29:'HOLIDAY',30:'ON',31:'ON'},
    M8:{1:'LEAVE',2:'REST',3:'ON',4:'ON',5:'HOLIDAY',6:'LEAVE',7:'ON',8:'ON',9:'LEAVE',10:'HOLIDAY',11:'ON',12:'ON',13:'LEAVE',14:'REST',15:'ON',16:'ON',17:'HOLIDAY',18:'LEAVE',19:'ON',20:'ON',21:'REST',22:'HOLIDAY',23:'ON',24:'ON',25:'LEAVE',26:'REST',27:'ON',28:'ON',29:'HOLIDAY',30:'LEAVE',31:'ON'}
  },
  '4B_G2': { // C2/X2 group
    M6:{1:'ON',2:'HOLIDAY',3:'LEAVE',4:'ON',5:'ON',6:'REST',7:'HOLIDAY',8:'ON',9:'ON',10:'LEAVE',11:'REST',12:'ON',13:'ON',14:'HOLIDAY',15:'LEAVE',16:'ON',17:'ON',18:'REST',19:'HOLIDAY',20:'ON',21:'ON',22:'LEAVE',23:'REST',24:'ON',25:'ON',26:'HOLIDAY',27:'LEAVE',28:'ON',29:'ON',30:'REST'},
    M7:{1:'HOLIDAY',2:'ON',3:'ON',4:'LEAVE',5:'REST',6:'ON',7:'ON',8:'HOLIDAY',9:'LEAVE',10:'ON',11:'ON',12:'LEAVE',13:'HOLIDAY',14:'ON',15:'ON',16:'LEAVE',17:'REST',18:'ON',19:'ON',20:'HOLIDAY',21:'LEAVE',22:'ON',23:'ON',24:'REST',25:'HOLIDAY',26:'ON',27:'ON',28:'LEAVE',29:'REST',30:'ON',31:'ON'},
    M8:{1:'HOLIDAY',2:'LEAVE',3:'ON',4:'ON',5:'REST',6:'HOLIDAY',7:'ON',8:'ON',9:'LEAVE',10:'REST',11:'ON',12:'ON',13:'HOLIDAY',14:'LEAVE',15:'ON',16:'ON',17:'LEAVE',18:'HOLIDAY',19:'ON',20:'ON',21:'LEAVE',22:'REST',23:'ON',24:'ON',25:'HOLIDAY',26:'LEAVE',27:'ON',28:'ON',29:'REST',30:'HOLIDAY',31:'ON'}
  },
  '4B_G3': { // C3/X3 group
    M6:{1:'ON',2:'REST',3:'HOLIDAY',4:'ON',5:'ON',6:'LEAVE',7:'REST',8:'ON',9:'ON',10:'HOLIDAY',11:'LEAVE',12:'ON',13:'ON',14:'LEAVE',15:'HOLIDAY',16:'ON',17:'ON',18:'LEAVE',19:'REST',20:'ON',21:'ON',22:'HOLIDAY',23:'LEAVE',24:'ON',25:'ON',26:'REST',27:'HOLIDAY',28:'ON',29:'ON',30:'LEAVE'},
    M7:{1:'REST',2:'ON',3:'ON',4:'HOLIDAY',5:'LEAVE',6:'ON',7:'ON',8:'REST',9:'HOLIDAY',10:'ON',11:'ON',12:'LEAVE',13:'REST',14:'ON',15:'ON',16:'HOLIDAY',17:'LEAVE',18:'ON',19:'ON',20:'LEAVE',21:'HOLIDAY',22:'ON',23:'ON',24:'LEAVE',25:'REST',26:'ON',27:'ON',28:'HOLIDAY',29:'LEAVE',30:'ON',31:'ON'},
    M8:{1:'REST',2:'HOLIDAY',3:'ON',4:'ON',5:'LEAVE',6:'REST',7:'ON',8:'ON',9:'HOLIDAY',10:'LEAVE',11:'ON',12:'ON',13:'REST',14:'HOLIDAY',15:'ON',16:'ON',17:'LEAVE',18:'REST',19:'ON',20:'ON',21:'HOLIDAY',22:'LEAVE',23:'ON',24:'ON',25:'REST',26:'HOLIDAY',27:'ON',28:'ON',29:'LEAVE',30:'REST',31:'ON'}
  }
};

// Map each engineer group to its calendar key
// 4A: A1→G1, A2→G2, A3→G3   5A: Z1→G1, Z2→G2, Z3→G3
// 4B: C1→G1, C2→G2, C3→G3   5B: X1→G1, X2→G2, X3→G3
function getCalKey(shift, group){
  const gNum = group.slice(-1); // '1','2','3'
  const base = (shift==='4A'||shift==='5A') ? '4A' : '4B';
  return base+'_G'+gNum;
}

/* ════════════════════════════════════════════════════════
   班表規律推算引擎（2026/9 起、跨年自動生成用）
   規則（已用 2026/6~8 公告資料逐日驗證）：
   1. 做二休二：上 2 天 → 休 2 天，4 天一循環，各組相位錯開
   2. 休日標籤照 LEAVE → REST → HOLIDAY 三循環（各組相位不同）
   3. 不允許連續 7 天上班：HOLIDAY（例假，不可出勤）間距 ≤ 7 天，
      可出勤日（ON/LEAVE/REST）最長連續 6 天 → 推算結果天然合規，
      仍以 checkSevenDayRule() 做硬性檢核
   2026 年 6~8 月有公告行事曆（CAL_2026）→ 用實際資料（含人工微調）；
   其餘月份 → 以 2026/6/1 為錨點推算，Leader / ADMIN 可再微調。
   ════════════════════════════════════════════════════════ */
const CAL_ANCHOR_UTC = Date.UTC(2026, 5, 1);          // 2026/6/1
const OFF_LABEL_CYCLE = ['LEAVE', 'REST', 'HOLIDAY'];

// 由 2026/6 公告資料反推各組相位（啟動時計算一次）
const CAL_PHASES = (() => {
  const phases = {};
  for(const calKey in CAL_2026){
    const jun = CAL_2026[calKey].M6 || {};
    const isOff = d => jun[d] !== 'ON';
    // 工作週期偏移 o：使「(日序+o) mod 4 >= 2 ⇔ 休日」對 6 月 30 天全部成立
    let o = -1;
    for(let c = 0; c < 4; c++){
      let ok = true;
      for(let d = 1; d <= 30; d++){
        if((((d - 1 + c) % 4) >= 2) !== isOff(d)){ ok = false; break; }
      }
      if(ok){ o = c; break; }
    }
    // 標籤相位：取與三循環吻合度最高的相位（公告中的少數人工微調視為例外）
    const offs = [];
    for(let d = 1; d <= 30; d++){ if(isOff(d)) offs.push(jun[d]); }
    let best = 0, bestScore = -1;
    for(let b = 0; b < 3; b++){
      let s = 0;
      offs.forEach((t, i) => { if(t === OFF_LABEL_CYCLE[(b + i) % 3]) s++; });
      if(s > bestScore){ bestScore = s; best = b; }
    }
    phases[calKey] = {o, labelBase: best};
  }
  return phases;
})();

// 推算某組某日的班別（做二休二 + 三循環標籤）
function predictDayType(calKey, year, month0, day){
  const ph = CAL_PHASES[calKey];
  if(!ph || ph.o < 0) return 'ON';
  const n = Math.round((Date.UTC(year, month0, day) - CAL_ANCHOR_UTC) / 86400000);
  const a = n + ph.o;
  const pos = ((a % 4) + 4) % 4;
  if(pos < 2) return 'ON';                       // 上班日
  // 第幾個休日（自錨點起算；offCnt(x) = 週期座標 [0..x] 內休日數，支援負數平移）
  const offCnt = x => {
    const s = x >= 0 ? 0 : Math.ceil(-x / 4) * 4;   // 平移到非負區間（每 4 天恰 2 休）
    const t = x + s;
    return 2 * Math.floor((t + 1) / 4) + Math.max(0, (t + 1) % 4 - 2) - s / 2;
  };
  const offIdx = offCnt(a) - offCnt(ph.o - 1) - 1;
  return OFF_LABEL_CYCLE[(((ph.labelBase + offIdx) % 3) + 3) % 3];
}

// 統一查班別：2026 有公告月份用公告，其餘用推算（含跨年安全）
function getDayTypeFor(calKey, year, month0, day){
  if(year === 2026){
    const mc = (CAL_2026[calKey] || {})['M' + (month0 + 1)];
    if(mc && mc[day] !== undefined) return mc[day];
  }
  return predictDayType(calKey, year, month0, day);
}

// 硬性檢核：不可連續 7 天上班。
// 「上班」= 預設實際出勤日（ON、LEAVE 加班日）；REST / HOLIDAY 皆中斷連續。
// （推算班表另天然滿足更嚴格性質：僅以例假中斷時最長連續亦只有 6 天）
function checkSevenDayRule(types){
  let run = 0;
  for(const t of types){
    run = (t === 'HOLIDAY' || t === 'REST') ? 0 : run + 1;
    if(run >= 7) return false;
  }
  return true;
}

const LOCS_BY_SHIFT={
  '4A':['8F','5F','K21','K25','K18','系統'],
  '5A':['K21','8F','5F','K18','K25','系統'],
  '4B':['K25','K21','8F','5F','K18','系統'],
  '5B':['K18','K25','K21','8F','5F','系統']
};

// ═══ DYNAMIC MONTH SYSTEM ═══
// Auto-generates current month + next 2 months; archives past months for search
// On month rollover (e.g. Jun→Jul), auto-adds the 3rd-ahead month (e.g. Sep)
const AVAIL_MONTHS=[];
let activeMonthIdx=0;

function monthKey(y,m){ return y*100+(m+1); }
function monthLabel(y,m){ return y+'/'+String(m+1).padStart(2,'0'); }  // 例：2026/06

function initMonths(){
  AVAIL_MONTHS.length=0;
  const now=todayNow();
  const curY=now.getFullYear(), curM=now.getMonth();
  // Generate: current month + next 2 months = 3 visible months
  for(let i=0;i<3;i++){
    let mm=curM+i, yy=curY;
    if(mm>11){mm-=12;yy++;}
    AVAIL_MONTHS.push({year:yy, month:mm, label:monthLabel(yy,mm), archived:false});
  }
  // Also add 1 month before current as archived (for history)
  let prevM=curM-1, prevY=curY;
  if(prevM<0){prevM=11;prevY--;}
  // Only add if schedule data could exist
  AVAIL_MONTHS.unshift({year:prevY, month:prevM, label:monthLabel(prevY,prevM), archived:true});
  activeMonthIdx=1; // default to current month
}

function ensureMonthExists(y,m){
  const k=monthKey(y,m);
  if(AVAIL_MONTHS.find(x=>monthKey(x.year,x.month)===k)) return;
  AVAIL_MONTHS.push({year:y, month:m, label:monthLabel(y,m), archived:false});
  AVAIL_MONTHS.sort((a,b)=>monthKey(a.year,a.month)-monthKey(b.year,b.month));
  buildScheduleForMonth(y,m);
}

// 該月是否已有任何排班資料（用來判斷要不要補建預設排班）
function monthHasData(year,month){
  const ymPrefix = year+'-'+String(month+1).padStart(2,'0');
  for(const id in scheduleData){
    const sd = scheduleData[id];
    for(const k in sd){ if(k.indexOf(ymPrefix)===0) return true; }
  }
  return false;
}

// 確保「目前可見的所有月份(AVAIL_MONTHS)」都有排班可顯示。
// 只補「完全沒有資料」的月份（例如尚無檔案的 2026/09）→ 用預設輪值產生，
// 不會覆蓋已從月份檔載入或使用者已編輯過的月份。
function ensureVisibleMonthsBuilt(){
  try{
    if(typeof buildScheduleForMonth!=='function') return;
    AVAIL_MONTHS.forEach(({year,month})=>{
      if(!monthHasData(year,month)) buildScheduleForMonth(year,month);
    });
  }catch(e){ console.warn('ensureVisibleMonthsBuilt failed:', e); }
}

function checkMonthRollover(){
  const now=todayNow();
  const curY=now.getFullYear(), curM=now.getMonth();
  // Ensure current + next 2 months exist
  for(let i=0;i<3;i++){
    let mm=curM+i, yy=curY;
    if(mm>11){mm-=12;yy++;}
    ensureMonthExists(yy,mm);
  }
  // Archive months older than current
  const curKey=monthKey(curY,curM);
  AVAIL_MONTHS.forEach(m=>{
    if(monthKey(m.year,m.month)<curKey) m.archived=true;
    else m.archived=false;
  });
  renderMonthButtons();
}

function renderMonthButtons(){
  const container=document.getElementById('month-btns');
  const archive=document.getElementById('month-archive');
  if(!container)return;

  const now=todayNow();
  const curKey=monthKey(now.getFullYear(),now.getMonth());
  // 由新到舊排序（越新的月份排越前面 / 最上）
  const byNewest=(a,b)=>monthKey(b.year,b.month)-monthKey(a.year,a.month);
  // Active months: current + future（降冪）
  const active=AVAIL_MONTHS.filter(m=>!m.archived).sort(byNewest);
  // Archived months（降冪）
  const archived=AVAIL_MONTHS.filter(m=>m.archived).sort(byNewest);

  // Render active month buttons
  container.innerHTML='';
  active.forEach(m=>{
    const idx=AVAIL_MONTHS.indexOf(m);
    const isCurrent=monthKey(m.year,m.month)===curKey;
    const btn=document.createElement('button');
    btn.className='topbar-btn';
    btn.style.cssText='padding:4px 10px;font-size:11px;border-radius:6px;font-weight:700';
    if(idx===activeMonthIdx) btn.classList.add('month-active');
    btn.textContent=m.label;                 // 例：2026/06
    if(isCurrent) btn.textContent+='★';       // 標示「本月」
    btn.onclick=()=>switchMonthByIdx(idx);
    container.appendChild(btn);
  });

  // Render archive dropdown
  if(archived.length>0){
    archive.style.display='';
    archive.innerHTML='<option value="" disabled selected>歷史月份</option>';
    archived.forEach(m=>{
      const idx=AVAIL_MONTHS.indexOf(m);
      const opt=document.createElement('option');
      opt.value=idx;
      opt.textContent=m.label+'（封存）';
      archive.appendChild(opt);
    });
  } else {
    archive.style.display='none';
  }
}

function switchMonthByIdx(idx){
  idx=parseInt(idx);
  if(idx<0||idx>=AVAIL_MONTHS.length)return;
  activeMonthIdx=idx;
  calYear=AVAIL_MONTHS[idx].year;
  calMonth=AVAIL_MONTHS[idx].month;
  ensureVisibleMonthsBuilt();   // 若該月尚無資料（如剛出現的 2026/09）→ 即時補建預設排班
  renderMonthButtons();
  updateMonthLabels();
  buildDashboard();
  renderSchedule();
  renderCalendar();
  renderPersonnel();
  renderAnalysis();
  const m=AVAIL_MONTHS[idx];
  showToast(m.label+(m.archived?' （封存回溯）':'')+' 班表已切換','info');
}

// Keep backward compat
function switchMonth(m){
  const idx=AVAIL_MONTHS.findIndex(x=>x.month===m-1);
  if(idx>=0) switchMonthByIdx(idx);
}


function buildScheduleForMonth(year, month){
  const mStr = String(month + 1).padStart(2, '0');
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  engineers.forEach((eng, ei) => {
    if(!isPersonActiveInMonth(eng, year, month)) return;

    if(!scheduleData[eng.id]){
      scheduleData[eng.id] = {};
    }

    const isMaint = !!(eng.isMaintenance || eng.title === '保養組');
    const calKey = getCalKey(eng.shift, eng.group);
    const locs = LOCS_BY_SHIFT[eng.shift] || ['5F'];
    const monthTypes = [];
    let madeNew = 0;

    for(let d = 1; d <= daysInMonth; d++){
      const key = year + '-' + mStr + '-' + String(d).padStart(2, '0');

      if(scheduleData[eng.id][key]){            // 已有資料（載入或編輯過）→ 不覆蓋
        monthTypes.push(scheduleData[eng.id][key].type);
        continue;
      }

      // 保養組與一般人員同用「roster 班別/組別 + 做二休二引擎」計算，
      // 僅工作地點區別：保養組固定 KE（KEEPER）
      const t = getDayTypeFor(calKey, year, month, d);
      const loc = isMaint ? 'KE' : locs[(ei + d) % locs.length];
      monthTypes.push(t);
      madeNew++;

      scheduleData[eng.id][key] = {
        type: t,
        loc,
        leave: 0,
        ot: t === 'LEAVE' ? 1 : 0
      };
    }

    // 七休一硬性檢核（只審核本次有新生成的月份；推算結果應天然合規）
    if(madeNew > 0 && !checkSevenDayRule(monthTypes)){
      console.warn('⚠️ 七休一檢核未通過：', eng.id, year + '/' + (month + 1));
    }
  });
}

initMonths();

let engineers=[];   // 正式名單由伺服器載入（月份檔 + data/<site>/roster.json）
let scheduleData={};
let deleteIdx=-1;
function ymFromYearMonth(year, month){
  return String(year) + String(month + 1).padStart(2, '0');
}

function ymFromDateKey(dateKey){
  if(!dateKey || dateKey.length < 7) return '';
  return dateKey.slice(0, 4) + dateKey.slice(5, 7);
}

function isPersonActiveInMonth(eng, year, month){
  if(!eng) return false;

  const ym = ymFromYearMonth(year, month);
  const inactiveFromYm = String(eng.inactiveFromYm || '').trim();

  if(inactiveFromYm && ym >= inactiveFromYm){
    return false;
  }

  return true;
}

function activeEngineersForMonth(year, month){
  return engineers.filter(e => isPersonActiveInMonth(e, year, month));
}

function getCurrentMonthActiveEngineers(){
  const cur = AVAIL_MONTHS[activeMonthIdx];

  if(!cur){
    return engineers;
  }

  return activeEngineersForMonth(cur.year, cur.month);
}

function removeScheduleFromYm(id, fromYm){
  if(!id || !fromYm || !scheduleData[id]) return;

  Object.keys(scheduleData[id]).forEach(dateKey => {
    const ym = ymFromDateKey(dateKey);

    if(ym && ym >= fromYm){
      delete scheduleData[id][dateKey];
    }
  });

  if(Object.keys(scheduleData[id]).length === 0){
    delete scheduleData[id];
  }
}

function fillDeleteMonthOptions(){
  const sel = document.getElementById('del-from-month');
  if(!sel) return;

  sel.innerHTML = '';

  const months = [...AVAIL_MONTHS].sort((a, b) =>
    monthKey(a.year, a.month) - monthKey(b.year, b.month)
  );

  months.forEach(m => {
    const ym = ymFromYearMonth(m.year, m.month);
    const opt = document.createElement('option');

    opt.value = ym;
    opt.textContent = m.label + (m.archived ? '（歷史）' : '');

    sel.appendChild(opt);
  });

  const cur = AVAIL_MONTHS[activeMonthIdx] || months[0];

  if(cur){
    sel.value = ymFromYearMonth(cur.year, cur.month);
  }
}

let calYear=2026,calMonth=5;

/* 全量重建：清空後對所有可見月份逐月生成（公告月用公告、其餘用推算） */
function buildSchedule(){
  scheduleData = {};
  AVAIL_MONTHS.forEach(({year, month}) => buildScheduleForMonth(year, month));
}
buildSchedule();
// initLoadData() will be called in DOMContentLoaded instead of lsLoad

/* Get stats for active month */
function getMonthStats(id){
  const {year,month}=AVAIL_MONTHS[activeMonthIdx];
  const daysInMonth=new Date(year,month+1,0).getDate();
  let ot=0,on=0,total=0;
  for(let d=1;d<=daysInMonth;d++){
    const key=year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const s=(scheduleData[id]||{})[key];
    if(s){
      if(s.type==='ON'){on++;total++;}
      if(s.ot){ot++;}
      if(s.type==='LEAVE')total++;
    }
  }
  return {ot,on,total};
}

/* helpers */
function dStr(d){
  // 使用本地時區年月日，避免 toISOString() 在 UTC+N 時區造成日期偏移 1 天
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+dd;
}
function todayNow(){return new Date();}

const PAGE_NAMES={dashboard:'Dashboard',schedule:'排班管理',calendar:'排班行事曆',personnel:'人員管理',analysis:'出勤分析',settings:'系統設定'};
const DAY_ZH=['日','一','二','三','四','五','六'];

/* ── MONTH SWITCH ── */
function switchMonth(m){
  // m = 6,7,8
  const idx=AVAIL_MONTHS.findIndex(x=>x.month===m-1);
  if(idx<0)return;
  activeMonthIdx=idx;
  // Update active button style
  [6,7,8].forEach(n=>{
    const btn=document.getElementById('mb-'+n);
    if(btn)btn.classList.toggle('month-active',n===m);
  });
  // Sync calendar to this month
  calYear=AVAIL_MONTHS[idx].year;
  calMonth=AVAIL_MONTHS[idx].month;
  updateMonthLabels();
  // Refresh all pages that depend on month
  buildDashboard();
  renderSchedule();
  renderCalendar();
  renderPersonnel();
  renderAnalysis();
  showToast(AVAIL_MONTHS[idx].label+' 班表已切換','info');
}

function updateMonthLabels(){
  const lbl=AVAIL_MONTHS[activeMonthIdx].label;
  const el=document.getElementById('topbar-date-label');
  if(el)el.textContent=lbl;
  const dashSub=document.getElementById('dash-sub-label');
  if(dashSub)dashSub.textContent='營運組 · '+lbl+' 值班排班統計';
  const schTitle=document.getElementById('sch-page-title');
  if(schTitle)schTitle.textContent=lbl.replace('年','年').replace('月','月')+'排班表';
  const schTableTitle=document.getElementById('sch-table-title');
  if(schTableTitle){const {month}=AVAIL_MONTHS[activeMonthIdx];const daysInMonth=new Date(AVAIL_MONTHS[activeMonthIdx].year,month+1,0).getDate();schTableTitle.textContent=(month+1)+'月班表（1–'+daysInMonth+'日）';}
  const schSub=document.getElementById('sch-page-sub');
  if(schSub)schSub.textContent='營運組 · '+lbl+' 出勤預排表';
  const anSub=document.getElementById('an-page-sub');
  if(anSub)anSub.textContent=lbl+' 營運組出勤統計報表';
  const calTitle=document.getElementById('cal-month-title');
  if(calTitle)calTitle.textContent=lbl+'排班行事曆';
  renderMonthButtons();
}

/* ── clock & date tracker ── */
let _lastDateStr='';
let _lastShift=''; // 記錄上次刷新時的班別，用於偵測班別切換時自動更新
function tickClock(){
  const n=new Date();
  const dateStr=[n.getFullYear(),(n.getMonth()+1),(n.getDate())].map((v,i)=>i===0?v:String(v).padStart(2,'0')).join('/');
  const timeStr=[n.getHours(),n.getMinutes(),n.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
  document.getElementById('clock-display').textContent=dateStr+' '+timeStr;
  document.getElementById('last-update').textContent=n.toLocaleTimeString('zh-TW',{hour12:false});
  // Cross-day detection: rebuild dashboard stats when date changes
  const nowDateStr=dStr(n);
  if(_lastDateStr && _lastDateStr!==nowDateStr){
    checkMonthRollover(); // auto-generate new months if needed
    buildDashboard(); // refresh today's on/ot/leave counts
    showToast('日期已更新：'+nowDateStr,'info');
  }
  _lastDateStr=nowDateStr;
  // Cross-shift detection: rebuild dashboard when crossing 07:31 / 19:31 boundary
  const nowShift=getCurrentShiftByTime();
  if(_lastShift && _lastShift!==nowShift){
    buildDashboard();
    showToast('班別切換：'+(nowShift==='DAY'?'早班 4A/4B':'夜班 5A/5B'),'info');
  }
  _lastShift=nowShift;
}
setInterval(tickClock,1000);tickClock();

/* ── sidebar ── */
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('collapsed');}

let _navigatingPage = false;

async function navigate(page, btn){
  if(_navigatingPage) return;

  // ENG 權限阻擋：人員管理 / 系統設定
  if(!isLeader() && (page === 'personnel' || page === 'settings')){
    showToast(
      '⚠️ ' + (page === 'personnel' ? '人員管理' : '系統設定') + ' 僅 Leader 可預覽',
      'warning'
    );
    return;
  }

  _navigatingPage = true;

  try{
    // 1. 先切換頁面顯示
    document.querySelectorAll('.page').forEach(p => {
      p.classList.remove('active');
    });

    const targetPage = document.getElementById('page-' + page);
    if(targetPage){
      targetPage.classList.add('active');
    }

    // 2. sidebar active 樣式
    document.querySelectorAll('.nav-item-btn').forEach(b => {
      b.classList.remove('active');
    });

    if(btn){
      btn.classList.add('active');
    }

    // 3. topbar 頁面名稱
    const topName = document.getElementById('topbar-page-name');
    if(topName){
      topName.textContent = PAGE_NAMES[page] || page;
    }

    // 4. 顯示重新載入狀態
    const saveInd = document.getElementById('save-indicator');
    if(saveInd){
      saveInd.textContent = '重新載入中...';
      saveInd.style.color = 'var(--warning)';
    }

    // 5. 每次切換 sidebar 都重新向後端撈目前站台資料
    let reloadOk = false;

    if(typeof reloadCurrentSiteDataFromServer === 'function'){
      reloadOk = await reloadCurrentSiteDataFromServer();
    }else{
      console.warn('找不到 reloadCurrentSiteDataFromServer()，改用目前記憶體資料渲染');
    }

    // 6. 依照頁面重新渲染
    if(page === 'dashboard'){
      buildDashboard();
    }

    if(page === 'schedule'){
      renderSchedule();
    }

    if(page === 'calendar'){
      renderCalendar();
    }

    if(page === 'personnel'){
      renderPersonnel();
    }

    if(page === 'analysis'){
      renderAnalysis();
    }

    if(page === 'settings'){
      renderRoleBindings();
    }

    // 7. 更新狀態
    if(saveInd){
      if(reloadOk){
        saveInd.textContent = '已同步';
        saveInd.style.color = 'var(--success)';
      }else{
        saveInd.textContent = '使用目前資料';
        saveInd.style.color = 'var(--warning)';
      }
    }

  }catch(e){
    console.error('navigate failed:', e);
    showToast('切換頁面失敗：' + (e.message || e), 'danger');

  }finally{
    _navigatingPage = false;
  }
}


/* ── toast ── */


function showToast(msg, type = 'info'){
  // 相容舊寫法：以前有些地方會傳 error，但 CSS / icon 是 danger
  const typeMap = {
    success: 'success',
    info: 'info',
    danger: 'danger',
    error: 'danger',
    warning: 'warning',
    warn: 'warning'
  };

  const finalType = typeMap[type] || 'info';

  const icons = {
    success: 'bi-check-circle-fill',
    info: 'bi-info-circle-fill',
    danger: 'bi-x-circle-fill',
    warning: 'bi-exclamation-triangle-fill'
  };

  const labels = {
    success: '成功',
    info: '提示',
    danger: '錯誤',
    warning: '警告'
  };

  const c = document.getElementById('toast-container');

  if(!c){
    console.warn('[showToast] 找不到 #toast-container：', msg);
    return;
  }

  let safeMsg = '';

  try{
    if(msg == null){
      safeMsg = '';
    }else if(typeof msg === 'object'){
      safeMsg = JSON.stringify(msg);
    }else{
      safeMsg = String(msg);
    }
  }catch(e){
    safeMsg = String(msg || '');
  }

  // 避免訊息內有 HTML 造成畫面錯亂
  safeMsg = safeMsg.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));

  const el = document.createElement('div');

  el.className = 'toast-item toast-' + finalType;

  el.innerHTML =
    '<div class="toast-icon">' +
      '<i class="bi ' + icons[finalType] + '"></i>' +
    '</div>' +
    '<div>' +
      '<div style="font-weight:700;font-size:12px;color:var(--text-muted)">' +
        labels[finalType] +
      '</div>' +
      '<div>' + safeMsg + '</div>' +
    '</div>';

  c.appendChild(el);

  setTimeout(() => {
    try{
      el.remove();
    }catch(e){}
  }, 3200);
}


function getCurrentMonthPersonCountText(){
  const historyCount = Array.isArray(engineers) ? engineers.length : 0;

  let activeCount = historyCount;
  let monthLabel = '';

  try{
    const cur = AVAIL_MONTHS[activeMonthIdx];

    if(cur){
      monthLabel = cur.label || (cur.year + '/' + String(cur.month + 1).padStart(2, '0'));

      if(typeof activeEngineersForMonth === 'function'){
        activeCount = activeEngineersForMonth(cur.year, cur.month).length;
      }
    }
  }catch(e){
    activeCount = historyCount;
  }

  if(monthLabel){
    return monthLabel + ' 有效 ' + activeCount + ' 人';
  }

  return activeCount + ' 人';
}

/* ── 最後修改時間 UI 更新 ── */
function refreshLastModifiedUI(){
  const tEl  = document.getElementById('dash-last-modified');
  const byEl = document.getElementById('dash-last-modified-by');
  if(!tEl || !byEl) return;
  const info = _lastModifiedInfo;
  if(info && info.savedAt){
    let d;
    try{ d = new Date(info.savedAt); }catch(e){ d = null; }
    if(d && !isNaN(d)){
      const pad=n=>String(n).padStart(2,'0');
      tEl.textContent = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
    }else{
      tEl.textContent = info.savedAt;
    }
    byEl.textContent = info.savedBy || '未知';
  }else{
    tEl.textContent  = '尚未有任何修改';
    byEl.textContent = '—';
  }
  // 同步更新右下角 footer
  const lu = document.getElementById('last-update');
  if(lu) lu.textContent = tEl.textContent;
}

/* ── DASHBOARD ── */
const COLORS_SHIFT={
  '4A':'rgba(0,212,255,.75)','5A':'rgba(0,255,136,.75)',
  '4B':'rgba(123,94,167,.75)','5B':'rgba(255,165,2,.75)'
};
const SHIFT_LABEL_COLORS={
  '4A':'#0095b3','5A':'#008f5b','4B':'#6a4f8c','5B':'#b37400'
};
const GROUPS_ALL=['A1','A2','A3','Z1','Z2','Z3','C1','C2','C3','X1','X2','X3'];
// Which shift each group belongs to (for label row under bar chart)
const GROUP_SHIFT={'A1':'4A','A2':'4A','A3':'4A','Z1':'5A','Z2':'5A','Z3':'5A','C1':'4B','C2':'4B','C3':'4B','X1':'5B','X2':'5B','X3':'5B'};
let _charts={};


function buildDashboard(){
  refreshLastModifiedUI();
  refreshLockStatus();

  const todayKey = dStr(todayNow());
  const dashboardEngineers = getCurrentMonthActiveEngineers();

  const SHIFTS = ['4A','4B','5A','5B'];

  const stat = {
    on:    {'4A':0,'4B':0,'5A':0,'5B':0},
    ot:    {'4A':0,'4B':0,'5A':0,'5B':0},
    leave: {'4A':0,'4B':0,'5A':0,'5B':0}
  };

  const leavePeople = [];

  dashboardEngineers.forEach(eng => {
    const sh = eng.shift;

    if(!SHIFTS.includes(sh)) return;

    const s = (scheduleData[eng.id] || {})[todayKey];

    if(!s) return;

    if(s.type === 'ON' && !s.leave){
      stat.on[sh]++;
    }

    if(s.ot){
      stat.ot[sh]++;
    }

    if(s.leave){
      stat.leave[sh]++;
      leavePeople.push({
        name: eng.name,
        isTmp: !!s.leaveTemp,
        shift: sh
      });
    }
  });

  const onDay = stat.on['4A'] + stat.on['4B'];
  const onNight = stat.on['5A'] + stat.on['5B'];
  const otDay = stat.ot['4A'] + stat.ot['4B'];
  const otNight = stat.ot['5A'] + stat.ot['5B'];
  const leaveDay = stat.leave['4A'] + stat.leave['4B'];
  const leaveNight = stat.leave['5A'] + stat.leave['5B'];

  const onTotal = onDay + onNight;
  const otTotal = otDay + otNight;
  const leaveTotal = leaveDay + leaveNight;

  const currentShift = getCurrentShiftByTime();
  const useOn = currentShift === 'DAY' ? onDay : onNight;
  const useOt = currentShift === 'DAY' ? otDay : otNight;
  const useLeave = currentShift === 'DAY' ? leaveDay : leaveNight;

  const denom = useOn + useOt;
  const numer = Math.max(0, denom - useLeave);
  const rate = denom > 0 ? Math.round(numer / denom * 100) + '%' : '—';

  const tag = document.getElementById('stat-attend-shift-tag');

  if(tag){
    if(currentShift === 'DAY'){
      tag.textContent = '早班 4A/4B';
      tag.style.background = 'rgba(0,212,255,.15)';
      tag.style.color = '#0095b3';
    }else{
      tag.textContent = '夜班 5A/5B';
      tag.style.background = 'rgba(123,94,167,.18)';
      tag.style.color = '#6a4f8c';
    }
  }

  const attendRate = document.getElementById('stat-attend-rate');
  if(attendRate) attendRate.textContent = rate;

  const attendFormula = document.getElementById('stat-attend-formula');
  if(attendFormula){
    attendFormula.textContent = `${numer} ÷ ${denom}（當班${useOn}+加班${useOt}−請假${useLeave}）`;
  }

  const totalEl = document.getElementById('stat-total');
  if(totalEl){
    totalEl.textContent = dashboardEngineers.length;
  }

  const totalSubEl = document.getElementById('stat-total-sub');
  if(totalSubEl){
    const maintCount = dashboardEngineers.filter(e => e.title === '保養組').length;
    const mainCount = dashboardEngineers.length - maintCount;
    totalSubEl.textContent = '主班 ' + mainCount + ' 人 + 保養組 ' + maintCount + ' 人';
  }

  const statOnduty = document.getElementById('stat-onduty');
  if(statOnduty) statOnduty.textContent = onTotal;

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if(el) el.textContent = val;
  };

  setTxt('stat-onduty-4A', stat.on['4A']);
  setTxt('stat-onduty-4B', stat.on['4B']);
  setTxt('stat-onduty-5A', stat.on['5A']);
  setTxt('stat-onduty-5B', stat.on['5B']);
  setTxt('stat-onduty-day', onDay);
  setTxt('stat-onduty-night', onNight);

  setTxt('stat-ot', otTotal);
  setTxt('stat-ot-4A', stat.ot['4A']);
  setTxt('stat-ot-4B', stat.ot['4B']);
  setTxt('stat-ot-5A', stat.ot['5A']);
  setTxt('stat-ot-5B', stat.ot['5B']);
  setTxt('stat-ot-day', otDay);
  setTxt('stat-ot-night', otNight);

  setTxt('stat-leave', leaveTotal);
  setTxt('stat-leave-4A', stat.leave['4A']);
  setTxt('stat-leave-4B', stat.leave['4B']);
  setTxt('stat-leave-5A', stat.leave['5A']);
  setTxt('stat-leave-5B', stat.leave['5B']);
  setTxt('stat-leave-day', leaveDay);
  setTxt('stat-leave-night', leaveNight);

  const leaveNamesEl = document.getElementById('stat-leave-names');

  if(leaveNamesEl){
    if(leavePeople.length === 0){
      leaveNamesEl.innerHTML = '<span style="color:var(--accent3)">今日無請假</span>';
    }else{
      leaveNamesEl.innerHTML = leavePeople.map(p => {
        const isDay = p.shift === '4A' || p.shift === '4B';
        const shiftColor = isDay ? '#0095b3' : '#6a4f8c';
        const shiftBg = isDay ? 'rgba(0,212,255,.15)' : 'rgba(123,94,167,.18)';

        return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:6px">
          <span style="background:${shiftBg};color:${shiftColor};border-radius:3px;padding:0 4px;font-size:9px;font-weight:700">${p.shift}</span>
          ${p.name}
          ${p.isTmp ? '<span style="background:rgba(255,165,2,.2);color:#b37400;border-radius:3px;padding:0 4px;font-size:9px;font-weight:700">臨請</span>' : ''}
        </span>`;
      }).join('');
    }
  }

  const shiftCounts = {'4A':0,'5A':0,'4B':0,'5B':0};

  dashboardEngineers.forEach(e => {
    shiftCounts[e.shift] = (shiftCounts[e.shift] || 0) + 1;
  });

  const sc4A = shiftCounts['4A'];
  const sc5A = shiftCounts['5A'];
  const sc4B = shiftCounts['4B'];
  const sc5B = shiftCounts['5B'];

  _buildChart('ch-pie','doughnut',{
    labels:[`4A班 (${sc4A}人)`,`5A班 (${sc5A}人)`,`4B班 (${sc4B}人)`,`5B班 (${sc5B}人)`],
    datasets:[{
      data:[sc4A,sc5A,sc4B,sc5B],
      backgroundColor:['rgba(0,212,255,.75)','rgba(0,255,136,.75)','rgba(123,94,167,.75)','rgba(255,165,2,.75)'],
      borderWidth:2,
      borderColor:'#fff'
    }]
  },{
    cutout:'58%',
    plugins:{
      legend:{labels:{font:{size:11},color:'#6b7280',padding:12}},
      tooltip:{callbacks:{label:ctx=>` ${ctx.label}: ${ctx.raw} 人`}}
    }
  });

  const gCounts = GROUPS_ALL.map(g =>
    dashboardEngineers.filter(e => e.group === g).length
  );

  const gColors = [
    'rgba(0,212,255,.6)','rgba(0,212,255,.6)','rgba(0,212,255,.6)',
    'rgba(0,255,136,.6)','rgba(0,255,136,.6)','rgba(0,255,136,.6)',
    'rgba(123,94,167,.6)','rgba(123,94,167,.6)','rgba(123,94,167,.6)',
    'rgba(255,165,2,.6)','rgba(255,165,2,.6)','rgba(255,165,2,.6)'
  ];

  _buildChart('ch-bar','bar',{
    labels:GROUPS_ALL,
    datasets:[{
      label:'人數',
      data:gCounts,
      backgroundColor:gColors,
      borderRadius:6,
      borderSkipped:false
    }]
  },{
    scales:{
      x:{grid:{display:false}},
      y:{min:0,max:8,ticks:{stepSize:2}}
    },
    plugins:{
      legend:{display:false},
      tooltip:{callbacks:{label:ctx=>`${ctx.raw} 人`}}
    }
  });

  const lblRow = document.getElementById('ch-bar-shift-labels');

  if(lblRow){
    const shiftGroups = [
      {shift:'4A',groups:'A1 A2 A3',color:SHIFT_LABEL_COLORS['4A'],bg:'rgba(0,212,255,.08)'},
      {shift:'5A',groups:'Z1 Z2 Z3',color:SHIFT_LABEL_COLORS['5A'],bg:'rgba(0,255,136,.08)'},
      {shift:'4B',groups:'C1 C2 C3',color:SHIFT_LABEL_COLORS['4B'],bg:'rgba(123,94,167,.08)'},
      {shift:'5B',groups:'X1 X2 X3',color:SHIFT_LABEL_COLORS['5B'],bg:'rgba(255,165,2,.08)'}
    ];

    lblRow.innerHTML = shiftGroups.map(s => `
      <div style="text-align:center;padding:5px 10px;border-radius:6px;background:${s.bg};flex:1;margin:0 4px">
        <div style="font-size:11px;font-weight:700;color:${s.color}">${s.shift}班</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:1px">${s.groups}</div>
        <div style="font-size:10px;font-weight:700;color:var(--text-dark);margin-top:2px">${shiftCounts[s.shift]}人</div>
      </div>
    `).join('');
  }

  const sortedOT = [...dashboardEngineers]
    .map(e => ({name:e.name, ot:getMonthStats(e.id).ot}))
    .sort((a,b) => b.ot - a.ot)
    .slice(0,10);

  _buildChart('ch-ot','bar',{
    labels:sortedOT.map(e => e.name),
    datasets:[{
      label:'OT次數',
      data:sortedOT.map(e => e.ot),
      backgroundColor:'rgba(123,94,167,.65)',
      borderRadius:6,
      borderSkipped:false
    }]
  },{
    indexAxis:'y',
    scales:{
      x:{min:0,max:10,ticks:{stepSize:2}},
      y:{grid:{display:false}}
    },
    plugins:{legend:{display:false}}
  });

  const tl = document.getElementById('today-list');

  if(tl){
    tl.innerHTML = '';

    let listKey = todayKey;

    const anyHasToday = dashboardEngineers.some(e => (scheduleData[e.id] || {})[todayKey]);

    if(!anyHasToday){
      const {year, month} = AVAIL_MONTHS[activeMonthIdx];
      listKey = year + '-' + String(month + 1).padStart(2, '0') + '-01';
    }

    const activeList = dashboardEngineers.filter(e => {
      const s = (scheduleData[e.id] || {})[listKey];
      return s && ((s.type === 'ON' && !s.leave) || s.ot);
    });

    if(activeList.length === 0){
      tl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">當日無出勤記錄</div>';
    }else{
      activeList.forEach(e => {
        const s = (scheduleData[e.id] || {})[listKey];
        const isOt = !!s.ot;
        const otBadge = isOt
          ? `<span style="background:rgba(123,94,167,.2);color:#6a4f8c;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-right:4px">OT</span>`
          : '';

        tl.innerHTML += `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
          <div class="tbl-avatar-placeholder" style="${isOt ? 'background:linear-gradient(135deg,var(--accent2),#9b59b6)' : ''}">${e.name[0]}</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">${e.name} ${otBadge}</div>
            <div style="font-size:11px;color:var(--text-muted)">${e.id} · ${e.shift}/${e.group}</div>
          </div>
          <span class="badge-shift shift-${e.shift}" style="font-size:10px">${e.shift}</span>
          <span style="font-size:11px;color:var(--text-muted)">${s ? s.loc : ''}</span>
        </div>`;
      });
    }
  }
}

function _buildChart(id,type,data,extraOpts={}){
  const ctx=document.getElementById(id).getContext('2d');
  if(_charts[id]){_charts[id].destroy();}
  const base={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:'#6b7280'}}}};
  const scaleBase={x:{ticks:{font:{size:10},color:'#6b7280'},grid:{color:'rgba(0,0,0,.04)'}},y:{ticks:{font:{size:10},color:'#6b7280'},grid:{color:'rgba(0,0,0,.04)'}}};
  const opts={...base,...extraOpts};
  if(!opts.scales&&(type==='bar'||type==='line'))opts.scales=scaleBase;
  _charts[id]=new Chart(ctx,{type,data,options:opts});
}

/* ── SCHEDULE TABLE ── */
const TYPE_LABEL={ON:'當班',REST:'休息',LEAVE:'休假',HOLIDAY:'例假'};
const TYPE_CHIP={ON:'chip-ON',REST:'chip-REST',LEAVE:'chip-LEAVE',HOLIDAY:'chip-HOLIDAY'};

// ★ Group color map — each group has its OWN unique color within its shift family
const GROUP_STYLE={
  // 4A shift → A groups: Blue family, each distinct
  A1:'background:#dbeafe;color:#1d4ed8;border:2.5px solid #3b82f6',  // 亮藍
  A2:'background:#e0f2fe;color:#0369a1;border:2.5px solid #0ea5e9',  // 天藍
  A3:'background:#cffafe;color:#0e7490;border:2.5px solid #06b6d4',  // 青藍
  // 5A shift → Z groups: Green family, each distinct
  Z1:'background:#d1fae5;color:#047857;border:2.5px solid #10b981',  // 翡翠綠
  Z2:'background:#dcfce7;color:#15803d;border:2.5px solid #22c55e',  // 草綠
  Z3:'background:#ecfccb;color:#4d7c0f;border:2.5px solid #84cc16',  // 黃綠
  // 4B shift → C groups: Purple family, each distinct
  C1:'background:#ede9fe;color:#6d28d9;border:2.5px solid #8b5cf6',  // 紫色
  C2:'background:#fae8ff;color:#a21caf;border:2.5px solid #d946ef',  // 洋紅紫
  C3:'background:#fce7f3;color:#be185d;border:2.5px solid #ec4899',  // 粉紫
  // 5B shift → X groups: Orange family, each distinct
  X1:'background:#ffedd5;color:#c2410c;border:2.5px solid #f97316',  // 橘色
  X2:'background:#fef3c7;color:#a16207;border:2.5px solid #eab308',  // 金黃
  X3:'background:#fef9c3;color:#854d0e;border:2.5px solid #ca8a04',  // 琥珀
};
function grpStyle(g){ return GROUP_STYLE[g]||'background:#f1f5f9;color:#475569;border:1px solid #cbd5e1'; }

// Location color groups per user spec
const LOC_COLOR_MAP={
  '5F':'#1d4ed8','8F':'#1d4ed8',
  'K21':'#b45309',
  'K25':'#0e7490',
  'K18':'#7c3aed',
  '系統':'#047857',
  'KE':'#92400e',  // 保養組 - 深咖啡
};
const LOC_BG_MAP={
  '5F':'#dbeafe','8F':'#dbeafe',
  'K21':'#fef3c7',
  'K25':'#cffafe',
  'K18':'#ede9fe',
  '系統':'#d1fae5',
  'KE':'#fed7aa',  // 保養組 - 淺橘
};
function getLocColor(loc){
  if(!loc) return '#6b7280';
  const k=loc.toString().trim();
  if(LOC_COLOR_MAP[k]) return LOC_COLOR_MAP[k];
  for(const [key,val] of Object.entries(LOC_COLOR_MAP)){if(k.includes(key))return val;}
  return '#be123c';
}
function getLocBg(loc){
  if(!loc) return 'transparent';
  const k=loc.toString().trim();
  if(LOC_BG_MAP[k]) return LOC_BG_MAP[k];
  for(const [key,val] of Object.entries(LOC_BG_MAP)){if(k.includes(key))return val;}
  return '#ffe4e6';
}

/* ── Dashboard → click stat card → roster ── */
function openDashRoster(filterType){
  initRosterModal();
  const todayKey=dStr(todayNow());
  const [y,m,d]=todayKey.split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const dowZh=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][dt.getDay()];
  const titleMap={ON:'今日當班名單',OT:'今日加班（OT）名單',LEAVE:'今日請假名單'};
  document.getElementById('roster-date').textContent=parseInt(y)+'年'+parseInt(m)+'月'+parseInt(d)+'日';
  document.getElementById('roster-dow').textContent=dowZh+'　'+titleMap[filterType];

  const body=document.getElementById('roster-body');

  function buildFiltered(label,shifts,colorClass,icon){
    const groupBuckets={};
    let total=0;
    engineers.forEach(eng=>{
      if(!shifts.includes(eng.shift))return;
      const s=(scheduleData[eng.id]||{})[todayKey];
      if(!s)return;
      let show=false;
      if(filterType==='ON' && s.type==='ON' && !s.leave) show=true;
      if(filterType==='OT' && s.ot) show=true;
      if(filterType==='LEAVE' && s.leave) show=true;
      if(!show)return;
      total++;
      const k=eng.shift+'/'+eng.group;
      (groupBuckets[k]=groupBuckets[k]||[]).push({eng,s});
    });
    const groupKeys=Object.keys(groupBuckets).sort();
    let inner='';
    if(!groupKeys.length){
      inner=`<div class="roster-empty">當日無${label}${titleMap[filterType].replace('今日','').replace('名單','')}</div>`;
    } else {
      groupKeys.forEach(gk=>{
        inner+=`<div class="roster-group-row"><div class="roster-group-label">${gk}（${groupBuckets[gk].length}人）</div>`;
        groupBuckets[gk].forEach(({eng,s})=>{
          const isLeave=!!s.leave;
          const isOt=!!s.ot;
          const isTmp=isLeave&&s.leaveTemp;
          const cls=isLeave?'leave':(isOt?'ot':'');
          const badge=isTmp?'<span style="color:#b37400;font-weight:700">臨</span>':(isLeave?'<span style="color:#0095b3;font-weight:700">假</span>':(isOt?'<span style="color:#6a4f8c;font-weight:700">OT</span>':''));
          const lc=getLocColor(s.loc);
          inner+=`<span class="roster-person ${cls}">${badge}${eng.name}<span style="color:${lc};font-size:10px;font-weight:700;margin-left:4px">${s.loc||''}</span></span>`;
        });
        inner+='</div>';
      });
    }
    return `<div class="roster-shift-section">
      <div class="roster-shift-header ${colorClass}">
        <i class="bi ${icon}"></i>${label}
        <span style="font-size:11px;font-weight:500;opacity:.7">（${shifts.join(' / ')}）</span>
        <span class="roster-count-badge">${total} 人</span>
      </div>
      ${inner}
    </div>`;
  }

  body.innerHTML='<input type="hidden" id="roster-hidden-date" value="'+todayKey+'">'
    +buildFiltered('早班',['4A','4B'],'day','bi-sun-fill')
    +buildFiltered('晚班',['5A','5B'],'night','bi-moon-fill');
  document.getElementById('rosterModal').style.display='flex';
}


function renderSchedule(){
  const fS = document.getElementById('sch-filter-shift').value;
  const fG = document.getElementById('sch-filter-group').value;

  const {year, month} = AVAIL_MONTHS[activeMonthIdx];
  const baseEngineers = activeEngineersForMonth(year, month);

  const filtered = baseEngineers.filter(e => {
    if(fS === '__MAINT__'){
      return e.title === '保養組' && (!fG || e.group === fG);
    }

    return (!fS || e.shift === fS) && (!fG || e.group === fG);
  });

  const tbl = document.getElementById('sch-table');
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const mStr = String(month + 1).padStart(2, '0');

  let hdr = '<thead><tr><th style="min-width:88px;position:sticky;left:0;background:#edf0f7;z-index:12;text-align:center">工號</th><th style="min-width:76px;position:sticky;left:88px;background:#edf0f7;z-index:12;text-align:center">姓名</th><th style="background:#edf0f7;z-index:11">班/組</th>';

  for(let d = 1; d <= daysInMonth; d++){
    const dow = new Date(year, month, d).getDay();
    const isHol = (dow === 0 || dow === 6);

    hdr += `<th style="background:#edf0f7;${isHol ? 'color:var(--danger)' : ''}">${d}<br><span style="font-size:9px">${DAY_ZH[dow]}</span></th>`;
  }

  hdr += '<th style="background:#edf0f7">加班</th><th style="background:#edf0f7">當班</th><th style="background:#edf0f7">總計</th><th style="background:#edf0f7">操作</th></tr></thead>';

  let bdy = '<tbody>';

  filtered.forEach(eng => {
    const st = getMonthStats(eng.id);

    bdy += `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;position:sticky;left:0;background:#fff;z-index:1;text-align:center;color:#1a5276">${eng.id}</td>
      <td style="position:sticky;left:88px;background:#fff;z-index:1;text-align:center"><div class="sch-name" style="font-size:13px">${eng.name}</div></td>
      <td style="white-space:nowrap"><span class="badge-shift shift-${eng.shift}" style="font-size:10px">${eng.shift}</span><br><span class="badge-group" style="${grpStyle(eng.group)};margin-top:2px">${eng.group}</span></td>
    `;

    for(let d = 1; d <= daysInMonth; d++){
      const key = year + '-' + mStr + '-' + String(d).padStart(2, '0');
      const s = (scheduleData[eng.id] || {})[key] || {type:'ON', loc:'5F', ot:0, leave:0};

      const lv = (s.leave && s.leaveTemp)
        ? `<span class="day-leave-tag" style="color:#b37400">臨</span>`
        : (s.leave ? `<span class="day-leave-tag" style="color:#0095b3">假</span>` : '');

      const locColor = getLocColor(s.loc);
      const locBg = getLocBg(s.loc);

      bdy += `<td class="day-${s.type} day-cell" title="點擊編輯" onclick="openDayEdit('${eng.id}','${key}')" style="cursor:pointer">
        <span class="day-type-label ${TYPE_CHIP[s.type]}">${TYPE_LABEL[s.type]}</span>
        ${lv}
        <div class="day-loc" style="color:${locColor};background:${locBg};border-radius:3px;padding:0 3px;display:inline-block">${s.loc}</div>
      </td>`;
    }

    bdy += `<td style="text-align:center;font-weight:700;color:var(--accent2)">${st.ot}</td>
      <td style="text-align:center;font-weight:700;color:#00c570">${st.on}</td>
      <td style="text-align:center;font-weight:700">${st.total}</td>
      <td>
        <div class="leader-only" style="display:inline-block">
          <button class="btn-icon btn-edit" onclick="editScheduleRow('${eng.id}')"><i class="bi bi-pencil-fill"></i></button>
        </div>
        ${isLeader() ? '' : '<span style="font-size:10px;color:var(--text-muted);font-style:italic">唯讀</span>'}
      </td>
    </tr>`;
  });

  bdy += '</tbody>';
  tbl.innerHTML = hdr + bdy;
}

/* ════════════════════════════════════════════════════════
   📸 排班管理 — 截圖功能（限定 By 班輸出）
   ════════════════════════════════════════════════════════ */
async function captureScheduleByShift(){
  const sel = document.getElementById('sch-shot-shift');
  const selectedVal = sel ? sel.value : '4A';
  if(!selectedVal){ showToast('請先選擇要截圖的班別','warning'); return; }
  if(typeof html2canvas === 'undefined'){
    showToast('截圖元件尚未載入完成，請稍候再試','warning');
    return;
  }

  const {year, month} = AVAIL_MONTHS[activeMonthIdx];
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const mStr = String(month+1).padStart(2,'0');
  const monthLabelText = year+'年'+(month+1)+'月';

  // 篩選邏輯：
  //   __MAINT__ → 只取保養組 (title==='保養組')
  //   4A/4B/5A/5B → 只取該班別且「非保養組」(避免重複)
  let filtered, displayLabel, shiftForTitle;
  if(selectedVal === '__MAINT__'){
    filtered = engineers.filter(e => e.title === '保養組');
    displayLabel = '保養組';
    shiftForTitle = 'MAINT';
  } else {
    filtered = engineers.filter(e => e.shift === selectedVal && e.title !== '保養組');
    displayLabel = selectedVal + ' 班';
    shiftForTitle = selectedVal;
  }

  if(filtered.length === 0){
    showToast(displayLabel+' 沒有人員資料','warning');
    return;
  }

  // 建立一個離屏完整可視容器，重新繪製出該班別的完整月份排班表
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-99999px;top:0;background:#fff;padding:24px;font-family:"Noto Sans TC",sans-serif;color:#1a1f36;';

  // Header
  let html = `
    <div style="border-bottom:3px solid #00d4ff;padding-bottom:14px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-end">
        <div>
          <div style="font-size:13px;color:#0095b3;font-weight:700;letter-spacing:1px">營運組值班排班管理系統</div>
          <div style="font-size:22px;font-weight:900;color:#1a1f36;margin-top:4px">${monthLabelText} ${displayLabel} 排班表</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">共 ${filtered.length} 人 · 由 ${escapeHtml(myName||'系統')} 於 ${new Date().toLocaleString('zh-TW',{hour12:false})} 截圖</div>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6b7280;text-align:right">
          <div>${selectedVal==='__MAINT__'?'類別':'班別'}：<b style="color:#0095b3;font-size:14px">${displayLabel}</b></div>
          <div style="margin-top:4px">v3.8.1</div>
        </div>
      </div>
    </div>`;

  // Table
  html += `<table style="border-collapse:collapse;width:auto;font-size:11px;background:#fff">
    <thead><tr style="background:#edf0f7">
      <th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center;min-width:60px">工號</th>
      <th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center;min-width:60px">姓名</th>
      <th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center;min-width:50px">小組</th>`;
  for(let d=1; d<=daysInMonth; d++){
    const dow = new Date(year, month, d).getDay();
    const isWk = (dow===0 || dow===6);
    html += `<th style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:700;text-align:center;min-width:24px;${isWk?'color:#e53e3e':''}">${d}<br><span style="font-size:9px;font-weight:500">${'日一二三四五六'[dow]}</span></th>`;
  }
  html += `<th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center">加班</th>
           <th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center">當班</th>
           <th style="border:1px solid #cbd5e1;padding:6px 8px;font-weight:700;text-align:center">總計</th>
         </tr></thead><tbody>`;

  const TYPE_BG = {ON:'#fff', REST:'rgba(255,165,2,.18)', LEAVE:'rgba(0,212,255,.18)', HOLIDAY:'rgba(255,71,87,.18)'};
  const TYPE_TXT = {ON:'當', REST:'休', LEAVE:'假', HOLIDAY:'例'};

  filtered.forEach(eng=>{
    const st = getMonthStats(eng.id);
    html += `<tr>
      <td style="border:1px solid #cbd5e1;padding:5px 8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:#1a5276;text-align:center">${eng.id}</td>
      <td style="border:1px solid #cbd5e1;padding:5px 8px;font-weight:600;text-align:center">${escapeHtml(eng.name)}</td>
      <td style="border:1px solid #cbd5e1;padding:5px 8px;font-weight:600;text-align:center;color:#6a4f8c">${eng.group}</td>`;
    for(let d=1; d<=daysInMonth; d++){
      const key = year+'-'+mStr+'-'+String(d).padStart(2,'0');
      const s = (scheduleData[eng.id]||{})[key] || {type:'ON', loc:'5F', ot:0, leave:0};
      const lv = s.leave ? (s.leaveTemp?'<span style="color:#b37400;font-weight:700"> 臨</span>':'<span style="color:#0095b3;font-weight:700"> 假</span>') : '';
      const ot = s.ot ? '<span style="font-size:8px;color:#7b5ea7;font-weight:700"> OT</span>' : '';
      html += `<td style="border:1px solid #cbd5e1;padding:3px 2px;text-align:center;background:${TYPE_BG[s.type]||'#fff'};font-size:10px">
        <div style="font-weight:700">${TYPE_TXT[s.type]||'?'}${lv}</div>
        <div style="font-size:9px;color:#6b7280">${s.loc||''}${ot}</div>
      </td>`;
    }
    html += `<td style="border:1px solid #cbd5e1;padding:5px 8px;text-align:center;font-weight:700;color:#6a4f8c">${st.ot}</td>
             <td style="border:1px solid #cbd5e1;padding:5px 8px;text-align:center;font-weight:700;color:#00a85a">${st.on}</td>
             <td style="border:1px solid #cbd5e1;padding:5px 8px;text-align:center;font-weight:800">${st.total}</td>
           </tr>`;
  });
  html += '</tbody></table>';

  // Legend
  html += `
    <div style="margin-top:14px;display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#4a5568">
      <div><span style="display:inline-block;width:14px;height:14px;background:#fff;border:1px solid #cbd5e1;vertical-align:middle;margin-right:4px"></span>當班</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:rgba(255,165,2,.18);border:1px solid #cbd5e1;vertical-align:middle;margin-right:4px"></span>休息日</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:rgba(0,212,255,.18);border:1px solid #cbd5e1;vertical-align:middle;margin-right:4px"></span>休假日（預設加班）</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:rgba(255,71,87,.18);border:1px solid #cbd5e1;vertical-align:middle;margin-right:4px"></span>例假日</div>
      <div style="color:#0095b3"><b>假</b>＝正常請假　<span style="color:#b37400"><b>臨</b></span>＝臨時請假　<span style="color:#7b5ea7"><b>OT</b></span>＝加班</div>
    </div>`;

  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  showToast('正在產生 '+displayLabel+'截圖...','info');

  try{
    const canvas = await html2canvas(wrap, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false
    });
    document.body.removeChild(wrap);

    // 嘗試複製到剪貼簿
    const fileName = `${year}_${mStr}_${shiftForTitle}_排班表.png`;
    let copied = false;
    if(navigator.clipboard && window.ClipboardItem && window.isSecureContext){
      try{
        await new Promise((resolve, reject)=>{
          canvas.toBlob(async blob=>{
            if(!blob){ reject(new Error('blob null')); return; }
            try{
              await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
              resolve();
            }catch(e){ reject(e); }
          }, 'image/png');
        });
        copied = true;
      }catch(e){ copied = false; }
    }

    // 同時下載（保險）
    canvas.toBlob(blob=>{
      if(!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');

    if(copied){
      showToast('✓ '+displayLabel+'截圖已複製到剪貼簿，並下載 '+fileName,'success');
    }else{
      showToast('✓ '+displayLabel+'截圖已下載：'+fileName+'（剪貼簿不支援，請直接使用檔案）','success');
    }
  }catch(err){
    if(wrap.parentNode) document.body.removeChild(wrap);
    console.error(err);
    showToast('截圖失敗：'+err.message,'danger');
  }
}

/* ── CALENDAR ── */
function renderCalendar(){
  const fS=document.getElementById('cal-filter-shift').value;
  const fG=document.getElementById('cal-filter-group').value;
  document.getElementById('cal-month-title').textContent=calYear+'年'+(calMonth+1)+'月排班行事曆';
  const dow=document.getElementById('cal-dow-row');
  dow.innerHTML=['日','一','二','三','四','五','六'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

  const body=document.getElementById('cal-body');
  body.innerHTML='';
  const first=new Date(calYear,calMonth,1);
  let cur=new Date(first); cur.setDate(cur.getDate()-cur.getDay());
  const filtered=engineers.filter(e=>{
    if(fS==='__MAINT__') return e.title==='保養組' && (!fG||e.group===fG);
    return (!fS||e.shift===fS)&&(!fG||e.group===fG);
  });
  const todayStr=dStr(todayNow());

  // 早班 = 4A, 4B；晚班 = 5A, 5B
  const DAY_SHIFTS=['4A','4B'];
  const NIGHT_SHIFTS=['5A','5B'];

  for(let row=0;row<6;row++){
    for(let col=0;col<7;col++){
      const cell=document.createElement('div');
      cell.className='cal-cell';
      const inMonth=cur.getMonth()===calMonth&&cur.getFullYear()===calYear;
      if(!inMonth)cell.classList.add('other-month');
      const key=dStr(cur);
      if(key===todayStr)cell.classList.add('today');

      let html=`<div class="cal-day">${cur.getDate()}</div>`;
      if(inMonth){
        // 計算當日早班/晚班的出勤人數（type==='ON' 或 ot===1）
        const dayCount=countShiftAttendance(filtered,DAY_SHIFTS,key);
        const nightCount=countShiftAttendance(filtered,NIGHT_SHIFTS,key);
        html+=`
          <div class="shift-block shift-block-day">
            <span class="shift-block-label"><i class="bi bi-sun-fill"></i>早班</span>
            <span><span class="shift-block-count">${dayCount.on}</span>${dayCount.ot?`<span class="shift-block-ot">OT${dayCount.ot}</span>`:''}</span>
          </div>
          <div class="shift-block shift-block-night">
            <span class="shift-block-label"><i class="bi bi-moon-fill"></i>晚班</span>
            <span><span class="shift-block-count">${nightCount.on}</span>${nightCount.ot?`<span class="shift-block-ot">OT${nightCount.ot}</span>`:''}</span>
          </div>`;
      }
      cell.innerHTML=html;
      const dateKeyForClick=key;
      cell.addEventListener('click',()=>{if(inMonth){openRosterModal(dateKeyForClick,filtered);}});
      body.appendChild(cell);
      cur.setDate(cur.getDate()+1);
    }
  }
}

/* ── Calendar helpers ── */
function countShiftAttendance(filtered,shifts,dateKey){
  let on=0,ot=0;
  filtered.forEach(eng=>{
    if(!shifts.includes(eng.shift))return;
    const s=(scheduleData[eng.id]||{})[dateKey];
    if(!s)return;
    if(s.type==='ON'&&!s.leave)on++;
    if(s.ot)ot++;
  });
  return {on,ot};
}

/* Roster modal: 一次性初始化監聽器，避免反覆 add/remove 造成的競態問題 */
let _rosterInitialized=false;
function initRosterModal(){
  if(_rosterInitialized)return;
  _rosterInitialized=true;
  const el=document.getElementById('rosterModal');
  // 點擊遮罩背景關閉（只有直接點到 overlay 才觸發）
  el.addEventListener('click',function(e){
    if(e.target===el)closeRosterModal();
  });
  // ESC 鍵關閉（只在 modal 可見時才作用）
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&el.style.display!=='none'&&el.style.display!=='')closeRosterModal();
  });
}

function openRosterModal(dateKey,filtered){
  initRosterModal();
  const [y,m,d]=dateKey.split('-');
  const dt=new Date(parseInt(y),parseInt(m)-1,parseInt(d));
  const dowZh=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][dt.getDay()];
  document.getElementById('roster-date').textContent=parseInt(y)+'年'+parseInt(m)+'月'+parseInt(d)+'日';
  document.getElementById('roster-dow').textContent=dowZh;

  const body=document.getElementById('roster-body');

  function buildSection(label,shifts,colorClass,icon){
    const groupBuckets={};
    let totalOn=0,totalOt=0,totalLeave=0;
    filtered.forEach(eng=>{
      if(!shifts.includes(eng.shift))return;
      const s=(scheduleData[eng.id]||{})[dateKey];
      if(!s)return;
      const isOn=(s.type==='ON'&&!s.leave);
      const isOt=!!s.ot;
      const isLeave=!!s.leave;
      if(!isOn&&!isOt&&!isLeave)return;
      if(isOn)totalOn++;
      if(isOt)totalOt++;
      if(isLeave)totalLeave++;
      const k=eng.shift+'/'+eng.group;
      (groupBuckets[k]=groupBuckets[k]||[]).push({eng,s,isOn,isOt,isLeave});
    });

    const groupKeys=Object.keys(groupBuckets).sort();
    let inner='';
    if(groupKeys.length===0){
      inner='<div class="roster-empty">當日無'+label+'出勤</div>';
    }else{
      groupKeys.forEach(gk=>{
        inner+=`<div class="roster-group-row"><div class="roster-group-label">${gk}（${groupBuckets[gk].length}人）</div>`;
        groupBuckets[gk].forEach(({eng,s,isOt,isLeave})=>{
          const cls=isLeave?'leave':(isOt?'ot':'');
          const isTmpLeave=isLeave&&s.leaveTemp;
          const badge=isTmpLeave?'<span style="color:#b37400;font-weight:700">臨</span>':(isLeave?'<span style="color:#0095b3;font-weight:700">假</span>':(isOt?'<span style="color:#6a4f8c;font-weight:700">OT</span>':''));
          inner+=`<span class="roster-person ${cls}">${badge}${eng.name}<span style="color:var(--text-muted);font-size:10px">${s.loc||''}</span></span>`;
        });
        inner+='</div>';
      });
    }
    return `<div class="roster-shift-section">
      <div class="roster-shift-header ${colorClass}">
        <i class="bi ${icon}"></i>${label}
        <span style="font-size:11px;font-weight:500;opacity:.7">（${shifts.join(' / ')}）</span>
        <span class="roster-count-badge">當班 ${totalOn}　OT ${totalOt}　請假 ${totalLeave}</span>
      </div>
      ${inner}
    </div>`;
  }

  // 注意：innerHTML 會清掉內部所有元素（包含 roster-hidden-date），所以先建內容再補上 hidden input
  body.innerHTML='<input type="hidden" id="roster-hidden-date" value="'+dateKey+'">'
    +buildSection('早班',['4A','4B'],'day','bi-sun-fill')
    +buildSection('晚班',['5A','5B'],'night','bi-moon-fill');

  document.getElementById('rosterModal').style.display='flex';
}

function closeRosterModal(){
  document.getElementById('rosterModal').style.display='none';
}

function rosterAddSchedule(){
  if(!requireLeader()) return;
  const key=document.getElementById('roster-hidden-date').value;
  closeRosterModal();
  document.getElementById('m-sch-date').value=key;
  setTimeout(()=>openAddSchedule(),200);
}

function calPrev(){calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar();}
function calNext(){calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar();}


/* ── PERSONNEL ── */


function renderPersonnel(){
  const fS = document.getElementById('per-filter-shift').value;
  const fG = document.getElementById('per-filter-group').value;
  const q = (document.getElementById('per-search').value || '').toLowerCase();

  const {year, month} = AVAIL_MONTHS[activeMonthIdx];
  const baseEngineers = activeEngineersForMonth(year, month);

  const filtered = baseEngineers.filter(e => {
    const matchTxt = !q || e.name.includes(q) || e.id.toLowerCase().includes(q);

    if(fS === '__MAINT__'){
      return e.title === '保養組' && (!fG || e.group === fG) && matchTxt;
    }

    return (!fS || e.shift === fS) && (!fG || e.group === fG) && matchTxt;
  });

  document.getElementById('eng-count').textContent = filtered.length;

  const tb = document.getElementById('per-tbody');
  const monthNum = AVAIL_MONTHS[activeMonthIdx].month + 1;
  const monthZh = ['一','二','三','四','五','六','七','八','九','十','十一','十二'][monthNum - 1];

  const thOT = document.getElementById('per-th-ot');
  const thON = document.getElementById('per-th-on');

  if(thOT) thOT.textContent = monthZh + '月加班';
  if(thON) thON.textContent = monthZh + '月當班';

  tb.innerHTML = '';

  filtered.forEach(eng => {
    const ri = engineers.indexOf(eng);
    const st = getMonthStats(eng.id);

    tb.innerHTML += `<tr>
      <td><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--accent)">${eng.id}</span></td>
      <td><div class="name-cell"><div class="tbl-avatar-placeholder">${eng.name[0]}</div><strong>${eng.name}</strong></div></td>
      <td><span class="badge-shift shift-${eng.shift}">${eng.shift}</span></td>
      <td><span class="badge-group" style="${grpStyle(eng.group)}">${eng.group}</span></td>
      <td style="font-size:12px">${eng.title}</td>
      <td style="font-size:12px">${eng.hiredate ? `<div>${eng.hiredate}</div><div style="color:var(--accent);font-size:11px">${calcSeniorityFromDate(eng.hiredate)}</div>` : eng.seniority + '年'}</td>
      <td style="font-size:11px"><span class="badge-group" style="background:rgba(0,212,255,.12);color:#0095b3;border:1px solid rgba(0,212,255,.3)">${siteName(eng.factory || currentSite)}</span></td>
      <td style="font-size:11px;color:var(--text-muted)">${eng.note || '—'}</td>
      <td style="text-align:center;font-weight:700;color:var(--accent2)">${st.ot}</td>
      <td style="text-align:center;font-weight:700;color:#00c570">${st.on}</td>
      <td style="text-align:center;font-weight:700">${st.total}</td>
      <td style="white-space:nowrap">
        <div class="leader-only" style="display:inline-flex;gap:4px">
          <button class="btn-icon btn-edit" onclick="editPerson(${ri})"><i class="bi bi-pencil-fill"></i></button>
          <button class="btn-icon btn-del" onclick="confirmDelete(${ri})"><i class="bi bi-trash3-fill"></i></button>
        </div>
        ${isLeader() ? '' : '<span style="font-size:10px;color:var(--text-muted);font-style:italic">唯讀</span>'}
      </td>
    </tr>`;
  });
}


function renderAnalysis(){
  const activeList = getCurrentMonthActiveEngineers();
  const n = activeList.length;

  const totalEl = document.getElementById('an-total');

  if(totalEl){
    totalEl.textContent = n;
  }

  if(n === 0){
    document.getElementById('an-avg-on').textContent = '—';
    document.getElementById('an-total-ot').textContent = '0';
    document.getElementById('an-top-ot').textContent = '—';

    const sl = document.getElementById('an-shift-list');
    if(sl) sl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">目前月份無有效人員</div>';

    const gl = document.getElementById('an-group-list');
    if(gl) gl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">目前月份無有效人員</div>';

    const rl = document.getElementById('an-rank-list');
    if(rl) rl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">目前月份無排行資料</div>';

    _buildChart('ch-analysis','bar',{
      labels:['4A班','5A班','4B班','5B班'],
      datasets:[
        {
          label:'當班天數',
          data:[0,0,0,0],
          backgroundColor:['rgba(0,212,255,.5)','rgba(0,255,136,.5)','rgba(123,94,167,.5)','rgba(255,165,2,.5)'],
          borderRadius:4,
          borderSkipped:false
        },
        {
          label:'加班天數',
          data:[0,0,0,0],
          backgroundColor:['rgba(0,212,255,.9)','rgba(0,255,136,.9)','rgba(123,94,167,.9)','rgba(255,165,2,.9)'],
          borderRadius:4,
          borderSkipped:false
        }
      ]
    },{
      scales:{
        x:{grid:{display:false}},
        y:{min:0}
      }
    });

    return;
  }

  const totalOT = activeList.reduce((a, e) => a + getMonthStats(e.id).ot, 0);
  const avgOn = (activeList.reduce((a, e) => a + getMonthStats(e.id).on, 0) / n).toFixed(1);
  const topOT = [...activeList].sort((a, b) => getMonthStats(b.id).ot - getMonthStats(a.id).ot)[0];

  document.getElementById('an-avg-on').textContent = avgOn;
  document.getElementById('an-total-ot').textContent = totalOT;
  document.getElementById('an-top-ot').textContent = topOT ? topOT.name : '—';

  const shifts = ['4A','5A','4B','5B'];
  const shiftCols = [
    'rgba(0,212,255,.7)',
    'rgba(0,255,136,.7)',
    'rgba(123,94,167,.7)',
    'rgba(255,165,2,.7)'
  ];

  const sl = document.getElementById('an-shift-list');
  sl.innerHTML = '';

  const maxSC = Math.max(1, ...shifts.map(s => activeList.filter(e => e.shift === s).length));

  let shiftHtml = '<div style="display:flex;gap:10px;flex-wrap:nowrap;align-items:stretch">';

  shifts.forEach((s, i) => {
    const cnt = activeList.filter(e => e.shift === s).length;
    const pct = Math.round(cnt / maxSC * 100);
    const accent = shiftCols[i].replace('.7','.9');

    shiftHtml += `<div style="flex:1;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:6px;gap:4px">
        <span style="font-weight:600;white-space:nowrap;color:${accent}">${s}班</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${accent};white-space:nowrap">${cnt}<span style="font-size:10px;color:var(--text-muted);font-weight:500;margin-left:2px">人</span></span>
      </div>
      <div class="prop-bar"><div class="prop-fill" style="width:${pct}%;background:${shiftCols[i]}"></div></div>
    </div>`;
  });

  shiftHtml += '</div>';
  sl.innerHTML = shiftHtml;

  const gl = document.getElementById('an-group-list');
  gl.innerHTML = '';

  const maxGC = Math.max(1, ...GROUPS_ALL.map(g => activeList.filter(e => e.group === g).length));

  GROUPS_ALL.forEach(g => {
    const cnt = activeList.filter(e => e.group === g).length;
    const pct = Math.round(cnt / maxGC * 100);

    gl.innerHTML += `<div class="prop-row">
      <div class="prop-label">
        <span>${g}（${cnt}人）</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700">${cnt}</span>
      </div>
      <div class="prop-bar"><div class="prop-fill" style="width:${pct}%;background:rgba(0,212,255,.6)"></div></div>
    </div>`;
  });

  const ranked = [...activeList]
    .sort((a, b) => getMonthStats(b.id).ot - getMonthStats(a.id).ot)
    .slice(0, 8);

  const rl = document.getElementById('an-rank-list');
  rl.innerHTML = '';

  ranked.forEach((e, i) => {
    const rc = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';

    rl.innerHTML += `<div class="rank-item">
      <div class="rank-num ${rc}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${e.name}</div>
        <div class="rank-sub">${e.shift}/${e.group} · ${e.title}</div>
      </div>
      <div class="rank-score">${getMonthStats(e.id).ot}</div>
    </div>`;
  });

  const shiftOnSum = shifts.map(s =>
    activeList.filter(e => e.shift === s).reduce((a, e) => a + getMonthStats(e.id).on, 0)
  );

  const shiftOTSum = shifts.map(s =>
    activeList.filter(e => e.shift === s).reduce((a, e) => a + getMonthStats(e.id).ot, 0)
  );

  _buildChart('ch-analysis','bar',{
    labels:['4A班','5A班','4B班','5B班'],
    datasets:[
      {
        label:'當班天數',
        data:shiftOnSum,
        backgroundColor:shiftCols.map(c => c.replace('.7','.5')),
        borderRadius:4,
        borderSkipped:false
      },
      {
        label:'加班天數',
        data:shiftOTSum,
        backgroundColor:shiftCols.map(c => c.replace('.7','.9')),
        borderRadius:4,
        borderSkipped:false
      }
    ]
  },{
    scales:{
      x:{grid:{display:false}},
      y:{min:0}
    }
  });
}


function openAddSchedule(){
  document.getElementById('m-sch-idx').value = -1;

  const sel = document.getElementById('m-sch-person');
  sel.innerHTML = '<option value="">選擇員工</option>';

  const {year, month} = AVAIL_MONTHS[activeMonthIdx];

  activeEngineersForMonth(year, month).forEach(e => {
    sel.innerHTML += `<option value="${e.id}">${e.name}（${e.shift}/${e.group}）</option>`;
  });

  document.getElementById('m-sch-type').value = 'ON';
  document.getElementById('m-sch-leave').value = '0';
  document.getElementById('m-sch-ot').value = '0';
  document.getElementById('m-sch-leave-type').value = '0';

  document.getElementById('m-sch-date').value =
    year + '-' + String(month + 1).padStart(2, '0') + '-01';

  onSchLeaveChange();

  new bootstrap.Modal(document.getElementById('scheduleModal')).show();
}


function editScheduleRow(id){
  if(!isLeader()){
    showToast('ENG 為唯讀模式，無法編輯排班', 'warning');
    return;
  }

  const sel = document.getElementById('m-sch-person');
  sel.innerHTML = '<option value="">選擇員工</option>';

  const {year, month} = AVAIL_MONTHS[activeMonthIdx];

  activeEngineersForMonth(year, month).forEach(e => {
    sel.innerHTML += `<option value="${e.id}">${e.name}（${e.shift}/${e.group}）</option>`;
  });

  sel.value = id;

  const midKey = year + '-' + String(month + 1).padStart(2, '0') + '-15';

  document.getElementById('m-sch-date').value = midKey;

  const s = (scheduleData[id] || {})[midKey] || {
    type:'ON',
    loc:'5F',
    leave:0,
    ot:0
  };

  document.getElementById('m-sch-type').value = s.type;
  document.getElementById('m-sch-loc').value = s.loc || '5F';
  document.getElementById('m-sch-leave').value = s.leave ? '1' : '0';
  document.getElementById('m-sch-ot').value = s.ot ? '1' : '0';
  document.getElementById('m-sch-leave-type').value = s.leaveTemp ? '1' : '0';

  onSchLeaveChange();

  new bootstrap.Modal(document.getElementById('scheduleModal')).show();
}


function saveSchedule(){
  if(!requireLeader()) return;
  const id=document.getElementById('m-sch-person').value;
  const date=document.getElementById('m-sch-date').value;
  const type=document.getElementById('m-sch-type').value;
  const loc=document.getElementById('m-sch-loc').value;
  const leave=parseInt(document.getElementById('m-sch-leave').value);
  const ot=parseInt(document.getElementById('m-sch-ot').value);
  const leaveTemp=leave?parseInt(document.getElementById('m-sch-leave-type').value):0;
  if(!id){showToast('請選擇員工！','warning');return;}
  if(!date){showToast('請選擇日期！','warning');return;}
  if(type==='HOLIDAY'&&leave){document.getElementById('m-holiday-warn').style.display='block';showToast('例假日不可設定請假！','danger');return;}
  scheduleData[id]=scheduleData[id]||{};
  scheduleData[id][date]={type,loc,leave,ot:ot||(type==='LEAVE'?1:0),leaveTemp};
  lsSave();
  bootstrap.Modal.getInstance(document.getElementById('scheduleModal')).hide();
  const leaveLabel=leave?(leaveTemp?'臨時請假（加註「臨」）':'正常請假'):'';
  showToast(leave?('已設定請假（10H）'+(leaveLabel?' · '+leaveLabel:'')):'排班已更新','success');
  refreshAllViews();
}
function onSchLeaveChange(){
  const v=document.getElementById('m-sch-leave').value;
  document.getElementById('m-leave-note').style.display=v==='1'?'block':'none';
  document.getElementById('m-sch-leave-type-wrap').style.display=v==='1'?'block':'none';
  document.getElementById('m-holiday-warn').style.display='none';
}
function onSchTypeChange(){
  if(document.getElementById('m-sch-type').value==='LEAVE')document.getElementById('m-sch-ot').value='1';
}

/* ── PERSON MODAL ── */
function openAddPerson(){
  if(!requireLeader()) return;
  document.getElementById('per-edit-idx').value=-1;
  document.getElementById('per-modal-title').textContent='新增人員';
  ['p-id','p-name','p-note'].forEach(x=>document.getElementById(x).value='');
  document.getElementById('p-hiredate').value='';
  document.getElementById('p-seniority').value='0';
  document.getElementById('p-seniority-display').textContent='年資：—';
  document.getElementById('p-shift').value='4A';updateGroupSel();
  document.getElementById('p-title').value='工程師';
  document.getElementById('p-factory').value=currentSite;  // 預設為目前廠區
  document.getElementById('p-seniority').value='1';
  new bootstrap.Modal(document.getElementById('personModal')).show();
}
function editPerson(i){
  if(!requireLeader()) return;
  const e=engineers[i];
  document.getElementById('per-edit-idx').value=i;
  document.getElementById('per-modal-title').textContent='編輯人員';
  document.getElementById('p-id').value=e.id;
  document.getElementById('p-name').value=e.name;
  document.getElementById('p-shift').value=e.shift;updateGroupSel();
  document.getElementById('p-group').value=e.group;
  document.getElementById('p-title').value=e.title;
  document.getElementById('p-hiredate').value=e.hiredate||'';
  document.getElementById('p-seniority').value=e.seniority||0;
  if(e.hiredate) document.getElementById('p-seniority-display').textContent='年資：'+calcSeniorityFromDate(e.hiredate);
  else document.getElementById('p-seniority-display').textContent='年資：'+(e.seniority||0)+'年';
  document.getElementById('p-note').value=e.note;
  document.getElementById('p-factory').value=e.factory||currentSite;
  new bootstrap.Modal(document.getElementById('personModal')).show();
}
function updateGroupSel(){
  const s=document.getElementById('p-shift').value;
  document.getElementById('p-group').innerHTML=(GROUPS_MAP[s]||[]).map(g=>`<option>${g}</option>`).join('');
}
async function savePerson(){
  if(!requireLeader()) return;

  const idx = parseInt(document.getElementById('per-edit-idx').value, 10);
  const id = document.getElementById('p-id').value.trim();
  const name = document.getElementById('p-name').value.trim();

  if(!id){
    showToast('請輸入工號！', 'warning');
    document.getElementById('p-id')?.focus();
    return;
  }

  if(!name){
    showToast('請輸入姓名！', 'warning');
    document.getElementById('p-name')?.focus();
    return;
  }

  const hiredate = document.getElementById('p-hiredate').value;
  const oldPerson = idx >= 0 ? engineers[idx] : null;

  const obj = {
    id: id,
    name: name,
    shift: document.getElementById('p-shift').value,
    group: document.getElementById('p-group').value,
    title: document.getElementById('p-title').value,
    factory: document.getElementById('p-factory').value || currentSite,
    hiredate: hiredate,
    seniority: hiredate
      ? calcSeniorityYears(hiredate)
      : (parseInt(document.getElementById('p-seniority').value, 10) || 0),
    note: document.getElementById('p-note').value,
    inactiveFromYm: oldPerson ? (oldPerson.inactiveFromYm || '') : ''
  };

  const duplicateIdx = engineers.findIndex(e =>
    String(e.id || '').trim().toLowerCase() === id.toLowerCase()
  );

  if(idx < 0 && duplicateIdx >= 0){
    showToast('此工號已存在於目前站台值班工程師名冊：' + id, 'warning');
    return;
  }

  if(idx >= 0){
    if(!oldPerson){
      showToast('找不到要編輯的人員資料', 'error');
      return;
    }

    const oldId = String(oldPerson.id || '').trim();

    if(oldId.toLowerCase() !== id.toLowerCase() && duplicateIdx >= 0){
      showToast('此工號已存在於目前站台值班工程師名冊：' + id, 'warning');
      return;
    }

    engineers[idx] = obj;
    if(!PREVIEW_MODE) syncRosterSave();   // 編輯後同步該站 roster.json

    if(oldId && oldId !== id){
      if(scheduleData[oldId] && !scheduleData[id]){
        scheduleData[id] = scheduleData[oldId];
      }

      delete scheduleData[oldId];
    }

  }else{
    // 值班納編：先到後端做工號唯一性檢查（users.json 已存在 → 拒絕），
    // 通過後由後端同寫 該站 roster.json + users.json（ENG 帳號）
    if(!PREVIEW_MODE){
      let resp = null, data = null;
      try{
        resp = await fetch(API_URL + '?action=roster_add&site=' + encodeURIComponent(currentSite), {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({person: {...obj, isMaintenance: obj.title === '保養組'}})
        });
        data = await resp.json().catch(() => null);
      }catch(e){
        showToast('無法連線伺服器，人員新增失敗', 'error');
        return;
      }
      if(!resp.ok || !data || !data.success){
        showToast(data && data.message ? data.message
                  : '新增失敗：工號已存在或伺服器錯誤', 'warning');
        return;
      }
    }

    engineers.push(obj);

    try{
      AVAIL_MONTHS.forEach(({year, month}) => buildScheduleForMonth(year, month));
    }catch(e){
      console.warn('新增人員後產生預設排班失敗：', e);
    }
  }

  lsSave();

  const modal = bootstrap.Modal.getInstance(document.getElementById('personModal'));
  if(modal) modal.hide();

  safeRun('renderPersonnel', renderPersonnel);
  safeRun('buildDashboard', buildDashboard);
  safeRun('renderSchedule', renderSchedule);
  safeRun('renderCalendar', renderCalendar);
  safeRun('renderAnalysis', renderAnalysis);

  showToast(idx >= 0 ? '人員資料已更新！' : '人員新增成功！', 'success');
}


function confirmDelete(i){
  if(!requireLeader()) return;

  deleteIdx = i;

  const e = engineers[i];

  if(!e){
    showToast('找不到要移除的人員資料', 'warning');
    return;
  }

  document.getElementById('del-name').textContent = e.name;
  document.getElementById('del-id').textContent = e.id + ' · ' + e.shift + '/' + e.group;

  fillDeleteMonthOptions();

  new bootstrap.Modal(document.getElementById('deleteModal')).show();
}


function executeDelete(){
  if(deleteIdx < 0) return;

  const target = engineers[deleteIdx];

  if(!target){
    deleteIdx = -1;
    showToast('找不到要移除的人員資料', 'warning');
    return;
  }

  const name = target.name || '';
  const id = target.id || '';

  const cur = AVAIL_MONTHS[activeMonthIdx];
  const defaultYm = cur ? ymFromYearMonth(cur.year, cur.month) : '';

  const sel = document.getElementById('del-from-month');
  const fromYm = sel && sel.value ? sel.value : defaultYm;

  const fromLabel = sel && sel.selectedOptions && sel.selectedOptions[0]
    ? sel.selectedOptions[0].textContent
    : fromYm;

  if(!fromYm){
    showToast('請選擇移除生效月份', 'warning');
    return;
  }

  target.inactiveFromYm = fromYm;
  if(!PREVIEW_MODE) syncRosterSave();   // 移除標記同步寫回該站 roster.json

  removeScheduleFromYm(id, fromYm);

  deleteIdx = -1;

  lsSave();

  const modal = bootstrap.Modal.getInstance(document.getElementById('deleteModal'));
  if(modal) modal.hide();

  safeRun('renderPersonnel', renderPersonnel);
  safeRun('buildDashboard', buildDashboard);
  safeRun('renderSchedule', renderSchedule);
  safeRun('renderCalendar', renderCalendar);
  safeRun('renderAnalysis', renderAnalysis);

  showToast(
    '已從 ' + fromLabel + ' 含往後月份移除：' + name + '；之前月份已保留',
    'info'
  );
}

/* ── SENIORITY HELPERS ── */
function calcSeniorityYears(dateStr){
  if(!dateStr)return 0;
  const hire=new Date(dateStr);
  const now=new Date();
  let years=now.getFullYear()-hire.getFullYear();
  const m=now.getMonth()-hire.getMonth();
  if(m<0||(m===0&&now.getDate()<hire.getDate()))years--;
  return Math.max(0,years);
}
function calcSeniorityMonths(dateStr){
  if(!dateStr)return '';
  const hire=new Date(dateStr);
  const now=new Date();
  let months=(now.getFullYear()-hire.getFullYear())*12+(now.getMonth()-hire.getMonth());
  if(now.getDate()<hire.getDate())months--;
  months=Math.max(0,months);
  const y=Math.floor(months/12);
  const m=months%12;
  if(y===0)return m+'個月';
  if(m===0)return y+'年';
  return y+'年 '+m+'個月';
}
function calcSeniorityFromDate(dateStr){
  return dateStr?calcSeniorityMonths(dateStr)+'（'+dateStr+'）':'—';
}
function calcSeniority(){
  const d=document.getElementById('p-hiredate').value;
  if(d){
    const txt=calcSeniorityMonths(d);
    document.getElementById('p-seniority-display').textContent='年資：'+txt;
    document.getElementById('p-seniority').value=calcSeniorityYears(d);
  }else{
    document.getElementById('p-seniority-display').textContent='年資：—';
    document.getElementById('p-seniority').value='0';
  }
}

/* ── SAVE SETTINGS ── */
function saveSettings(){
  if(!requireLeader()) return;
  // 管理員姓名/編號僅作為系統設定保存（serverSave 會讀取輸入框寫入 meta.config）；
  // 側邊欄顯示的是「登入身分」，不在此處覆蓋。
  lsSave();
  showToast('設定已儲存','success');
}

/* ════════════════════════════════════════════════════════
   🔐 工號權限綁定 (Role Binding)
   ════════════════════════════════════════════════════════ */
// 帳號權限管理：列出 users.json 帳號，可切換角色後儲存回檔
let _usersCache = [];
async function renderRoleBindings(){
  const tb = document.getElementById('rb-tbody');
  if(!tb) return;
  tb.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px">載入中…</td></tr>`;
  try{
    const r = await fetch(API_URL+'?action=users_load',{cache:'no-store'});
    const d = await r.json();
    if(!d || !d.success) throw new Error('load failed');
    _usersCache = d.users || [];
  }catch(e){
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--danger);padding:18px">無法讀取 users.json（後端是否啟動？）</td></tr>`;
    return;
  }
  if(_usersCache.length === 0){
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px">users.json 沒有任何帳號</td></tr>`;
    return;
  }
  const viewerAdmin = trueIsAdmin();
  const adminCount = _usersCache.filter(u=>(u.role||'').toUpperCase()==='ADMIN').length;
  tb.innerHTML = _usersCache.map(u=>{
    const acc = escapeHtml(u.account);
    const nm  = escapeHtml(u.name||'');
    const uRole = (u.role||'ENG').toUpperCase();
    const isSelf = (String(u.account).trim().toLowerCase() === String(myAccount).trim().toLowerCase());
    const isENG  = (uRole === 'ENG');
    // 可否對此列動作：ADMIN→任一列(非本人)；LEADER→僅 ENG 列(非本人)
    const canActOnRow = !isSelf && (viewerAdmin || isENG);

    const roleBadge = uRole==='ADMIN'
      ? '<span class="role-badge role-ADMIN"><i class="bi bi-gem"></i> ADMIN</span>'
      : uRole==='LEADER'
        ? '<span class="role-badge role-LEADER"><i class="bi bi-shield-fill-check"></i> LEADER</span>'
        : '<span class="role-badge role-ENG"><i class="bi bi-person-badge"></i> ENG</span>';
    const selfTag = isSelf ? ' <span style="font-size:11px;color:var(--accent);font-weight:700">（本人）</span>' : '';

    // 角色欄：只有 ADMIN 且非本人 → 可改角色下拉；其餘只顯示徽章
    let roleCell;
    if(viewerAdmin && !isSelf){
      roleCell = `<select class="form-select form-select-sm rb-role" data-account="${acc}" onchange="saveOneUser('${acc}')" style="width:auto;display:inline-block;font-size:12px">
           <option value="ENG"${uRole==='ENG'?' selected':''}>ENG（唯讀）</option>
           <option value="LEADER"${uRole==='LEADER'?' selected':''}>LEADER（可編輯）</option>
           <option value="ADMIN"${uRole==='ADMIN'?' selected':''}>ADMIN（最高權限）</option>
         </select>`;
    }else{
      roleCell = roleBadge + selfTag;
    }

    // 姓名欄：可動作才可編輯
    const nameCell = canActOnRow
      ? `<input class="form-control form-control-sm rb-name" data-account="${acc}" value="${nm}" onchange="saveOneUser('${acc}')" style="font-size:12px;min-width:90px">`
      : `<input class="form-control form-control-sm" value="${nm}" disabled style="font-size:12px;min-width:90px;opacity:.6">`;

    // 操作欄：可動作才可刪；最後一個 ADMIN 不可刪
    let opCell;
    if(!canActOnRow){
      opCell = `<span style="color:var(--text-muted);font-size:11px">—</span>`;
    }else if(uRole==='ADMIN' && adminCount<=1){
      opCell = `<span title="最後一個 ADMIN 不可刪除" style="color:var(--text-muted);font-size:13px"><i class="bi bi-lock-fill"></i></span>`;
    }else{
      opCell = `<button class="icon-btn" onclick="deleteUser('${acc}')" title="刪除帳號" style="color:var(--danger);background:none;border:none;cursor:pointer;font-size:15px"><i class="bi bi-trash3"></i></button>`;
    }

    return `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--accent)">${acc}</td>
      <td>${nameCell}</td>
      <td>${roleCell}</td>
      <td style="text-align:right">${opCell}</td>
    </tr>`;
  }).join('');
}

// 新增帳號（LEADER 只能新增 ENG；ADMIN 可選 ENG/LEADER/ADMIN）
async function addUser(){
  if(!requireAccountEditor()) return;
  const account = (document.getElementById('u-add-account')?.value||'').trim();
  const name    = (document.getElementById('u-add-name')?.value||'').trim();
  let role = (document.getElementById('u-add-role')?.value||'ENG').toUpperCase();
  if(!trueIsAdmin()) role = 'ENG';                       // 非 ADMIN 一律 ENG
  if(!['ADMIN','LEADER','ENG'].includes(role)) role = 'ENG';
  if(!account){ showToast('請輸入工號','warning'); document.getElementById('u-add-account')?.focus(); return; }
  try{
    const r = await fetch(API_URL+'?action=users_add',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ account, name, role, password:'' })
    });
    const d = await r.json();
    if(d && d.success){
      showToast('已新增帳號：'+account+'（'+role+'）','success');
      const a=document.getElementById('u-add-account'); if(a)a.value='';
      const n=document.getElementById('u-add-name'); if(n)n.value='';
      renderRoleBindings();
    }else{
      showToast('新增失敗：'+((d&&d.error)||'未知錯誤'),'error');
    }
  }catch(e){ showToast('新增失敗：'+e.message,'error'); }
}

// 刪除帳號（LEADER 只能刪 ENG；不可刪自己；最後一個 ADMIN 由後端再擋一次）
async function deleteUser(account){
  if(!requireAccountEditor()) return;
  if(String(account).trim().toLowerCase() === String(myAccount).trim().toLowerCase()){
    showToast('不可刪除自己的帳號','warning'); return;
  }
  const target = _usersCache.find(u=>String(u.account).trim().toLowerCase()===String(account).trim().toLowerCase());
  const tRole = (target?.role||'ENG').toUpperCase();
  if(!trueIsAdmin() && tRole!=='ENG'){
    showToast('LEADER 只能刪除 ENG 帳號','warning'); return;
  }
  if(!confirm('確定要刪除帳號「'+account+'」？\n刪除後該工號將無法登入。')) return;
  try{
    const r = await fetch(API_URL+'?action=users_delete',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ account })
    });
    const d = await r.json();
    if(d && d.success){ showToast('已刪除帳號：'+account,'info'); renderRoleBindings(); }
    else showToast('刪除失敗：'+((d&&d.error)||'未知錯誤'),'error');
  }catch(e){ showToast('刪除失敗：'+e.message,'error'); }
}

// 單列即時寫入：角色(ADMIN限定)或姓名一變更就直接寫回 users.json
async function saveOneUser(account){
  if(!requireAccountEditor()) return;
  if(String(account).trim().toLowerCase() === String(myAccount).trim().toLowerCase()) return; // 不改自己
  const cached = _usersCache.find(u=>String(u.account).trim().toLowerCase()===String(account).trim().toLowerCase());
  const cRole = (cached?.role||'ENG').toUpperCase();
  // LEADER 只能改 ENG 列、且不可改角色
  if(!trueIsAdmin() && cRole!=='ENG'){
    showToast('LEADER 只能修改 ENG 帳號','warning'); renderRoleBindings(); return;
  }
  const sel  = document.querySelector('.rb-role[data-account="'+CSS.escape(account)+'"]');
  const nmEl = document.querySelector('.rb-name[data-account="'+CSS.escape(account)+'"]');
  // 角色：ADMIN 由下拉決定；LEADER 一律維持原角色(ENG)
  const role = (trueIsAdmin() && sel) ? sel.value.toUpperCase() : cRole;
  const name = nmEl ? nmEl.value.trim() : (cached?cached.name:'');
  try{
    const r = await fetch(API_URL+'?action=users_update',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ users: [{ account, name, role }] })
    });
    const d = await r.json();
    if(d && d.success){
      showToast('已寫入 users.json：'+account+'（'+role+'）','success');
      renderRoleBindings();   // 重抓，保持徽章/最後一個ADMIN鎖等狀態正確
    }else{
      throw new Error((d && d.error) || 'save failed');
    }
  }catch(e){
    showToast('寫入失敗：'+e.message,'error');
    renderRoleBindings();
  }
}


const DOW_ZH_FULL=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
const TYPE_NAME_FULL={ON:'當班（白色）',REST:'休息日（黃色）',LEAVE:'休假日/OT（藍色）',HOLIDAY:'例假日（紅色）'};

function openDayEdit(engId, dateKey){
  if(!isLeader()){
    showToast('ENG 為唯讀模式，無法編輯排班','warning');
    return;
  }
  const eng=engineers.find(e=>e.id===engId);
  if(!eng)return;
  const s=(scheduleData[engId]||{})[dateKey]||{type:'ON',loc:'5F',leave:0,ot:0};
  const d=new Date(dateKey+'T00:00:00');
  const [y,m,day]=dateKey.split('-');

  document.getElementById('day-eng-id').value=engId;
  document.getElementById('day-date-key').value=dateKey;
  document.getElementById('day-modal-title').textContent='編輯排班 — '+eng.name;
  document.getElementById('day-modal-avatar').textContent=eng.name[0];
  document.getElementById('day-modal-name').textContent=eng.name;
  document.getElementById('day-modal-meta').textContent=eng.id+' · '+eng.shift+'/'+eng.group+' · '+eng.title;
  document.getElementById('day-modal-date').textContent=y+'年'+parseInt(m)+'月'+parseInt(day)+'日';
  document.getElementById('day-modal-dow').textContent=DOW_ZH_FULL[d.getDay()];
  document.getElementById('day-type').value=s.type;
  document.getElementById('day-loc').value=s.loc||'5F';
  document.getElementById('day-leave').value=s.leave?'1':'0';
  document.getElementById('day-ot').value=s.ot?'1':'0';
  document.getElementById('day-leave-note').style.display=s.leave?'block':'none';
  document.getElementById('day-leave-type-wrap').style.display=s.leave?'block':'none';
  document.getElementById('day-leave-type').value=s.leaveTemp?'1':'0';
  document.getElementById('day-holiday-warn').style.display='none';
  new bootstrap.Modal(document.getElementById('dayEditModal')).show();
}

function onDayTypeChange(){
  const t=document.getElementById('day-type').value;
  if(t==='LEAVE') document.getElementById('day-ot').value='1';
  if(t==='HOLIDAY'){
    document.getElementById('day-leave').value='0';
    document.getElementById('day-leave-note').style.display='none';
  }
  document.getElementById('day-holiday-warn').style.display='none';
}
function onDayLeaveChange(){
  const v=document.getElementById('day-leave').value;
  document.getElementById('day-leave-note').style.display=v==='1'?'block':'none';
  document.getElementById('day-leave-type-wrap').style.display=v==='1'?'block':'none';
  document.getElementById('day-holiday-warn').style.display='none';
}
function saveDayEdit(){
  if(!requireLeader()) return;
  const engId=document.getElementById('day-eng-id').value;
  const dateKey=document.getElementById('day-date-key').value;
  const type=document.getElementById('day-type').value;
  const loc=document.getElementById('day-loc').value;
  const leave=parseInt(document.getElementById('day-leave').value);
  const ot=parseInt(document.getElementById('day-ot').value);
  const leaveTemp=leave?parseInt(document.getElementById('day-leave-type').value):0;
  if(type==='HOLIDAY'&&leave){
    document.getElementById('day-holiday-warn').style.display='block';
    showToast('例假日不可設定請假！','danger'); return;
  }
  scheduleData[engId]=scheduleData[engId]||{};
  scheduleData[engId][dateKey]={type,loc,leave,ot:ot||(type==='LEAVE'?1:0),leaveTemp};
  lsSave();
  bootstrap.Modal.getInstance(document.getElementById('dayEditModal')).hide();
  const eng=engineers.find(e=>e.id===engId);
  const [y,m,d]=dateKey.split('-');
  const leaveLabel=leave?(leaveTemp?'臨時請假':'正常請假'):'';
  showToast(`${eng?.name} ${parseInt(m)}/${parseInt(d)} ${TYPE_NAME_FULL[type]}${leaveLabel?' · '+leaveLabel:''} 已更新`,'success');
  refreshAllViews();
}
function resetDayToCalendar(){
  if(!requireLeader()) return;
  const engId=document.getElementById('day-eng-id').value;
  const dateKey=document.getElementById('day-date-key').value;
  const eng=engineers.find(e=>e.id===engId);
  if(!eng)return;
  const calKey=getCalKey(eng.shift,eng.group);
  const [y,m,d]=dateKey.split('-');
  const dayType=getDayTypeFor(calKey,parseInt(y),parseInt(m)-1,parseInt(d));
  const locs=LOCS_BY_SHIFT[eng.shift]||['5F'];
  const ei=engineers.indexOf(eng);
  const loc=locs[(ei+parseInt(d))%locs.length];
  scheduleData[engId][dateKey]={type:dayType,loc,leave:0,ot:dayType==='LEAVE'?1:0};
  lsSave();
  document.getElementById('day-type').value=dayType;
  document.getElementById('day-loc').value=loc;
  document.getElementById('day-leave').value='0';
  document.getElementById('day-ot').value=dayType==='LEAVE'?'1':'0';
  document.getElementById('day-leave-note').style.display='none';
  showToast('已還原為行事曆預設值','info');
  refreshAllViews();
}

/* ── GO 出勤回報 ── */
let _goCurrentShift='DAY'; // 預設值會在 toggleGoReport 開啟時依時間自動切換
let _goOpen=false;

// 依現在時間判斷當班別：07:31~19:30 → 早班(DAY)；其他 → 夜班(NIGHT)
function getCurrentShiftByTime(){
  const now=new Date();
  const mins=now.getHours()*60+now.getMinutes();
  // 07:31 = 451 分；19:30 = 1170 分
  return (mins>=451&&mins<=1170)?'DAY':'NIGHT';
}

// 統一刷新函式：排班資料變動後呼叫，順便刷新 GO 面板（若開啟中）
function refreshAllViews(){
  renderSchedule();
  renderCalendar();
  buildDashboard();
  if(_goOpen)renderGoReport(_goCurrentShift);
}

function toggleGoReport(){
  _goOpen=!_goOpen;
  const panel=document.getElementById('go-report-panel');
  if(_goOpen){
    // 每次開啟都依當下時間自動選擇當班分頁
    _goCurrentShift=getCurrentShiftByTime();
    document.querySelectorAll('.go-shift-btn').forEach(b=>b.classList.remove('active'));
    const btn=document.getElementById('go-s-'+_goCurrentShift);
    if(btn)btn.classList.add('active');
    panel.style.display='block';
    renderGoReport(_goCurrentShift);
    // Animate in
    panel.style.opacity='0';panel.style.transform='translateY(-10px)';
    requestAnimationFrame(()=>{panel.style.transition='opacity .2s,transform .2s';panel.style.opacity='1';panel.style.transform='translateY(0)';});
    // Click outside to close
    setTimeout(()=>document.addEventListener('click',_goOutsideClick),10);
  } else {
    closeGoReport();
  }
}

function closeGoReport(){
  _goOpen=false;
  document.getElementById('go-report-panel').style.display='none';
  document.removeEventListener('click',_goOutsideClick);
}

function _goOutsideClick(e){
  const panel=document.getElementById('go-report-panel');
  const btn=document.getElementById('go-btn');
  if(!panel.contains(e.target)&&e.target!==btn){closeGoReport();}
}

function selectGoShift(shift){
  _goCurrentShift=shift;
  document.querySelectorAll('.go-shift-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('go-s-'+shift).classList.add('active');
  renderGoReport(shift);
}

function renderGoReport(shift){
  const panel=document.getElementById('go-report-panel');
  const todayKey=dStr(todayNow());
  const n=new Date();
  // 日期格式：YYYY/MM/DD（年份 + 零填補月日）
  const dateLabel=n.getFullYear()+'/'+String(n.getMonth()+1).padStart(2,'0')+'/'+String(n.getDate()).padStart(2,'0');

  // 依 shift 篩選：DAY=4A+4B 早班, NIGHT=5A+5B 夜班, ALL=全部, 其他=單一班別
  let targets;
  if(shift==='ALL') targets=engineers;
  else if(shift==='DAY') targets=engineers.filter(e=>e.shift==='4A'||e.shift==='4B');
  else if(shift==='NIGHT') targets=engineers.filter(e=>e.shift==='5A'||e.shift==='5B');
  else targets=engineers.filter(e=>e.shift===shift);

  // 早班相關（DAY / 4A / 4B / ALL）會額外顯示「保養組」分流區塊
  // 夜班（NIGHT / 5A / 5B）維持原本格式，不顯示保養組
  const isDayLike = (shift==='DAY' || shift==='4A' || shift==='4B' || shift==='ALL');

  // 把目標分成「主班」與「保養組」
  const mainTargets = isDayLike ? targets.filter(e=>e.title!=='保養組') : targets;
  const mtTargets   = isDayLike ? targets.filter(e=>e.title==='保養組') : [];

  // 通用統計函式：回傳 {scheduled, actualOn, leaveCount, otCount}
  // 計算邏輯（標準值班回報）：
  //   scheduled  = 排班為 ON 的全部人 (含當天請假者)        → 當班數 (應到)
  //   actualOn   = 排班 ON 且未請假者                       → 實到人數 (規律班員實際出勤，不含加班)
  //   otCount    = s.ot 為真者                              → 加班人數 (額外加班，獨立計算)
  //   leaveCount = 排班 ON 且 leave 為真者                  → 請假人數
  //   公式驗證：當班數 = 實到人數 + 請假
  //            現場總人數 = 實到 + 加班
  function calcStats(list){
    let scheduled=0, actualOn=0, otCount=0, leaveCount=0;
    list.forEach(eng=>{
      const s=(scheduleData[eng.id]||{})[todayKey];
      if(!s)return;
      if(s.type==='ON'){
        scheduled++;
        if(s.leave) leaveCount++;
        else        actualOn++;
      }
      if(s.ot) otCount++;
    });
    return {scheduled, actualOn, otCount, leaveCount};
  }
  const main = calcStats(mainTargets);
  const mt   = calcStats(mtTargets);

  // Header text: YYYY/MM/DD 班別_AMHS 3000組 值班回報
  const SHIFT_LABELS={
    'ALL':   '全部班別_AMHS',
    'DAY':   '早班(4A/4B)_AMHS',
    'NIGHT': '夜班(5A/5B)_AMHS'
  };
  const shiftLabel=SHIFT_LABELS[shift]||(shift+'_AMHS');
  document.getElementById('go-header-text').textContent=dateLabel+' '+shiftLabel;

  const body=document.getElementById('go-report-body');
  const titleLine=`${dateLabel} ${shiftLabel} 3000組 值班回報`;

  // 主班區塊 HTML
  let html = `
    <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.35);letter-spacing:.5px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.07);">
      ${titleLine}
    </div>
    <div class="go-row">
      <span class="go-row-label">當班數<span class="go-tag">應到</span></span>
      <span class="go-row-value accent">${main.scheduled}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">實到人數<span class="go-tag">當班−請假</span></span>
      <span class="go-row-value good">${main.actualOn}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">請假</span>
      <span class="go-row-value ${main.leaveCount>0?'warn':'good'}">${main.leaveCount}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">加班人數<span class="go-tag">OT 額外</span></span>
      <span class="go-row-value ot">${main.otCount}<span class="go-row-unit">人</span></span>
    </div>`;

  // 早班相關額外追加「保養組」區塊
  if(isDayLike){
    html += `
    <div style="margin-top:12px;padding-top:10px;border-top:1px dashed rgba(255,255,255,.12);font-size:11px;font-weight:800;color:#ffa502;letter-spacing:.6px;margin-bottom:6px;">
      <i class="bi bi-tools" style="margin-right:5px"></i>保養組
    </div>
    <div class="go-row">
      <span class="go-row-label">當班人數<span class="go-tag">應到</span></span>
      <span class="go-row-value accent">${mt.scheduled}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">實到人數<span class="go-tag">當班−請假</span></span>
      <span class="go-row-value good">${mt.actualOn}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">請假人數</span>
      <span class="go-row-value ${mt.leaveCount>0?'warn':'good'}">${mt.leaveCount}<span class="go-row-unit">人</span></span>
    </div>
    <div class="go-row">
      <span class="go-row-label">加班人數<span class="go-tag">OT 額外</span></span>
      <span class="go-row-value ot">${mt.otCount}<span class="go-row-unit">人</span></span>
    </div>`;
  }

  // 公式驗證 footer
  html += `
    <div style="margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.08);font-size:10px;color:rgba(255,255,255,.32);line-height:1.55;">
      <div>· 當班數 = 排班 ON 的全部人（含當天請假）</div>
      <div>· 實到人數 = 當班 − 請假（不含加班）</div>
      <div>· 主班現場總人數 = 實到 ${main.actualOn} + 加班 ${main.otCount} = <b style="color:rgba(255,255,255,.55)">${main.actualOn+main.otCount}</b> 人</div>
      ${isDayLike?`<div>· 保養組現場總人數 = 實到 ${mt.actualOn} + 加班 ${mt.otCount} = <b style="color:rgba(255,165,2,.7)">${mt.actualOn+mt.otCount}</b> 人</div>`:''}
    </div>`;

  body.innerHTML = html;

  // 儲存複製文字（純文字格式，提供給聊天工具貼上）
  // 保養組區塊前插入空白行，明確區隔主班與保養組
  let copyText = `${titleLine}\n當班數：${main.scheduled}\n實到人數：${main.actualOn}\n請假：${main.leaveCount}\n加班人數：${main.otCount}`;
  if(isDayLike){
    copyText += `\n\n保養組：\n當班人數：${mt.scheduled}\n實到人數：${mt.actualOn}\n請假人數：${mt.leaveCount}\n加班人數：${mt.otCount}`;
  }
  panel._copyText = copyText;
}

function copyGoReport(){
  const panel=document.getElementById('go-report-panel');
  const text=panel._copyText||'';
  if(!text){showToast('沒有可複製的內容','warning');return;}

  // fallback：建立暫時 textarea 並用 execCommand 複製（適用於 file://、http://、舊瀏覽器）
  function fallbackCopy(){
    try{
      const el=document.createElement('textarea');
      el.value=text;
      el.style.position='fixed';el.style.left='-9999px';el.style.top='0';
      document.body.appendChild(el);
      el.focus();el.select();
      const ok=document.execCommand('copy');
      document.body.removeChild(el);
      if(ok){showToast('回報文字已複製！','success');}
      else{showToast('複製失敗，請手動選取','danger');}
    }catch(err){
      showToast('複製失敗：'+err.message,'danger');
    }
  }

  // navigator.clipboard 在非 https / 非 localhost / file:// 環境會 reject → 必須有 catch fallback
  if(navigator.clipboard&&window.isSecureContext){
    navigator.clipboard.writeText(text).then(
      ()=>showToast('回報文字已複製！','success'),
      ()=>fallbackCopy()
    );
  } else {
    fallbackCopy();
  }
}

/* ── INIT ── */
window.addEventListener('DOMContentLoaded', async ()=>{
  // ★ 先建立工作階段（讀取登入資訊；未登入會導回 login.html）
  if(!await initSession()) return;

  updateGroupSel();
  renderMonthButtons();
  updateMonthLabels();
  _lastDateStr=dStr(todayNow());
  _lastShift=getCurrentShiftByTime();

  // ★ 先載入全廠共用的工號權限綁定（供登入判斷）
  await loadRoleBindingsFromServer();

  // ★ 同步分頁 UI（currentSite 可能由 session 還原）
  updateSiteTabsUI();

  // ★ 非同步從伺服器載入資料（當前站台）
  await initLoadData();

  // 補建「目前可見但尚無資料」的月份（例：剛進入視窗、還沒有檔案的 2026/09）
  // 這樣該月份按鈕一出現，點下去就有預設排班表可編輯。
  ensureVisibleMonthsBuilt();
  
  // 套用管理員設定
  try{
    const nameEl=document.getElementById('setting-admin-name');
    const idEl=document.getElementById('setting-admin-id');
    if(nameEl?.value){
      applyAdminConfig({adminName:nameEl.value, adminId:idEl?.value||'ADM-001'});
    }
  }catch(e){}
  
  // 重新渲染所有頁面（每個獨立 try）
  requestAnimationFrame(()=>{
    safeRun('buildDashboard', buildDashboard);
    safeRun('renderSchedule', renderSchedule);
    safeRun('renderCalendar', renderCalendar);
    safeRun('renderPersonnel', renderPersonnel);
    safeRun('renderAnalysis', renderAnalysis);
    safeRun('renderRoleBindings', renderRoleBindings);
    safeRun('updateStatusUI', updateStatusUI);
    safeRun('applyRoleToUI', applyRoleToUI);   // 確保側邊欄最終顯示「登入身分」
  });
  
  // 定期檢查伺服器狀態 (每 60 秒)
  setInterval(checkServerStatus, 60000);
});