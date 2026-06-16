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


Vue.createApp({
    data() {
        return {
            task:    null,
            loading: true,
            taskId:  null,
            backUrl: 'home.html',
            isAdmin: false,
            account: '',
            userName: '',
            adminOrgs: [],

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

            // 節點編輯
            editingNodeId:   null,
            editingNodeText: '',
            nodeSubmitting:  false,

            // 節點刪除確認
            showDelNode:  false,
            delNodeTarget: null,
        }
    },

    computed: {
        // 本人（提案人）或該任務組織的管理員才可修改
        isOrgAdmin() {
            return !!this.task && this.adminOrgs.includes(this.task['組織類別'])
        },
        canEdit() {
            if (!this.task) return false
            const p = this.task['提案人'] || ''
            return p === this.userName || p === this.account || this.isOrgAdmin
        },
        // 節點可修改/刪除：提案人、項目OWNER、該組織管理員
        canEditNode() {
            if (!this.task) return false
            const proposer = this.task['提案人'] || ''
            const owner    = this.task['項目OWNER'] || ''
            const matchName = (field) => field === this.userName || field === this.account
            return matchName(proposer) || matchName(owner) || this.isOrgAdmin
        },
        currentLevelNodes() {
            const nodes = this.currentPath.length === 0
                ? this.progressTree
                : (this.currentPath[this.currentPath.length - 1].children || [])
            // 最新的排最上面（依時間倒序）
            return [...nodes].sort((a, b) => (b.time || '').localeCompare(a.time || ''))
        },
    },


    watch: {
        // 即時偵測兩個日期欄位，自動更新 task 的距今
        'editForm.項目Due Date'(val) {
            // 只有在沒有單項目截止日期時，才用項目截止日期計算
            if (!this.editForm['單項目Due Date']) {
                this.task['距今'] = this.calcDaysDue(val)
            }
        },
        'editForm.單項目Due Date'(val) {
            // 單項目截止日期優先；清空時 fallback 到項目截止日期
            if (val) {
                this.task['距今'] = this.calcDaysDue(val)
            } else {
                this.task['距今'] = this.calcDaysDue(this.editForm['項目Due Date'] || '')
            }
        },
    },

    methods: {
        calcDaysDue(dateStr) {
            if (!dateStr) return '無'
            const d     = new Date(dateStr)
            const today = new Date(); today.setHours(0,0,0,0)
            const delta = Math.round((d - today) / 86400000)
            if (delta > 0)  return `剩 ${delta} 天`
            if (delta === 0) return '今日'
            return `${Math.abs(delta)}天`
        },

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
            if (!this.canEdit) { this.toast('❌ 僅提案人本人或該組織管理員可修改', 'error'); return }
            this.editSubmitting = true
            try {
                await axios.post(API+'/api/update', { id: this.taskId, _account: this.account, ...this.editForm })
                Object.assign(this.task, this.editForm)
                // 即時更新前端的距今顯示
                // 單項目Due Date 優先，沒有才用 項目Due Date
                const dueDateForCalc = this.editForm['單項目Due Date'] || this.editForm['項目Due Date'] || ''
                this.task['距今'] = this.calcDaysDue(dueDateForCalc)
                this.toast('✅ 變更已儲存', 'success')
            } catch (e) {
                if (e.response?.status === 403) this.toast('❌ 無修改權限：僅提案人或該組織管理員', 'error')
                else this.toast('❌ 儲存失敗', 'error')
            }
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
                if (this.task) this.task['當前最新進度'] = res.data.latest || this.newProgress.trim()
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

        // ── 節點編輯 ──
        startEditNode(node) {
            this.editingNodeId   = node.id
            this.editingNodeText = node.text
        },
        cancelEditNode() {
            this.editingNodeId   = null
            this.editingNodeText = ''
        },
        async submitEditNode(node) {
            if (!this.editingNodeText.trim()) return
            this.nodeSubmitting = true
            try {
                const res = await axios.post(`${API}/api/progress/${this.taskId}/node/${node.id}`, {
                    text: this.editingNodeText.trim()
                })
                this.progressTree = res.data.tree || []
                this._resyncPath()
                // 同步更新前端顯示的當前最新進度
                if (this.task) this.task['當前最新進度'] = res.data.latest || this.editingNodeText.trim()
                this.cancelEditNode()
                this.toast('✅ 節點已更新', 'success')
            } catch { this.toast('❌ 更新失敗', 'error') }
            finally { this.nodeSubmitting = false }
        },

        // ── 節點刪除 ──
        confirmDelNode(node) { this.delNodeTarget = node; this.showDelNode = true },
        cancelDelNode()      { this.delNodeTarget = null; this.showDelNode = false },
        async doDelNode() {
            if (!this.delNodeTarget) return
            try {
                const res = await axios.delete(`${API}/api/progress/${this.taskId}/node/${this.delNodeTarget.id}`)
                this.progressTree = res.data.tree || []
                this._resyncPath()
                // 同步更新前端顯示的當前最新進度
                if (this.task) this.task['當前最新進度'] = res.data.latest || ''
                this.toast('✅ 節點已刪除', 'success')
            } catch { this.toast('❌ 刪除失敗', 'error') }
            finally { this.cancelDelNode() }
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
        this.account = acc
        const role = await fetchRole(acc)
        this.userName  = role.name || acc
        this.isAdmin   = role.is_admin
        this.adminOrgs = role.admin_orgs || []

        const params = new URLSearchParams(location.search)
        this.taskId  = params.get('id')
        this.backUrl = params.get('from') || 'home.html'

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
                    '狀態':          this.task['狀態']         || 'Pending',
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