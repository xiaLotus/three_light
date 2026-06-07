/**
 * auth.js — 工作管理系統 共用認證模組
 */

// ── 管理員帳號設定 ──
const ADMIN_CONFIG = {
    "FT01營運(硬)": ["F2568", "C9228"],
    "FT01營運(資)": ["K18251", "F9358"],
    "FT01營運(保)": ["F2568", "C9228"],
    "FT01值班":     ["F2568", "C9228"]
}

const SESSION_KEY = 'ftWorkMgrSession'
const API = 'http://127.0.0.1:5000'

function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}

function saveSession(account, name) {
    const acc = account.trim().toUpperCase()
    const adminOrgs = Object.entries(ADMIN_CONFIG)
        .filter(([, accs]) => accs.includes(acc))
        .map(([org]) => org)
    const session = {
        account:   acc,
        name:      name.trim() || acc,
        isAdmin:   adminOrgs.length > 0,
        adminOrgs: adminOrgs,
        loginAt:   new Date().toISOString(),
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    return session
}

function ftLogout() {
    sessionStorage.removeItem(SESSION_KEY)
    location.href = 'login.html'
}

function requireAuth() {
    const s = getSession()
    if (!s) { location.href = 'login.html'; return null }
    return s
}

function requireAdmin() {
    const s = requireAuth()
    if (!s) return null
    if (!s.isAdmin) { location.href = 'index.html'; return null }
    return s
}
