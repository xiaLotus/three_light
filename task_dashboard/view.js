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


Vue.createApp({
    data() {
        return {
            task:    null,
            loading: true,
            taskId:  null,
            backUrl: 'index.html',
            isAdmin: false,

            orgOptions:  ["FT01營運(硬)","FT01營運(資)","FT01營運(保)","FT01值班"],
            caseOptions: ["硬體異常","系統異常","品質異常","專案(年)","專案(PA)","日常(主要)","日常(一般)"],

            // 所有可編輯欄位合一
            editForm:       {},
            editSubmitting: false,

            // Progress node tree
            progressTree:       [],
            currentPath:        [],
            loadingProgress:    false,
            newProgress:        '',
            progressSubmitting: false,

            toasts:  [],
            toastId: 0,
        }
    },

    computed: {
        currentLevelNodes() {
            if (this.currentPath.length === 0) return this.progressTree
            return this.currentPath[this.currentPath.length - 1].children || []
        },
    },

    methods: {
        dueClass(val) {
            if (!val||val==='無') return 'tag-ok'
            if (val==='今日') return 'tag-today'
            if (val.startsWith('剩')) return 'tag-ok'
            return 'tag-overdue'
        },

        // ── Node navigation ──
        enterNode(node) { this.currentPath.push(node) },
        goBack()        { if (this.currentPath.length>0) this.currentPath.pop() },
        navigateTo(idx) {
            this.currentPath = idx===-1 ? [] : this.currentPath.slice(0, idx+1)
        },

        // ── 儲存所有變更 ──
        async submitEdit() {
            this.editSubmitting = true
            try {
                await axios.post(API+'/api/update', { id: this.taskId, ...this.editForm })
                Object.assign(this.task, this.editForm)
                // 重新計算距今（前端）
                this.toast('✅ 變更已儲存', 'success')
            } catch { this.toast('❌ 儲存失敗', 'error') }
            finally { this.editSubmitting = false }
        },

        // ── 新增進度節點 ──
        async submitProgress() {
            if (!this.newProgress.trim()) return
            this.progressSubmitting = true
            const parentId = this.currentPath.length>0
                ? this.currentPath[this.currentPath.length-1].id : null
            try {
                const res = await axios.post(`${API}/api/progress/${this.taskId}`, {
                    text: this.newProgress.trim(), parent_id: parentId
                })
                this.progressTree = res.data.tree || []
                this._resyncPath()
                this.newProgress = ''
                this.toast('✅ 節點已新增', 'success')
            } catch { this.toast('❌ 新增失敗', 'error') }
            finally { this.progressSubmitting = false }
        },

        _resyncPath() {
            const find = (nodes, id) => {
                for (const n of nodes) {
                    if (n.id===id) return n
                    const f = find(n.children||[], id)
                    if (f) return f
                }
                return null
            }
            const newPath = []
            for (const crumb of this.currentPath) {
                const found = find(this.progressTree, crumb.id)
                if (found) newPath.push(found)
                else break
            }
            this.currentPath = newPath
        },

        toast(msg, type='success') {
            const id = ++this.toastId
            this.toasts.push({id, message:msg, type})
            setTimeout(()=>this.removeToast(id), 3000)
        },
        removeToast(id) { this.toasts = this.toasts.filter(t=>t.id!==id) },
    },

    async mounted() {
        const acc = requireAuth(); if (!acc) return
        const role = await fetchRole(acc)
        this.isAdmin = role.is_admin

        const params = new URLSearchParams(location.search)
        this.taskId  = params.get('id')
        this.backUrl = params.get('from') || 'index.html'

        if (!this.taskId) { this.loading=false; return }

        // 取任務
        try {
            const res = await axios.get(API+'/api/all')
            this.task = (res.data||[]).find(r=>r['id']===this.taskId) || null
            if (this.task) {
                this.editForm = {
                    '項目描述':      this.task['項目描述']     || '',
                    '案件分類':      this.task['案件分類']     || '日常(一般)',
                    '組織類別':      this.task['組織類別']     || 'FT01營運(硬)',
                    '棟別':          this.task['棟別']         || '',
                    '樓層':          this.task['樓層']         || '',
                    '站點':          this.task['站點']         || '',
                    '項目Due Date':  this.task['項目Due Date'] || '',
                    '管理OWNER':     this.task['管理OWNER']    || '',
                    '項目OWNER':     this.task['項目OWNER']    || '',
                    '單項目Due Date':this.task['單項目Due Date']|| '',
                }
            }
        } catch { this.task=null }
        finally { this.loading=false }

        // 取進度樹
        if (this.task) {
            this.loadingProgress=true
            try {
                const res = await axios.get(`${API}/api/progress/${this.taskId}`)
                this.progressTree = res.data || []
            } catch { this.progressTree=[] }
            finally { this.loadingProgress=false }
        }
    },
}).mount('#app')
