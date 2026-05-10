const API = "http://127.0.0.1:5000"

const app = Vue.createApp({
  data() {
    const today = new Date().toISOString().slice(0, 10)
    return {
      orgOptions: ["FT01營運(硬)", "FT01營運(資)", "FT01營運(保)", "FT01值班"],
      caseOptions: ["ALL", "硬體異常", "系統異常", "品質異常", "專案(年)", "專案(PA)", "日常(主要)", "日常(一般)"],
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
      lightMode: false,
      toasts: [],
      toastId: 0,
      refreshTimer: null,
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

  watch: {
    lightMode(val) {
      document.body.classList.toggle('light', val)
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
      } catch (e) {
        this.showToast("❌ 載入失敗", "error")
      } finally {
        this.loading = false
      }
    },

    // ── 新增 Modal ──
    openAddModal() {
      const today = new Date().toISOString().slice(0, 10)
      this.addForm = {
        '日期': today,
        '提案人': '',
        '棟別': '',
        '樓層': '',
        '站點': '',
        '組織類別': 'FT01營運(硬)',
        '案件分類': '日常(一般)',
        '項目描述': '',
        '管理OWNER': '',
        '項目Due Date': today,
        '項目OWNER': '',
        '單項目Due Date': '',
        '當前最新進度': ''
      }
      this.formError = ''
      this.showAddModal = true
    },

    // ── 驗證 ──
    validate() {
      if (!this.addForm['日期'])           return '請填寫日期'
      if (!this.addForm['提案人']?.trim()) return '請填寫提案人'
      if (!this.addForm['組織類別'])       return '請選擇組織類別'
      if (!this.addForm['案件分類'])       return '請選擇案件分類'
      return ''
    },

    // ── 送出 ──
    async submitAddTask() {
      const err = this.validate()
      if (err) { this.formError = err; return }
      this.submitting = true
      try {
        await axios.post(API + "/api/add", this.addForm)
        this.showToast("✅ 資料已成功寫入 CSV", "success")
        this.showAddModal = false
        await this.fetch()
      } catch (e) {
        this.showToast("❌ 新增失敗，請稍後再試", "error")
      } finally {
        this.submitting = false
      }
    },

    // ── 查看 / 刪除 ──
    openViewModal(item)  { this.viewData = { ...item }; this.showViewModal  = true },
    confirmDelete(item)  { this.deleteTarget = item;    this.showDeleteModal = true },

    async doDelete() {
      if (!this.deleteTarget) return
      try {
        await axios.post(API + "/api/delete", { id: this.deleteTarget['id'] })
        this.showToast("✅ 刪除成功", "success")
        await this.fetch()
      } catch (e) {
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
    removeToast(id) {
      this.toasts = this.toasts.filter(t => t.id !== id)
    }
  },

  mounted() {
    this.fetch()
    this.refreshTimer = setInterval(this.fetch, 30000)
  },
  beforeUnmount() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  }
})

app.mount('#app')