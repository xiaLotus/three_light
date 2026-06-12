const API = 'http://127.0.0.1:5000'

// ── 認證（帳號存 localStorage，權限由後台 admin.json 判斷）──
const STORAGE_KEY = 'wms_account'
const getAccount  = () => localStorage.getItem(STORAGE_KEY)
const ftLogout    = () => { localStorage.removeItem(STORAGE_KEY); location.href = 'login.html' }
const requireAuth = () => { const a = getAccount(); if (!a) { location.href = 'login.html'; return null } return a }
// 向後台查詢權限：回傳 { account, is_admin, admin_orgs }
async function fetchRole(account) {
    try {
        const res = await axios.get(`${API}/api/whoami/${encodeURIComponent(account)}`)
        return res.data
    } catch {
        return { account: account, is_admin: false, admin_orgs: [] }
    }
}

const app = Vue.createApp({

    // ─────────────────────────────────────────────
    data() {
        return {
            rows:          [],
            orgOptions:    ['FT01營運(硬)', 'FT01營運(資)', 'FT01營運(保)', 'FT01值班'],
            keyword:       '',
            loading:       false,
            lightMode:     false,

            // ── 各欄篩選選中值（空陣列 = 不篩選）──
            checkedDates:       [],
            checkedPersons:     [],
            checkedBuildings:   [],
            checkedFloors:      [],
            checkedSites:       [],
            checkedOrgs:        [],
            checkedCases:       [],
            checkedDescs:       [],
            checkedMgrs:        [],
            checkedDues:        [],
            checkedAgos:        [],
            checkedOwners:      [],
            checkedSingleDues:  [],

            // ── 篩選面板狀態 ──
            activeFilter: null,
            panelStyle:   {},
            filterSearch: '',

            // ── Modal ──
            showView:  false,
            showDel:   false,
            viewData:  null,
            delTarget: null,
            newProgress:     '',

            // ── Toast ──
            toasts:  [],
            toastId: 0,
            account: '',
            userName: '',
            isAdmin: false,
            adminOrgs: [],
            showNavMenu: false,

            // ── 編輯補填 Modal ──
        }
    },

    // ─────────────────────────────────────────────
    computed: {

        // 只顯示此管理員管轄的組織
        baseRows() {
            return this.rows.filter(i => this.adminOrgs.includes(i['組織類別']))
        },

        // 管理員可見的組織（僅自己管轄的）
        managedOrgs() {
            return this.orgOptions.filter(o => this.adminOrgs.includes(o))
        },

        // 逾期數量（依目前分頁）
        overdueCount() {
            return this.baseRows.filter(i => i['距今']?.includes('逾期')).length
        },

        hasAnyFilter() {
            return this.checkedDates.length > 0      || this.checkedPersons.length > 0   ||
                   this.checkedBuildings.length > 0  || this.checkedFloors.length > 0    ||
                   this.checkedSites.length > 0      || this.checkedOrgs.length > 0      ||
                   this.checkedCases.length > 0      || this.checkedDescs.length > 0     ||
                   this.checkedMgrs.length > 0       || this.checkedDues.length > 0      ||
                   this.checkedAgos.length > 0       || this.checkedOwners.length > 0    ||
                   this.checkedSingleDues.length > 0
        },

        // ── 主篩選結果 ──────────────────────────────
        filteredData() {
            return this.baseRows.filter(i => {
                const kw = this.keyword.trim().toLowerCase()
                if (kw) {
                    const fields = ['日期','提案人','棟別','樓層','站點','組織類別',
                                    '案件分類','項目描述','管理OWNER','項目Due Date','距今',
                                    '項目OWNER','單項目Due Date','當前最新進度']
                    if (!fields.some(f => (i[f] || '').toLowerCase().includes(kw))) return false
                }

                const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')

                return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                       matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchAgo &&
                       matchOwner && matchSingleDue
            })
        },

        // ── 各欄唯一選項（以 baseRows 為母集合，排除自身）──

        uniqueDates() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchPerson && matchBuilding && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['日期'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniquePersons() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchBuilding && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['提案人'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueBuildings() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['棟別'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueFloors() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['樓層'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueSites() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['站點'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueOrgs() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['組織類別'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueCases() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchDesc && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['案件分類'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueDescs() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchMgr && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['項目描述'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueMgrs() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchDue && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['管理OWNER'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueDues() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchAgo && matchOwner && matchSingleDue
                }).map(i => i['項目Due Date'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueAgos() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchOwner     = this.checkedOwners.length     === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchOwner && matchSingleDue
                }).map(i => i['距今'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueOwners() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate      = this.checkedDates.length      === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson    = this.checkedPersons.length    === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding  = this.checkedBuildings.length  === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor     = this.checkedFloors.length     === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite      = this.checkedSites.length      === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg       = this.checkedOrgs.length       === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase      = this.checkedCases.length      === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc      = this.checkedDescs.length      === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr       = this.checkedMgrs.length       === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue       = this.checkedDues.length       === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo       = this.checkedAgos.length       === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchSingleDue = this.checkedSingleDues.length === 0 || this.checkedSingleDues.includes(i['單項目Due Date'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchSingleDue
                }).map(i => i['項目OWNER'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        uniqueSingleDues() {
            return Array.from(new Set(
                this.baseRows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['單項目Due Date'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        currentChecked() {
            const map = {
                '日期':          this.checkedDates,
                '提案人':        this.checkedPersons,
                '棟別':          this.checkedBuildings,
                '樓層':          this.checkedFloors,
                '站點':          this.checkedSites,
                '組織類別':      this.checkedOrgs,
                '案件分類':      this.checkedCases,
                '項目描述':      this.checkedDescs,
                '管理OWNER':     this.checkedMgrs,
                '項目Due Date':  this.checkedDues,
                '距今':          this.checkedAgos,
                '項目OWNER':     this.checkedOwners,
                '單項目Due Date': this.checkedSingleDues,
            }
            return map[this.activeFilter] || []
        },

        currentUniqueAll() {
            const map = {
                '日期':          this.uniqueDates,
                '提案人':        this.uniquePersons,
                '棟別':          this.uniqueBuildings,
                '樓層':          this.uniqueFloors,
                '站點':          this.uniqueSites,
                '組織類別':      this.uniqueOrgs,
                '案件分類':      this.uniqueCases,
                '項目描述':      this.uniqueDescs,
                '管理OWNER':     this.uniqueMgrs,
                '項目Due Date':  this.uniqueDues,
                '距今':          this.uniqueAgos,
                '項目OWNER':     this.uniqueOwners,
                '單項目Due Date': this.uniqueSingleDues,
            }
            return map[this.activeFilter] || []
        },

        currentOptions() {
            const s = this.filterSearch.trim().toLowerCase()
            if (!s) return this.currentUniqueAll
            return this.currentUniqueAll.filter(v => v.toLowerCase().includes(s))
        },

        isAllChecked() {
            return this.currentOptions.length > 0 &&
                   this.currentOptions.every(v => this.currentChecked.includes(v))
        },
        isIndeterminate() {
            const some = this.currentOptions.some(v => this.currentChecked.includes(v))
            return some && !this.isAllChecked
        },
    },

    // ─────────────────────────────────────────────
    methods: {

        openFilter(colKey, event) {
            if (this.activeFilter === colKey) { this.closeFilter(); return }
            this.activeFilter = colKey
            this.filterSearch = ''
            this.$nextTick(() => {
                const rect = event.currentTarget.getBoundingClientRect()
                const pw   = 216
                const winW = window.innerWidth
                let left   = rect.left
                if (left + pw > winW - 8) left = winW - pw - 8
                this.panelStyle = { top: `${rect.bottom + 4}px`, left: `${left}px` }
            })
        },

        closeFilter() { this.activeFilter = null; this.filterSearch = '' },

        toggleVal(val) {
            const arr = this.currentChecked
            const idx = arr.indexOf(val)
            if (idx === -1) arr.push(val)
            else arr.splice(idx, 1)
        },

        toggleAll() {
            const arr = this.currentChecked
            if (this.isAllChecked) {
                this.currentOptions.forEach(v => { const i = arr.indexOf(v); if (i !== -1) arr.splice(i, 1) })
            } else {
                this.currentOptions.forEach(v => { if (!arr.includes(v)) arr.push(v) })
            }
        },

        clearCurrentFilter() {
            const map = {
                '日期':          'checkedDates',
                '提案人':        'checkedPersons',
                '棟別':          'checkedBuildings',
                '樓層':          'checkedFloors',
                '站點':          'checkedSites',
                '組織類別':      'checkedOrgs',
                '案件分類':      'checkedCases',
                '項目描述':      'checkedDescs',
                '管理OWNER':     'checkedMgrs',
                '項目Due Date':  'checkedDues',
                '距今':          'checkedAgos',
                '項目OWNER':     'checkedOwners',
                '單項目Due Date': 'checkedSingleDues',
            }
            const prop = map[this.activeFilter]
            if (prop) this[prop] = []
        },

        resetAllFilters() {
            this.checkedDates = []; this.checkedPersons = []; this.checkedBuildings = []
            this.checkedFloors = []; this.checkedSites = []; this.checkedOrgs = []
            this.checkedCases = []; this.checkedDescs = []; this.checkedMgrs = []
            this.checkedDues = []; this.checkedAgos = []; this.checkedOwners = []
            this.checkedSingleDues = []; this.keyword = ''
            this.closeFilter()
        },

        openView(row) { location.href = `view.html?id=${row['id']}&from=admin.html` },
        confirmDel(row) { this.delTarget = row; this.showDel = true },

        async doDelete() {
            if (!this.delTarget) return
            try {
                await axios.post(API + '/api/delete', { id: this.delTarget['id'] })
                this.rows = this.rows.filter(r => r['id'] !== this.delTarget['id'])
                this.toast('✅ 刪除成功', 'success')
            } catch {
                this.toast('❌ 刪除失敗', 'error')
            } finally {
                this.showDel = false; this.delTarget = null
            }
        },

        dueClass(val) {
            if (!val || val === '無') return 'tag-ok'
            if (val === '今日') return 'tag-today'
            if (val.startsWith('剩')) return 'tag-ok'
            return 'tag-overdue'   // X天（無前綴）= 逾期
        },


        toast(msg, type = 'success') {
            const id = ++this.toastId
            this.toasts.push({ id, message: msg, type })
            setTimeout(() => this.removeToast(id), 3000)
        },
        removeToast(id) { this.toasts = this.toasts.filter(t => t.id !== id) },

        logout() { ftLogout() },

    },

    async mounted() {
        const acc = requireAuth()
        if (!acc) return
        const role = await fetchRole(acc)
        if (!role.is_admin) { location.href = 'index.html'; return }
        this.account   = acc
        this.isAdmin   = true
        this.userName  = role.name || acc
        this.adminOrgs = role.admin_orgs
        this.loading = true
        try {
            const res = await axios.get(API + '/api/all')
            this.rows = (res.data || []).filter(Boolean)
        } catch {
            this.toast('❌ 載入失敗', 'error')
        } finally {
            this.loading = false
        }
        this._outsideClick = () => { this.closeFilter(); this.showNavMenu = false }
        document.addEventListener('click', this._outsideClick)
    },

    beforeUnmount() {
        document.removeEventListener('click', this._outsideClick)
    },
})

app.mount('#app')
