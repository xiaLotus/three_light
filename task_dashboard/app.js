const API = "http://127.0.0.1:5000"

// ── 認證（帳號存 localStorage）──
const ADMIN_CONFIG = {
    "FT01營運(硬)": ["F2568", "C9228"],
    "FT01營運(資)": ["K18251", "F9358"],
    "FT01營運(保)": ["F2568", "C9228"],
    "FT01值班":     ["F2568", "C9228"]
}
const STORAGE_KEY  = 'wms_account'
const getAccount   = () => localStorage.getItem(STORAGE_KEY)
const isAdmin      = a => a ? Object.values(ADMIN_CONFIG).some(l => l.includes(a.toUpperCase())) : false
const getAdminOrgs = a => a ? Object.entries(ADMIN_CONFIG).filter(([,l])=>l.includes(a.toUpperCase())).map(([o])=>o) : []
const ftLogout     = () => { localStorage.removeItem(STORAGE_KEY); location.href = 'login.html' }
const requireAuth  = () => { const a=getAccount(); if(!a){location.href='login.html';return null} return a }
const requireAdmin = () => { const a=requireAuth(); if(!a)return null; if(!isAdmin(a)){location.href='index.html';return null} return a }

const app = Vue.createApp({
  data() {
    return {
      orgOptions:  ["FT01營運(硬)", "FT01營運(資)", "FT01營運(保)", "FT01值班"],
      caseOptions: ["硬體異常", "系統異常", "品質異常", "專案(年)", "專案(PA)", "日常(主要)", "日常(一般)"],
      selectedOrg: [],
      today: [],
      due: [],
      loading: false,
      submitting: false,
      showDeleteModal: false,
      showAddModal: false,
      showViewModal: false,
      deleteTarget: null,
      viewData: null,
      addForm: {},
      formError: '',
      toasts: [],
      toastId: 0,
      refreshTimer: null,
      account:   '',
      isAdmin:   false,
      adminOrgs: [],
      showNavMenu: false,
    }
  },

  computed: {
    currentDate() {
      return new Date().toLocaleDateString('zh-TW', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
      })
    },
    todayList() {
      return this.selectedOrg.length === 0
        ? this.today
        : this.today.filter(i => this.selectedOrg.includes(i['組織類別']))
    },
    dueList() {
      return this.selectedOrg.length === 0
        ? this.due
        : this.due.filter(i => this.selectedOrg.includes(i['組織類別']))
    }
  },

  methods: {
    // ── 資料載入 ──
    async fetch() {
      this.loading = true
      try {
        const res = await axios.get(API + "/api/today_page")
        this.today = (res.data.today || []).filter(Boolean)
        this.due   = (res.data.due   || []).filter(Boolean)
      } catch {
        this.showToast("❌ 載入失敗", "error")
      } finally {
        this.loading = false
      }
    },

    toggleOrg(o) {
      const idx = this.selectedOrg.indexOf(o)
      if (idx === -1) this.selectedOrg.push(o)
      else this.selectedOrg.splice(idx, 1)
    },


    dueClass(val) {
            if (!val || val === '無') return 'tag-ok'
            if (val === '今日') return 'tag-today'
            if (val.startsWith('剩')) return 'tag-ok'
            return 'tag-overdue'   // X天（無前綴）= 逾期
        },

    // ── 新增 Modal（僅基本欄位，OWNER/Due/進度留給後續介面補填）──
    openAddModal() {
      const today = new Date().toISOString().slice(0, 10)
      this.addForm = {
        '日期':      today,
        '提案人':    this.account || '',
        '棟別':      '',
        '樓層':      '',
        '站點':      '',
        '組織類別':  'FT01營運(硬)',
        '案件分類':  '日常(一般)',
        '項目描述':  '',
      }
      this.formError = ''
      this.showAddModal = true
    },

    // ── 驗證 ──
    validate() {
      if (!this.addForm['日期'])              return '請填寫日期'
      if (!this.addForm['提案人']?.trim())    return '請填寫提案人'
      if (!this.addForm['組織類別'])          return '請選擇組織類別'
      if (!this.addForm['案件分類'])          return '請選擇案件分類'
      if (!this.addForm['項目描述']?.trim())  return '請填寫項目描述'
      return ''
    },

    // ── 送出 ──
    async submitAddTask() {
      const err = this.validate()
      if (err) { this.formError = err; return }
      this.submitting = true
      try {
        await axios.post(API + "/api/add", this.addForm)
        this.showToast("✅ 資料已成功寫入", "success")
        this.showAddModal = false
        await this.fetch()
      } catch {
        this.showToast("❌ 新增失敗，請稍後再試", "error")
      } finally {
        this.submitting = false
      }
    },

    // ── 查看 / 刪除 ──
    openViewModal(item) { location.href = `view.html?id=${item['id']}&from=index.html` },
    confirmDelete(item)  { this.deleteTarget = item;    this.showDeleteModal = true },

    async doDelete() {
      if (!this.deleteTarget) return
      try {
        await axios.post(API + "/api/delete", { id: this.deleteTarget['id'] })
        this.showToast("✅ 刪除成功", "success")
        await this.fetch()
      } catch {
        this.showToast("❌ 刪除失敗", "error")
      } finally {
        this.showDeleteModal = false
        this.deleteTarget    = null
      }
    },

    // ── Toast ──
    showToast(msg, type = "success") {
      const id = ++this.toastId
      this.toasts.push({ id, message: msg, type })
      setTimeout(() => this.removeToast(id), 3000)
    },
    removeToast(id) { this.toasts = this.toasts.filter(t => t.id !== id) },

    async submitProgress() {
      if (!this.newProgress.trim()||!this.viewData) return
      this.progressSubmitting=true
      try {
        const res = await axios.post(API+'/api/progress/'+this.viewData['id'], {text: this.newProgress.trim()})
        this.progressHistory = res.data.entries || []
        this.newProgress=''; this.showToast('✅ 進度已新增','success')
      } catch { this.showToast('❌ 新增失敗','error') }
      finally { this.progressSubmitting=false }
    },

    logout() { ftLogout() }
  },

  mounted() {
    document.addEventListener('click', () => { this.showNavMenu = false })
    const acc = requireAuth()
    if (!acc) return
    this.account    = acc
    this.isAdmin    = isAdmin(acc)
    this.adminOrgs  = getAdminOrgs(acc)
    this.fetch()
    this.refreshTimer = setInterval(this.fetch, 30000)
  },
  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  }
})

app.mount('#app')
