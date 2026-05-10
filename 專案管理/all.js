const API = 'http://127.0.0.1:5000'

const app = Vue.createApp({

    // ─────────────────────────────────────────────
    data() {
        return {
            rows:    [],
            keyword: '',
            loading: false,
            lightMode: false,

            // ── 各欄篩選選中值（空陣列 = 不篩選）──
            checkedDates:     [],
            checkedPersons:   [],
            checkedBuildings: [],
            checkedFloors:    [],
            checkedSites:     [],
            checkedOrgs:      [],
            checkedCases:     [],
            checkedDescs:     [],
            checkedMgrs:      [],
            checkedDues:      [],
            checkedAgos:      [],
            checkedOwners:    [],

            // ── 篩選面板狀態 ──
            activeFilter: null,
            panelStyle:   {},
            filterSearch: '',

            // ── Modal ──
            showView:  false,
            showDel:   false,
            viewData:  null,
            delTarget: null,

            // ── Toast ──
            toasts:  [],
            toastId: 0,
        }
    },

    // ─────────────────────────────────────────────
    computed: {

        hasAnyFilter() {
            return this.checkedDates.length > 0     || this.checkedPersons.length > 0   ||
                   this.checkedBuildings.length > 0 || this.checkedFloors.length > 0    ||
                   this.checkedSites.length > 0     || this.checkedOrgs.length > 0      ||
                   this.checkedCases.length > 0     || this.checkedDescs.length > 0     ||
                   this.checkedMgrs.length > 0      || this.checkedDues.length > 0      ||
                   this.checkedAgos.length > 0      || this.checkedOwners.length > 0
        },

        // ── 主篩選結果 ──────────────────────────────
        filteredData() {
            return this.rows.filter(i => {
                const kw = this.keyword.trim().toLowerCase()
                if (kw) {
                    const fields = ['日期','提案人','棟別','樓層','站點','組織類別',
                                    '案件分類','項目描述','管理OWNER','項目Due Date','距今','項目OWNER','當前最新進度']
                    if (!fields.some(f => (i[f] || '').toLowerCase().includes(kw))) return false
                }

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
            })
        },

        // ── 各欄唯一選項（排除自身、套用其他欄篩選）──

        // 日期：套用除「日期」以外所有欄篩選
        uniqueDates() {
            return Array.from(new Set(
                this.rows.filter(i => {
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
                    return matchPerson && matchBuilding && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['日期'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 提案人：套用除「提案人」以外所有欄篩選
        uniquePersons() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
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
                    return matchDate && matchBuilding && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['提案人'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 棟別：套用除「棟別」以外所有欄篩選
        uniqueBuildings() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate   = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchFloor  = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite   = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg    = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase   = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc   = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr    = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue    = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo    = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner  = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchFloor && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['棟別'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 樓層：套用除「樓層」以外所有欄篩選
        uniqueFloors() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchSite && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['樓層'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 站點：套用除「站點」以外所有欄篩選
        uniqueSites() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchOrg &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['站點'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 組織類別：套用除「組織類別」以外所有欄篩選
        uniqueOrgs() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchCase && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['組織類別'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 案件分類：套用除「案件分類」以外所有欄篩選
        uniqueCases() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchDesc && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['案件分類'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 項目描述：套用除「項目描述」以外所有欄篩選
        uniqueDescs() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchMgr && matchDue && matchAgo && matchOwner
                }).map(i => i['項目描述'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 管理OWNER：套用除「管理OWNER」以外所有欄篩選
        uniqueMgrs() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchDue      = this.checkedDues.length      === 0 || this.checkedDues.includes(i['項目Due Date'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchDue && matchAgo && matchOwner
                }).map(i => i['管理OWNER'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 項目Due Date：套用除「項目Due Date」以外所有欄篩選
        uniqueDues() {
            return Array.from(new Set(
                this.rows.filter(i => {
                    const matchDate     = this.checkedDates.length     === 0 || this.checkedDates.includes(i['日期'] || '')
                    const matchPerson   = this.checkedPersons.length   === 0 || this.checkedPersons.includes(i['提案人'] || '')
                    const matchBuilding = this.checkedBuildings.length === 0 || this.checkedBuildings.includes(i['棟別'] || '')
                    const matchFloor    = this.checkedFloors.length    === 0 || this.checkedFloors.includes(i['樓層'] || '')
                    const matchSite     = this.checkedSites.length     === 0 || this.checkedSites.includes(i['站點'] || '')
                    const matchOrg      = this.checkedOrgs.length      === 0 || this.checkedOrgs.includes(i['組織類別'] || '')
                    const matchCase     = this.checkedCases.length     === 0 || this.checkedCases.includes(i['案件分類'] || '')
                    const matchDesc     = this.checkedDescs.length     === 0 || this.checkedDescs.includes(i['項目描述'] || '')
                    const matchMgr      = this.checkedMgrs.length      === 0 || this.checkedMgrs.includes(i['管理OWNER'] || '')
                    const matchAgo      = this.checkedAgos.length      === 0 || this.checkedAgos.includes(i['距今'] || '')
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchAgo && matchOwner
                }).map(i => i['項目Due Date'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 距今：套用除「距今」以外所有欄篩選
        uniqueAgos() {
            return Array.from(new Set(
                this.rows.filter(i => {
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
                    const matchOwner    = this.checkedOwners.length    === 0 || this.checkedOwners.includes(i['項目OWNER'] || '')
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchOwner
                }).map(i => i['距今'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // 項目OWNER：套用除「項目OWNER」以外所有欄篩選
        uniqueOwners() {
            return Array.from(new Set(
                this.rows.filter(i => {
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
                    return matchDate && matchPerson && matchBuilding && matchFloor && matchSite &&
                           matchOrg && matchCase && matchDesc && matchMgr && matchDue && matchAgo
                }).map(i => i['項目OWNER'] || '')
            )).sort((a, b) => a.localeCompare(b, 'zh-TW'))
        },

        // ── 面板目前使用的 checked 陣列 與 options ──

        currentChecked() {
            const map = {
                '日期':         this.checkedDates,
                '提案人':       this.checkedPersons,
                '棟別':         this.checkedBuildings,
                '樓層':         this.checkedFloors,
                '站點':         this.checkedSites,
                '組織類別':     this.checkedOrgs,
                '案件分類':     this.checkedCases,
                '項目描述':     this.checkedDescs,
                '管理OWNER':    this.checkedMgrs,
                '項目Due Date': this.checkedDues,
                '距今':         this.checkedAgos,
                '項目OWNER':    this.checkedOwners,
            }
            return map[this.activeFilter] || []
        },

        currentUniqueAll() {
            const map = {
                '日期':         this.uniqueDates,
                '提案人':       this.uniquePersons,
                '棟別':         this.uniqueBuildings,
                '樓層':         this.uniqueFloors,
                '站點':         this.uniqueSites,
                '組織類別':     this.uniqueOrgs,
                '案件分類':     this.uniqueCases,
                '項目描述':     this.uniqueDescs,
                '管理OWNER':    this.uniqueMgrs,
                '項目Due Date': this.uniqueDues,
                '距今':         this.uniqueAgos,
                '項目OWNER':    this.uniqueOwners,
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

        // ── 篩選面板 ────────────────────────────────

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

        closeFilter() {
            this.activeFilter = null
            this.filterSearch = ''
        },

        // 即時切換單一值
        toggleVal(val) {
            const arr = this.currentChecked
            const idx = arr.indexOf(val)
            if (idx === -1) arr.push(val)
            else arr.splice(idx, 1)
        },

        // 全選 / 取消全選（只作用在搜尋後可見選項）
        toggleAll() {
            const arr = this.currentChecked
            if (this.isAllChecked) {
                this.currentOptions.forEach(v => {
                    const i = arr.indexOf(v)
                    if (i !== -1) arr.splice(i, 1)
                })
            } else {
                this.currentOptions.forEach(v => {
                    if (!arr.includes(v)) arr.push(v)
                })
            }
        },

        // 清除目前開啟欄位的篩選
        clearCurrentFilter() {
            const map = {
                '日期':         'checkedDates',
                '提案人':       'checkedPersons',
                '棟別':         'checkedBuildings',
                '樓層':         'checkedFloors',
                '站點':         'checkedSites',
                '組織類別':     'checkedOrgs',
                '案件分類':     'checkedCases',
                '項目描述':     'checkedDescs',
                '管理OWNER':    'checkedMgrs',
                '項目Due Date': 'checkedDues',
                '距今':         'checkedAgos',
                '項目OWNER':    'checkedOwners',
            }
            const prop = map[this.activeFilter]
            if (prop) this[prop] = []
        },

        resetAllFilters() {
            this.checkedDates     = []
            this.checkedPersons   = []
            this.checkedBuildings = []
            this.checkedFloors    = []
            this.checkedSites     = []
            this.checkedOrgs      = []
            this.checkedCases     = []
            this.checkedDescs     = []
            this.checkedMgrs      = []
            this.checkedDues      = []
            this.checkedAgos      = []
            this.checkedOwners    = []
            this.keyword          = ''
            this.closeFilter()
        },

        // ── 查看 / 刪除 ─────────────────────────────

        openView(row)   { this.viewData = { ...row }; this.showView = true },
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
                this.showDel   = false
                this.delTarget = null
            }
        },

        // ── 工具 ────────────────────────────────────

        dueClass(val) {
            if (!val) return 'tag-ok'
            if (val.includes('逾期')) return 'tag-overdue'
            if (val === '今日') return 'tag-today'
            return 'tag-ok'
        },

        toggleTheme() {
            this.lightMode = !this.lightMode
            document.body.classList.toggle('light', this.lightMode)
        },

        toast(msg, type = 'success') {
            const id = ++this.toastId
            this.toasts.push({ id, message: msg, type })
            setTimeout(() => this.removeToast(id), 3000)
        },
        removeToast(id) { this.toasts = this.toasts.filter(t => t.id !== id) },
    },

    // ─────────────────────────────────────────────
    async mounted() {
        this.loading = true
        try {
            const res = await axios.get(API + '/api/all')
            this.rows = (res.data || []).filter(Boolean)
        } catch {
            this.toast('❌ 載入失敗', 'error')
        } finally {
            this.loading = false
        }

        // 點擊面板外部關閉
        this._outsideClick = () => { this.closeFilter() }
        document.addEventListener('click', this._outsideClick)
    },

    beforeUnmount() {
        document.removeEventListener('click', this._outsideClick)
    },
})

app.mount('#app')