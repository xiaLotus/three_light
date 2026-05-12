// ── 常數 ──────────────────────────────────────────────
const API_URL = 'http://127.0.0.1:5000/api/alerts';
const PREVIEW_ROWS = 5;
const charts = {};

// ── 日期工具（全域） ──────────────────────────────────
const toDateStr = (d) => d.toISOString().split('T')[0];
const getDate = (timeStr) => timeStr ? String(timeStr).split(' ')[0] : null;
const todayStr = toDateStr(new Date());
const sevenDaysAgo = () => {
  const d = new Date(); d.setDate(d.getDate() - 6);
  return toDateStr(d);
};

// ── Vue App ───────────────────────────────────────────
const app = Vue.createApp({

  data() {
    return {
      allAlerts: [],
      alerts: [],
      loading: true,
      error: null,

      // 日期篩選
      activePreset: '7d',
      filterStart: sevenDaysAgo(),
      filterEnd: todayStr,
      maxDate: todayStr,

      // 伸縮狀態
      expandedGroups: {},  // key → true = 展開
      collapsedCards: {},  // key → true = 收合
    };
  },

  computed: {
    // ── 分組 ──────────────────────────────────────────
    groupedAlerts() {
      if (!this.alerts.length) return [];
      const groups = {};
      this.alerts.forEach(item => {
        const key = `${item.棟別}|${item.樓層}|${item.站點}`;
        if (!groups[key]) {
          groups[key] = {
            key,
            棟別: item.棟別,
            樓層: item.樓層,
            站點: item.站點,
            items: [],
            搬運異常總計: 0,
            烘烤異常總計: 0,
          };
        }
        groups[key].items.push(item);
        groups[key].搬運異常總計 += Number(item['搬運未啟動台數'] || 0);
        groups[key].烘烤異常總計 += Number(item['烘烤超時台數'] || 0);
      });
      return Object.values(groups).sort((a, b) => {
        if (a.棟別 !== b.棟別) return a.棟別.localeCompare(b.棟別);
        const floorOrder = { '5F': 1, '6F': 2, '8F': 3 };
        const fd = (floorOrder[a.樓層] || 99) - (floorOrder[b.樓層] || 99);
        if (fd !== 0) return fd;
        return parseInt(a.站點) - parseInt(b.站點);
      });
    },

    filteredCount()  { return this.alerts.length; },
    totalTransport() { return this.alerts.reduce((s, i) => s + Number(i['搬運未啟動台數'] || 0), 0); },
    totalBake()      { return this.alerts.reduce((s, i) => s + Number(i['烘烤超時台數']   || 0), 0); },
  },

  watch: {
    filterStart() { this.applyFilter(); this.$nextTick(() => setTimeout(() => this.renderAllCharts(), 300)); },
    filterEnd()   { this.applyFilter(); this.$nextTick(() => setTimeout(() => this.renderAllCharts(), 300)); },
  },

  mounted() {
    this.fetchData();
  },

  methods: {
    // ── 資料篩選 ───────────────────────────────────────
    applyFilter() {
      const { filterStart: s, filterEnd: e } = this;
      if (!s || !e) { this.alerts = [...this.allAlerts]; return; }
      this.alerts = this.allAlerts.filter(item => {
        const d = getDate(item.created_at);
        return d && d >= s && d <= e;
      });
    },

    // ── 預設按鈕 ───────────────────────────────────────
    setPreset(preset) {
      this.activePreset = preset;
      const today = new Date();
      if (preset === 'today') {
        this.filterStart = toDateStr(today);
        this.filterEnd   = toDateStr(today);
      } else if (preset === '3d') {
        const d = new Date(); d.setDate(d.getDate() - 2);
        this.filterStart = toDateStr(d);
        this.filterEnd   = toDateStr(today);
      } else if (preset === '7d') {
        this.filterStart = sevenDaysAgo();
        this.filterEnd   = toDateStr(today);
      }
    },

    // ── 起始日變更 ─────────────────────────────────────
    onStartDateChange() {
      this.activePreset = 'custom';
      if (!this.filterStart) return;
      if (this.filterEnd && this.filterEnd < this.filterStart) {
        this.filterEnd = this.filterStart;
        return;
      }
      if (this.filterEnd) {
        const diff = Math.round((new Date(this.filterEnd) - new Date(this.filterStart)) / 86400000);
        if (diff > 6) {
          const capped = new Date(this.filterStart);
          capped.setDate(capped.getDate() + 6);
          this.filterEnd = toDateStr(capped);
        }
      }
    },

    // ── 結束日變更（超過 7 天跳警告） ──────────────────
    onEndDateChange() {
      this.activePreset = 'custom';
      if (!this.filterStart || !this.filterEnd) return;
      const diff = Math.round((new Date(this.filterEnd) - new Date(this.filterStart)) / 86400000);
      if (diff > 6) {
        Swal.fire({
          icon: 'warning',
          title: '查詢區間過長',
          html: `起始日到結束日最多 <b>7 天</b>，<br>目前選了 <b>${diff + 1} 天</b>，結束日已自動修正。`,
          confirmButtonText: '知道了',
          confirmButtonColor: '#0f1829',
        });
        const capped = new Date(this.filterStart);
        capped.setDate(capped.getDate() + 6);
        this.filterEnd = toDateStr(capped);
      }
    },

    // ── 格式化內文 ─────────────────────────────────────
    formatContent(text) {
      if (!text || String(text).trim() === 'N/A' || String(text).trim() === '')
        return '<span style="color:#cbd5e1;font-style:italic;">—</span>';
      return String(text).replace(/<\/?br>/gi, '<br>');
    },

    // ── Chart ID ───────────────────────────────────────
    getChartId(group) {
      return `chart-${group.key.replace(/\|/g, '-')}`;
    },

    // ── 表格展開 / 收合 ────────────────────────────────
    isExpanded(key)   { return !!this.expandedGroups[key]; },
    toggleExpand(key) { this.expandedGroups = { ...this.expandedGroups, [key]: !this.expandedGroups[key] }; },
    visibleItems(group) {
      return this.isExpanded(group.key) ? group.items : group.items.slice(0, PREVIEW_ROWS);
    },

    // ── 卡片收合 ───────────────────────────────────────
    isCollapsed(key)  { return !!this.collapsedCards[key]; },
    toggleCard(key)   { this.collapsedCards = { ...this.collapsedCards, [key]: !this.collapsedCards[key] }; },

    // ── 生成篩選日期陣列 ────────────────────────────────
    getFilterDateRange() {
      const days = [];
      const start = new Date(this.filterStart);
      const end   = new Date(this.filterEnd);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        days.push(toDateStr(new Date(d)));
      }
      return days;
    },

    // ── 繪製單一圖表 ────────────────────────────────────
    renderGroupChart(canvasId, items, retryCount = 0) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) {
        if (retryCount < 3) setTimeout(() => this.renderGroupChart(canvasId, items, retryCount + 1), 180);
        return;
      }

      const dateRange = this.getFilterDateRange();
      const stats = {};
      dateRange.forEach(d => (stats[d] = 0));
      items.forEach(item => { const d = getDate(item.created_at); if (d in stats) stats[d]++; });

      if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }

      const maxVal = Math.max(...Object.values(stats), 1);
      const year   = this.filterStart.slice(0, 4);

      try {
        charts[canvasId] = new Chart(canvas.getContext('2d'), {
          type: 'bar',
          data: {
            labels: dateRange.map(d => d.slice(5)),
            datasets: [
              {
                type: 'line', label: '趨勢',
                data: dateRange.map(d => stats[d]),
                borderColor: '#38bdf8', backgroundColor: 'transparent',
                borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
                tension: 0.4, order: 0, yAxisID: 'y',
              },
              {
                type: 'bar', label: '上拋次數',
                data: dateRange.map(d => stats[d]),
                backgroundColor: dateRange.map(d =>
                  stats[d] === 0 ? 'rgba(226,232,240,0.6)'
                  : stats[d] === maxVal ? 'rgba(239,68,68,0.7)'
                  : 'rgba(56,189,248,0.45)'
                ),
                borderColor: dateRange.map(d =>
                  stats[d] === 0 ? '#e2e8f0' : stats[d] === maxVal ? '#ef4444' : '#38bdf8'
                ),
                borderWidth: 1.5, borderRadius: 6, order: 1, yAxisID: 'y',
              },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#0f1829', titleColor: '#94a3b8',
                bodyColor: '#f1f5f9', borderColor: '#243350', borderWidth: 1, padding: 10,
                callbacks: {
                  title: (ctx) => `📅 ${year}-${ctx[0].label}`,
                  label: (ctx) => ctx.datasetIndex === 1 ? `上拋 ${ctx.parsed.y} 次` : null,
                  filter: (item) => item.datasetIndex === 1,
                },
              },
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11, family: 'IBM Plex Mono' } }, border: { color: '#e2e8f0' } },
              y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0, color: '#94a3b8', font: { size: 11 } }, grid: { color: '#f1f5f9' }, border: { color: '#e2e8f0' } },
            },
          },
        });
      } catch (e) {
        console.error(`❌ [${canvasId}] 繪圖失敗:`, e);
      }
    },

    // ── 繪製所有圖表 ────────────────────────────────────
    renderAllCharts() {
      this.groupedAlerts.forEach(group => {
        this.renderGroupChart(this.getChartId(group), group.items);
      });
    },

    // ── 取得資料 ───────────────────────────────────────
    async fetchData() {
      this.loading = true;
      this.error   = null;
      try {
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.allAlerts = await res.json();
        this.applyFilter();
        await this.$nextTick();
        setTimeout(() => this.renderAllCharts(), 350);
      } catch (err) {
        this.error     = err.message;
        this.allAlerts = [];
        this.alerts    = [];
      } finally {
        this.loading = false;
      }
    },
  },
});

app.mount('#app');