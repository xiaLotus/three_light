const API = 'http://127.0.0.1:5000'

// ── 認證（帳號存 localStorage，權限由後台 admin.json 判斷）──
const STORAGE_KEY = 'wms_account'
const getAccount  = () => localStorage.getItem(STORAGE_KEY)
const ftLogout    = () => { localStorage.removeItem(STORAGE_KEY); location.href = '../login.html' }
const requireAuth = () => { const a = getAccount(); if (!a) { location.href = '../login.html'; return null } return a }
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
    data() {
        return {
            rows:    [], loading: false, keyword: '', personFilter: '',
            lightMode: false, showNavMenu: false,
            account: '',
            userName: '', isAdmin: false, adminOrgs: [],

            // 各欄篩選
            checkedDates:[], checkedBuildings:[], checkedSites:[],
            checkedOrgs:[], checkedCases:[], checkedDescs:[],
            checkedDues:[], checkedAgos:[], checkedStatuses:[],
            activeFilter: null, panelStyle: {}, filterSearch: '',

            // 新增工作
            showAddModal: false, addForm: {}, formError: '', submitting: false,
            orgOptions:  ["FT01營運(硬)","FT01營運(資)","FT01營運(保)","FT01值班"],
            caseOptions: ["硬體異常","系統異常","品質異常","專案(年)","專案(PA)","日常(主要)","日常(一般)"],

            // 查閱 Modal
            showView: false, viewData: null,
            editForm: {}, editSubmitting: false,
            progressHistory: [], loadingProgress: false,
            newProgress: '', progressSubmitting: false,

            // 刪除
            showDel: false, delTarget: null,

            toasts: [], toastId: 0,
        }
    },

    computed: {
        baseRows() {
            if (!this.personFilter) return this.rows
            // 同時比對提案人、帳號、管理OWNER（相容舊資料）
            return this.rows.filter(i => {
                const p = i['提案人'] || ''
                const o = i['管理OWNER'] || ''
                return p.includes(this.personFilter) || (this.account && p.includes(this.account))
                    || o.includes(this.personFilter) || (this.account && o.includes(this.account))
            })
        },
        hasAnyFilter() {
            return this.checkedDates.length>0 || this.checkedBuildings.length>0 ||
                   this.checkedSites.length>0  || this.checkedOrgs.length>0    ||
                   this.checkedCases.length>0  || this.checkedDescs.length>0   ||
                   this.checkedDues.length>0   || this.checkedAgos.length>0   ||
                   this.checkedStatuses.length>0
        },
        filteredData() {
            return this.baseRows.filter(i => {
                const kw = this.keyword.trim().toLowerCase()
                if (kw) {
                    const fields = ['日期','棟別','站點','組織類別','案件分類','項目描述','項目Due Date','距今','當前最新進度','狀態']
                    if (!fields.some(f=>(i[f]||'').toLowerCase().includes(kw))) return false
                }
                const mDate = this.checkedDates.length===0     || this.checkedDates.includes(i['日期']||'')
                const mBldg = this.checkedBuildings.length===0 || this.checkedBuildings.includes(i['棟別']||'')
                const mSite = this.checkedSites.length===0     || this.checkedSites.includes(i['站點']||'')
                const mOrg  = this.checkedOrgs.length===0      || this.checkedOrgs.includes(i['組織類別']||'')
                const mCase = this.checkedCases.length===0     || this.checkedCases.includes(i['案件分類']||'')
                const mDesc = this.checkedDescs.length===0     || this.checkedDescs.includes(i['項目描述']||'')
                const mDue  = this.checkedDues.length===0      || this.checkedDues.includes(i['項目Due Date']||'')
                const mAgo    = this.checkedAgos.length===0    || this.checkedAgos.includes(i['距今']||'')
                const mStatus = this.checkedStatuses.length===0 || this.checkedStatuses.includes(i['狀態']||'')
                return mDate&&mBldg&&mSite&&mOrg&&mCase&&mDesc&&mDue&&mAgo&&mStatus
            })
        },
        // uniqueXxx computed (simplified set for personal page)
        uniqueDates()     { return [...new Set(this.baseRows.map(i=>i['日期']||''))].sort() },
        uniqueBuildings() { return [...new Set(this.baseRows.map(i=>i['棟別']||''))].sort() },
        uniqueSites()     { return [...new Set(this.baseRows.map(i=>i['站點']||''))].sort() },
        uniqueOrgs()      { return [...new Set(this.baseRows.map(i=>i['組織類別']||''))].sort() },
        uniqueCases()     { return [...new Set(this.baseRows.map(i=>i['案件分類']||''))].sort() },
        uniqueDescs()     { return [...new Set(this.baseRows.map(i=>i['項目描述']||''))].sort() },
        uniqueDues()      { return [...new Set(this.baseRows.map(i=>i['項目Due Date']||''))].sort() },
        uniqueAgos()      { return [...new Set(this.baseRows.map(i=>i['距今']||''))].sort() },
        uniqueStatuses()  { return [...new Set(this.baseRows.map(i=>i['狀態']||''))].sort() },
        currentChecked() {
            const m = {'日期':this.checkedDates,'棟別':this.checkedBuildings,'站點':this.checkedSites,
                       '組織類別':this.checkedOrgs,'案件分類':this.checkedCases,'項目描述':this.checkedDescs,
                       '項目Due Date':this.checkedDues,'距今':this.checkedAgos,'狀態':this.checkedStatuses}
            return m[this.activeFilter] || []
        },
        currentUniqueAll() {
            const m = {'日期':this.uniqueDates,'棟別':this.uniqueBuildings,'站點':this.uniqueSites,
                       '組織類別':this.uniqueOrgs,'案件分類':this.uniqueCases,'項目描述':this.uniqueDescs,
                       '項目Due Date':this.uniqueDues,'距今':this.uniqueAgos,'狀態':this.uniqueStatuses}
            return m[this.activeFilter] || []
        },
        currentOptions() {
            const s = this.filterSearch.trim().toLowerCase()
            return s ? this.currentUniqueAll.filter(v=>v.toLowerCase().includes(s)) : this.currentUniqueAll
        },
        isAllChecked() { return this.currentOptions.length>0 && this.currentOptions.every(v=>this.currentChecked.includes(v)) },
        isIndeterminate() { return this.currentOptions.some(v=>this.currentChecked.includes(v)) && !this.isAllChecked },
    },

    methods: {
        // ── 載入 ──
        async fetchData() {
            this.loading = true
            try {
                const res = await axios.get(API+'/api/all')
                this.rows = (res.data||[]).filter(Boolean)
            } catch { this.toast('❌ 載入失敗','error') }
            finally { this.loading = false }
        },

        // ── 篩選面板 ──
        openFilter(col, e) {
            if (this.activeFilter===col) { this.closeFilter(); return }
            this.activeFilter=col; this.filterSearch=''
            this.$nextTick(()=>{
                const r=e.currentTarget.getBoundingClientRect(), pw=216, ww=window.innerWidth
                let left=r.left; if(left+pw>ww-8) left=ww-pw-8
                this.panelStyle={top:`${r.bottom+4}px`,left:`${left}px`}
            })
        },
        closeFilter() { this.activeFilter=null; this.filterSearch='' },
        toggleVal(val) { const arr=this.currentChecked, idx=arr.indexOf(val); idx===-1?arr.push(val):arr.splice(idx,1) },
        toggleAll() {
            const arr=this.currentChecked
            if(this.isAllChecked) this.currentOptions.forEach(v=>{const i=arr.indexOf(v);if(i!==-1)arr.splice(i,1)})
            else this.currentOptions.forEach(v=>{if(!arr.includes(v))arr.push(v)})
        },
        clearCurrentFilter() {
            const m={'日期':'checkedDates','棟別':'checkedBuildings','站點':'checkedSites',
                     '組織類別':'checkedOrgs','案件分類':'checkedCases','項目描述':'checkedDescs',
                     '項目Due Date':'checkedDues','距今':'checkedAgos','狀態':'checkedStatuses'}
            const p=m[this.activeFilter]; if(p) this[p]=[]
        },
        resetAllFilters() {
            this.checkedDates=[]; this.checkedBuildings=[]; this.checkedSites=[]
            this.checkedOrgs=[]; this.checkedCases=[]; this.checkedDescs=[]
            this.checkedDues=[]; this.checkedAgos=[]; this.checkedStatuses=[]; this.keyword=''
            this.closeFilter()
        },

        // ── 新增工作 ──
        openAddModal() {
            this.addForm = {
                '日期': new Date().toISOString().slice(0,10),
                '提案人': this.userName || this.account,
                '棟別':'','樓層':'','站點':'',
                '組織類別': this.adminOrgs[0] || 'FT01營運(硬)',
                '案件分類': '日常(一般)',
                '項目描述':'','項目Due Date':'','單項目Due Date':'',
            }
            this.formError=''; this.showAddModal=true
        },
        async submitAdd() {
            if (!this.addForm['日期'])           { this.formError='請填寫日期'; return }
            if (!this.addForm['項目描述']?.trim()) { this.formError='請填寫項目描述'; return }
            this.submitting=true
            try {
                await axios.post(API+'/api/add', {...this.addForm, '提案人': this.userName || this.account})
                this.toast('✅ 工作新增成功','success')
                this.showAddModal=false; await this.fetchData()
            } catch { this.toast('❌ 新增失敗','error') }
            finally { this.submitting=false }
        },

        // ── 查閱 ──
        openView(row) { location.href = `view.html?id=${row['id']}&from=personal.html` },
        // ── 刪除 ──
        confirmDel(row) { this.delTarget=row; this.showDel=true },
        async doDelete() {
            if (!this.delTarget) return
            try {
                await axios.post(API+'/api/delete', {id: this.delTarget['id']})
                this.rows=this.rows.filter(r=>r['id']!==this.delTarget['id'])
                this.toast('✅ 刪除成功','success')
            } catch { this.toast('❌ 刪除失敗','error') }
            finally { this.showDel=false; this.delTarget=null }
        },

        // ── 工具 ──
        dueClass(val) {
            if (!val||val==='無') return 'tag-ok'
            if (val==='今日') return 'tag-today'
            if (val.startsWith('剩')) return 'tag-ok'
            return 'tag-overdue'
        },
        logout() { ftLogout() },
        toast(msg,type='success') {
            const id=++this.toastId; this.toasts.push({id,message:msg,type})
            setTimeout(()=>this.removeToast(id),3000)
        },
        removeToast(id) { this.toasts=this.toasts.filter(t=>t.id!==id) },
    },

    async mounted() {
        const acc = requireAuth(); if (!acc) return
        this.account = acc
        const role = await fetchRole(acc)
        this.userName  = role.name || acc
        this.personFilter = this.userName
        this.isAdmin   = role.is_admin
        this.adminOrgs = role.admin_orgs
        await this.fetchData()
        this._click = () => { this.closeFilter(); this.showNavMenu=false }
        document.addEventListener('click', this._click)
    },
    beforeUnmount() { document.removeEventListener('click', this._click) }
})

app.mount('#app')