// ─────────────────────────────────────────────────────────────────
//  app.js  ·  設備狀態時序圖
// ─────────────────────────────────────────────────────────────────

const BATCH_SIZE     = 20;
const MIN_LOADING_MS = 1200;
const SCROLL_THR     = 400;
const STATS_CHUNK    = 1500;
const LABEL_CUTOFF   = 96;
const MAX_DAYS       = 30;      // 自訂日期最多 30 天

const app = Vue.createApp({
    data() {
        return {
            loading             : true,
            error               : null,
            timelineData        : [],
            stats               : null,
            selectedStation     : null,
            quickRange          : 1,
            customStartDate     : '',
            customEndDate       : '',
            filterRange         : {},
            availableBuildings  : [],
            availableFloors     : [],
            buildingFloorCombinations: [],
            selectedBuilding    : '',
            selectedFloor       : '',
            selectedProcessCode : null,
            visibleStationCount : BATCH_SIZE,
            sidebarCollapsed    : false,

            // 搜尋計時器
            isSearching  : false,
            searchElapsed: 0,
            _timerHandle : null,

            // 私有
            _abortController: null,
            _centerLoadStart: 0,
            _scrollEl: null,
            _onScroll: null,
        };
    },

    computed: {
        filteredTimelineData() {
            if (!this.selectedProcessCode) return this.timelineData;
            return this.timelineData.filter(d => d.station.includes(this.selectedProcessCode));
        },
        chartStations() {
            return [...new Set(this.filteredTimelineData.map(d => d.station))];
        },
        visibleChartStations() {
            return this.chartStations.slice(0, this.visibleStationCount);
        },
        hasMoreStations() {
            return this.visibleStationCount < this.chartStations.length;
        },
        chartTimeRange() {
            const min = this._getChartMinTime();
            const max = this._getChartMaxTime();
            return {
                min: min ? new Date(min).getTime() : 0,
                max: max ? new Date(max).getTime() : Date.now()
            };
        },
        timeTicks() {
            const { min, max } = this.chartTimeRange;
            const total = max - min;
            if (total <= 0) return [];
            const hours = total / 3_600_000;
            const labelInterval = hours <= 48 ? 1 : hours <= 168 ? 6 : 24;
            const ticks = [];
            let t = new Date(Math.ceil(min / 3_600_000) * 3_600_000);
            while (t.getTime() <= max) {
                const pos = (t.getTime() - min) / total * 100;
                if (pos >= 0 && pos <= 100) {
                    ticks.push({
                        pos,
                        showLabel: t.getHours() % labelInterval === 0,
                        label: `${String(t.getMonth()+1).padStart(2,'0')}/${String(t.getDate()).padStart(2,'0')} ${String(t.getHours()).padStart(2,'0')}:00`
                    });
                }
                t = new Date(t.getTime() + 3_600_000);
            }
            return ticks;
        },
        timeTickLabels() {
            return this.timeTicks.filter(t => t.showLabel && t.pos <= LABEL_CUTOFF);
        },
        availableProcessCodes() {
            const codes = new Set();
            this.timelineData.forEach(d => {
                const m = d.station.match(/(\d{4})/);
                if (m) codes.add(m[1]);
            });
            return [...codes].sort();
        },
        buildingFloors() {
            const result = {};
            this.buildingFloorCombinations.forEach(c => {
                if (!result[c.building]) result[c.building] = [];
                if (!result[c.building].includes(c.floor))
                    result[c.building].push(c.floor);
            });
            Object.keys(result).forEach(b => result[b].sort());
            return result;
        },
        currentDownRate() {
            if (!this.selectedStation || !this.stats?.[this.selectedStation]) return 0;
            const alarm = this.stats[this.selectedStation].ALARM.totalMinutes || 0;
            return Math.max(0, Math.min(100, alarm / (24 * 60) * 100));
        },
    },

    mounted() {
        this.fetchFilters();
    },

    beforeUnmount() {
        this._detachScroll();
        this._stopTimer();
    },

    methods: {

        // ── Sidebar 收合 ────────────────────────────────────────────
        toggleSidebar() {
            this.sidebarCollapsed = !this.sidebarCollapsed;
        },

        // ── 搜尋計時器 ──────────────────────────────────────────────
        _startTimer() {
            this._stopTimer();
            this.searchElapsed = 0;
            this.isSearching   = true;
            this._timerHandle  = setInterval(() => { this.searchElapsed++; }, 1000);
        },

        _stopTimer() {
            if (this._timerHandle) { clearInterval(this._timerHandle); this._timerHandle = null; }
            this.isSearching = false;
        },

        // ── Loading 控制 ────────────────────────────────────────────
        showCenterLoading() {
            this._centerLoadStart = Date.now();
            const el  = document.getElementById('centerLoading');
            const bar = el?.querySelector('.cl-progress-bar');
            if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; }
            el?.classList.add('active');
            this._setStatus('正在查詢資料');
            this._startTimer();
        },

        hideCenterLoading() {
            const remaining = Math.max(0, MIN_LOADING_MS - (Date.now() - this._centerLoadStart));
            setTimeout(() => {
                document.getElementById('centerLoading')?.classList.remove('active');
                this._stopTimer();
            }, remaining);
        },

        _setStatus(msg) {
            const el = document.getElementById('clStatusText');
            if (el) el.textContent = msg;
        },

        _hideInitialLoading() {
            const ls = document.getElementById('loadingScreen');
            if (!ls || ls.style.display === 'none') return;
            ls.classList.add('fade-out');
            document.getElementById('app')?.classList.add('show');
            setTimeout(() => { ls.style.display = 'none'; }, 550);
        },

        // ── 虛擬滾動 ────────────────────────────────────────────────
        _attachScroll() {
            this._detachScroll();
            const el = document.querySelector('.main-content');
            if (!el) return;
            this._scrollEl = el;
            this._onScroll = () => {
                if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THR)
                    this._loadMore();
            };
            el.addEventListener('scroll', this._onScroll, { passive: true });
        },

        _detachScroll() {
            if (this._scrollEl && this._onScroll) {
                this._scrollEl.removeEventListener('scroll', this._onScroll);
                this._scrollEl = null; this._onScroll = null;
            }
        },

        _loadMore() {
            const total = this.chartStations.length;
            if (this.visibleStationCount < total)
                this.visibleStationCount = Math.min(this.visibleStationCount + BATCH_SIZE, total);
        },

        // ── 30 天驗證（SweetAlert2）────────────────────────────────
        _validateDateRange(start, end) {
            const diffMs   = new Date(end) - new Date(start);
            const diffDays = diffMs / 86_400_000;
            if (diffDays < 0) {
                Swal.fire({ icon: 'error', title: '日期錯誤', text: '結束日期不能早於開始日期', confirmButtonText: '確認', confirmButtonColor: '#2563eb' });
                return false;
            }
            if (diffDays > MAX_DAYS) {
                Swal.fire({ icon: 'warning', title: `超過 ${MAX_DAYS} 天限制`, text: `為避免頁面過載，查詢範圍請勿超過 ${MAX_DAYS} 天。\n目前選擇了 ${Math.ceil(diffDays)} 天。`, confirmButtonText: '我知道了', confirmButtonColor: '#2563eb' });
                return false;
            }
            return true;
        },

        // ── API ─────────────────────────────────────────────────────
        async fetchFilters() {
            try {
                const res  = await fetch('http://127.0.0.1:5000/api/filters');
                const data = await res.json();
                this.availableBuildings        = data.buildings;
                this.availableFloors           = data.floors;
                this.buildingFloorCombinations = data.combinations;

                const sv = k => localStorage.getItem(k);
                const savedBuilding   = sv('selectedBuilding');
                const savedFloor      = sv('selectedFloor');
                const savedQuickRange = sv('quickRange');
                const savedStart      = sv('customStartDate');
                const savedEnd        = sv('customEndDate');

                if (savedBuilding && this.availableBuildings.includes(savedBuilding))
                    this.selectedBuilding = savedBuilding;
                else if (this.availableBuildings.includes('K11'))
                    this.selectedBuilding = 'K11';
                else if (this.availableBuildings.length)
                    this.selectedBuilding = this.availableBuildings[0];

                if (savedFloor && this.availableFloors.includes(savedFloor))
                    this.selectedFloor = savedFloor;
                else if (this.availableFloors.includes('5F'))
                    this.selectedFloor = '5F';

                if (savedQuickRange && savedQuickRange !== 'null')
                    this.quickRange = parseInt(savedQuickRange);

                if (savedStart) this.customStartDate = savedStart;
                if (savedEnd)   this.customEndDate   = savedEnd;

                if (this.customStartDate && this.customEndDate)
                    this.fetchData({ start: this.customStartDate, end: this.customEndDate });
                else
                    this.fetchData({ days: this.quickRange });

            } catch (err) {
                this.error   = '無法連接到後台服務，請確認 http://127.0.0.1:5000 是否運行中';
                this.loading = false;
                this._hideInitialLoading();
            }
        },

        async fetchData(params = {}) {
            this._abortController?.abort();
            this._abortController = new AbortController();
            const signal = this._abortController.signal;
            this.visibleStationCount = BATCH_SIZE;

            try {
                const q = new URLSearchParams();
                if (params.days != null) {
                    q.append('days', Math.max(1, parseInt(params.days) || 1));
                } else if (params.start && params.end) {
                    q.append('start', params.start);
                    q.append('end',   params.end);
                }
                if (this.selectedBuilding) q.append('building', this.selectedBuilding);
                if (this.selectedFloor)    q.append('floor',    this.selectedFloor);

                this.filterRange = params;
                this._setStatus('正在查詢資料');

                const res = await fetch(`http://127.0.0.1:5000/api/timeline-data?${q}`, { signal });
                if (!res.ok) throw new Error('無法載入數據');

                this._setStatus('正在處理資料');
                const raw = await res.json();

                // Object.freeze：關閉 Vue 深層響應式，大幅提升效能
                this.timelineData = Object.freeze(raw);

                this.loading = false;
                await this.$nextTick();

                this._setStatus('正在計算統計');
                await this.calculateStats();

                this._setStatus('完成！');
                await this.$nextTick();
                this._attachScroll();
                this.hideCenterLoading();

                if (document.getElementById('loadingScreen')?.style.display !== 'none')
                    setTimeout(() => this._hideInitialLoading(), 150);

            } catch (err) {
                if (err.name === 'AbortError') return;
                this.error   = err.message;
                this.loading = false;
                this.hideCenterLoading();
                this._hideInitialLoading();
            }
        },

        // ── 篩選操作 ────────────────────────────────────────────────
        selectBuilding(building) {
            if (this.selectedBuilding === building) {
                // 再次點擊同一棟 → 收起，清除樓層
                this.selectedBuilding = '';
                this.selectedFloor    = '';
            } else {
                // 切換到新廠棟 → 一定清除舊樓層，讓 API 撈整棟資料
                this.selectedBuilding = building;
                this.selectedFloor    = '';
            }
            this.selectedProcessCode = null;
            this._onLocationChange();
        },

        selectFloor(floor) {
            this.selectedFloor       = this.selectedFloor === floor ? '' : floor;
            this.selectedProcessCode = null;
            this._onLocationChange();
        },

        selectProcessCode(code) {
            if (this.selectedProcessCode === code && this.availableProcessCodes.length <= 1) return;
            this.selectedProcessCode = this.selectedProcessCode === code ? null : code;
            this.visibleStationCount = BATCH_SIZE;
            this.calculateStats();
        },

        _onLocationChange() {
            localStorage.setItem('selectedBuilding', this.selectedBuilding);
            // 樓層為空時移除，避免重新整理後誤帶舊樓層
            if (this.selectedFloor) {
                localStorage.setItem('selectedFloor', this.selectedFloor);
            } else {
                localStorage.removeItem('selectedFloor');
            }
            this.showCenterLoading();
            if (this.customStartDate && this.customEndDate)
                this.fetchData({ start: this.customStartDate, end: this.customEndDate });
            else
                this.fetchData({ days: this.quickRange ?? 1 });
        },

        selectQuickRange(days) {
            this.quickRange      = days;
            this.customStartDate = '';
            this.customEndDate   = '';
            localStorage.setItem('quickRange', days);
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            this.showCenterLoading();
            this.fetchData({ days });
        },

        applyCustomRange() {
            if (!this.customStartDate || !this.customEndDate) {
                Swal.fire({ icon: 'info', title: '請選擇日期', text: '請同時選擇開始與結束日期', confirmButtonText: '確認', confirmButtonColor: '#2563eb' });
                return;
            }
            if (!this._validateDateRange(this.customStartDate, this.customEndDate)) return;

            this.quickRange = null;
            localStorage.setItem('customStartDate', this.customStartDate);
            localStorage.setItem('customEndDate',   this.customEndDate);
            localStorage.removeItem('quickRange');
            this.showCenterLoading();
            this.fetchData({ start: this.customStartDate, end: this.customEndDate });
        },

        resetFilter() {
            this.customStartDate = '';
            this.customEndDate   = '';
            this.quickRange      = 1;
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            localStorage.setItem('quickRange', 1);
            this.showCenterLoading();
            this.fetchData({ days: 1 });
        },

        // ── 時間工具 ────────────────────────────────────────────────
        _getChartMinTime() {
            if (this.filterRange.days)
                return new Date(Date.now() - this.filterRange.days * 86_400_000);
            if (this.filterRange.start)
                return new Date(this.filterRange.start);
            return null;
        },

        _getChartMaxTime() {
            if (this.filterRange.end) return new Date(this.filterRange.end);
            return new Date();
        },

        // ── calculateStats：非同步分批 ──────────────────────────────
        async calculateStats() {
            const data  = this.filteredTimelineData;
            const stats = {};
            const fmt = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

            for (let i = 0; i < data.length; i += STATS_CHUNK) {
                data.slice(i, i + STATS_CHUNK).forEach(item => {
                    if (!stats[item.station])
                        stats[item.station] = { ALARM: { count:0, totalMinutes:0 }, BUSY: { count:0, totalMinutes:0 }, timeline: [] };

                    const raw    = (item.status || '').toUpperCase().trim();
                    const status = raw.startsWith('ALARM') ? 'ALARM' : raw.startsWith('BUSY') ? 'BUSY' : null;
                    if (!status) return;

                    stats[item.station][status].count++;
                    stats[item.station][status].totalMinutes += item.duration_minutes;
                    stats[item.station].timeline.push({
                        status,
                        start: item.start, end: item.end,
                        startFormatted: fmt(new Date(item.start)),
                        endFormatted:   fmt(new Date(item.end)),
                        duration: Math.round(item.duration_minutes)
                    });
                });
                if (i + STATS_CHUNK < data.length)
                    await new Promise(r => setTimeout(r, 0));
            }

            for (const st in stats) {
                stats[st].ALARM.hours = (stats[st].ALARM.totalMinutes / 60).toFixed(1);
                stats[st].BUSY.hours  = (stats[st].BUSY.totalMinutes  / 60).toFixed(1);
            }

            this.stats = stats;
            const keys = Object.keys(stats);
            if (!this.selectedStation || !stats[this.selectedStation])
                this.selectedStation = keys.length ? keys[0] : null;
        },

        // ── 圖表輔助 ────────────────────────────────────────────────
        getStationItems(station) {
            return this.filteredTimelineData.filter(d => d.station === station);
        },

        getBarStyle(item) {
            const { min, max } = this.chartTimeRange;
            const total = max - min;
            if (total <= 0) return {};
            const s = new Date(item.start).getTime();
            const e = new Date(item.end).getTime();
            return {
                position: 'absolute',
                left:  Math.max(0, (s - min) / total * 100) + '%',
                width: Math.max(0.05, (e - s) / total * 100) + '%',
                top: '0', height: '100%',
                backgroundColor: item.status === 'ALARM' ? '#ef4444' : '#22c55e',
                cursor: 'pointer',
            };
        },

        getBarTooltip(item) {
            const fmt = t => new Date(t).toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
            return `${item.status}  ${fmt(item.start)} → ${fmt(item.end)}  (${Math.round(item.duration_minutes)} 分)`;
        },

        onBarClick(station) {
            this.selectedStation = station;
            this.$nextTick(() => {
                const s = document.getElementById('statsSection');
                if (s) {
                    s.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    s.style.boxShadow = '0 0 20px rgba(59,130,246,0.5)';
                    setTimeout(() => { s.style.boxShadow = ''; }, 1200);
                }
            });
        },
    }
});

app.mount('#app');

// Fallback：最長 8 秒後強制隱藏初始 loading
window.addEventListener('load', () => {
    setTimeout(() => {
        const ls = document.getElementById('loadingScreen');
        if (ls && ls.style.display !== 'none') {
            ls.classList.add('fade-out');
            document.getElementById('app')?.classList.add('show');
            setTimeout(() => { ls.style.display = 'none'; }, 550);
        }
    }, 8000);
});