const app = Vue.createApp({
    data() {
        return {
            loading: true,
            centerLoading: false, // 中間載入動畫狀態
            error: null,
            timelineData: [],
            charts: [],
            stats: null,
            selectedStation: null,
            quickRange: 1,
            customStartDate: '',
            customEndDate: '',
            filterRange: {},
            availableBuildings: [],
            availableFloors: [],
            buildingFloorCombinations: [],
            selectedBuilding: '',
            selectedFloor: '',
            selectedProcessCode: null,
            _renderTimer: null  // debounce handle
        };
    },
    
    computed: {
        chartStations() {
            return [...new Set(this.filteredTimelineData.map(d => d.station))];
        },

        chartTimeRange() {
            const min = this.getChartMinTime();
            const max = this.getChartMaxTime();
            return {
                min: min ? new Date(min).getTime() : 0,
                max: max ? new Date(max).getTime() : Date.now()
            };
        },

        timeTicks() {
            const { min, max } = this.chartTimeRange;
            const total = max - min;
            if (total <= 0) return [];
            const ticks = [];
            const hours = total / 3600000;
            // Show label every 1h (≤2d), 6h (≤7d), or 24h (>7d); grid lines always every hour
            const labelInterval = hours <= 48 ? 1 : hours <= 7 * 24 ? 6 : 24;
            // Start from the first exact hour at or after min
            let t = new Date(Math.ceil(min / 3600000) * 3600000);
            const endTime = new Date(max);
            while (t <= endTime) {
                const pos = (t.getTime() - min) / total * 100;
                if (pos >= 0 && pos <= 100) {
                    const showLabel = (t.getHours() % labelInterval === 0);
                    const label = `${String(t.getMonth()+1).padStart(2,'0')}/${String(t.getDate()).padStart(2,'0')} ${String(t.getHours()).padStart(2,'0')}:00`;
                    ticks.push({ pos, label, showLabel });
                }
                t = new Date(t.getTime() + 3600000);
            }
            return ticks;
        },

        timeTickLabels() {
            return this.timeTicks.filter(t => t.showLabel);
        },

        chartHeight() {
            // 使用未過濾的資料決定高度，避免切換製程代號時觸發 canvas 重建
            const stations = [...new Set(this.filteredTimelineData.map(d => d.station))];
            return Math.max(800, stations.length * 160);
        },
        currentDownRate() {
            if (!this.selectedStation || !this.stats[this.selectedStation]) return 0;

            const alarmMinutes = this.stats[this.selectedStation].ALARM.totalMinutes || 0;
            const totalMinutes = 24 * 60;

            const upRate = ((totalMinutes - alarmMinutes) / totalMinutes) * 100;

            return Math.max(0, Math.min(100, 100 - upRate));
        },
        
        // 根據選中的 building 顯示對應的 floors
        buildingFloors() {
            const result = {};
            this.buildingFloorCombinations.forEach(combo => {
                if (!result[combo.building]) {
                    result[combo.building] = [];
                }
                if (!result[combo.building].includes(combo.floor)) {
                    result[combo.building].push(combo.floor);
                }
            });
            // 排序每個 building 的 floors
            Object.keys(result).forEach(building => {
                result[building].sort();
            });
            return result;
        },

        // 從目前 timelineData 中提取可用的 4 位數製程代號
        availableProcessCodes() {
            const codes = new Set();
            this.timelineData.forEach(d => {
                const match = d.station.match(/(\d{4})/);
                if (match) codes.add(match[1]);
            });
            return [...codes].sort();
        },

        // 根據選中的製程代號過濾資料
        filteredTimelineData() {
            if (!this.selectedProcessCode) return this.timelineData;
            return this.timelineData.filter(d => d.station.includes(this.selectedProcessCode));
        }
    },
    
    mounted() {
        this.fetchFilters();
    },
    
    methods: {
        // 顯示中間載入動畫
        showCenterLoading() {
            const centerLoading = document.getElementById('centerLoading');
            if (centerLoading) {
                centerLoading.classList.add('active');
            }
        },
        
        // 隱藏中間載入動畫
        hideCenterLoading() {
            const centerLoading = document.getElementById('centerLoading');
            if (centerLoading) {
                centerLoading.classList.remove('active');
            }
        },
        
        async fetchFilters() {
            try {
                const response = await fetch('http://127.0.0.1:5000/api/filters');
                const data = await response.json();
                
                this.availableBuildings = data.buildings;
                this.availableFloors = data.floors;
                this.buildingFloorCombinations = data.combinations;
                
                // 從 localStorage 讀取保存的選擇
                const savedBuilding = localStorage.getItem('selectedBuilding');
                const savedFloor = localStorage.getItem('selectedFloor');
                const savedQuickRange = localStorage.getItem('quickRange');
                const savedStartDate = localStorage.getItem('customStartDate');
                const savedEndDate = localStorage.getItem('customEndDate');
                
                // 設定 Building：優先使用保存的值，否則預設 K22
                if (savedBuilding && this.availableBuildings.includes(savedBuilding)) {
                    this.selectedBuilding = savedBuilding;
                } else if (this.availableBuildings.includes('K22')) {
                    this.selectedBuilding = 'K22'; // 預設選擇 K22
                } else if (this.availableBuildings.length > 0) {
                    this.selectedBuilding = this.availableBuildings[0];
                }
                
                // 設定 Floor：優先使用保存的值，否則預設 8F
                if (savedFloor && this.availableFloors.includes(savedFloor)) {
                    this.selectedFloor = savedFloor;
                } else if (this.availableFloors.includes('8F')) {
                    this.selectedFloor = '8F'; // 預設選擇 8F
                }
                
                // 設定時間範圍
                if (savedQuickRange !== null) {
                    this.quickRange = parseInt(savedQuickRange);
                }
                if (savedStartDate) {
                    this.customStartDate = savedStartDate;
                }
                if (savedEndDate) {
                    this.customEndDate = savedEndDate;
                }
                
                // 載入數據
                if (this.customStartDate && this.customEndDate) {
                    this.fetchData({ start: this.customStartDate, end: this.customEndDate });
                } else {
                    this.fetchData({ days: this.quickRange });
                }
            } catch (err) {
                console.error('無法載入篩選選項:', err);
                this.error = '無法連接到後台服務，請確認 http://127.0.0.1:5000 是否運行中';
                this.loading = false;
            }
        },
        
        // 選擇 building（支援切換）
        selectBuilding(building) {
            // 如果點擊的是已選中的 building，則取消選中（收起）
            if (this.selectedBuilding === building) {
                this.selectedBuilding = '';
                this.selectedFloor = '';
            } else {
                // 否則選中新的 building
                this.selectedBuilding = building;
                this.selectedFloor = '';
            }
            this.selectedProcessCode = null;
            this.onLocationChange();
        },
        
        // 選擇 floor
        selectFloor(floor) {
            if (this.selectedFloor === floor) {
                // 如果點擊已選中的 floor，則取消選擇
                this.selectedFloor = '';
            } else {
                this.selectedFloor = floor;
            }
            this.selectedProcessCode = null;
            this.onLocationChange();
        },

        // 選擇製程代號
        selectProcessCode(code) {
            // 只有一個代號時不允許取消選取（避免空白畫面）
            if (this.selectedProcessCode === code && this.availableProcessCodes.length <= 1) return;

            this.selectedProcessCode = (this.selectedProcessCode === code) ? null : code;
            this.calculateStats();
            this.renderChart();   // debounce 內部處理，重複呼叫安全
        },
        
        onLocationChange() {
            localStorage.setItem('selectedBuilding', this.selectedBuilding);
            localStorage.setItem('selectedFloor', this.selectedFloor);
            
            // 顯示中間載入動畫
            this.showCenterLoading();
            
            if (this.customStartDate && this.customEndDate) {
                this.fetchData({ start: this.customStartDate, end: this.customEndDate });
            } else {
                this.fetchData({ days: this.quickRange });
            }
        },
        
        async fetchData(params = {}) {
            try {
                const queryParams = new URLSearchParams();
                if (params.days !== undefined && params.days !== null) {
                    queryParams.append('days', params.days);
                } else if (params.start && params.end) {
                    queryParams.append('start', params.start);
                    queryParams.append('end', params.end);
                }
                
                if (this.selectedBuilding) {
                    queryParams.append('building', this.selectedBuilding);
                }
                if (this.selectedFloor) {
                    queryParams.append('floor', this.selectedFloor);
                }
                
                this.filterRange = params;
                
                const url = `/api/timeline-data${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
                const response = await fetch(`http://127.0.0.1:5000${url}`);
                if (!response.ok) throw new Error('無法載入數據');
                
                this.timelineData = await response.json();
                this.calculateStats();
                
                this.loading = false;
                await this.$nextTick();   // 等 Vue 把 v-if 的 DOM 渲染出來
                this.renderChart();
                
                // 隱藏中間載入動畫
                setTimeout(() => {
                    this.hideCenterLoading();
                }, 300);
                
            } catch (err) {
                this.error = err.message;
                this.loading = false;
                this.hideCenterLoading(); // 錯誤時也要隱藏
            }
        },
        
        selectQuickRange(days) {
            this.quickRange = days;
            this.customStartDate = '';
            this.customEndDate = '';
            
            localStorage.setItem('quickRange', days);
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            
            // 顯示中間載入動畫
            this.showCenterLoading();
            
            this.fetchData({ days });
        },
        
        applyCustomRange() {
            if (!this.customStartDate || !this.customEndDate) {
                alert('請選擇完整的日期範圍');
                return;
            }
            
            this.quickRange = null;
            
            localStorage.setItem('customStartDate', this.customStartDate);
            localStorage.setItem('customEndDate', this.customEndDate);
            localStorage.removeItem('quickRange');
            
            // 顯示中間載入動畫
            this.showCenterLoading();
            
            this.fetchData({ 
                start: this.customStartDate, 
                end: this.customEndDate 
            });
        },
        
        resetFilter() {
            this.customStartDate = '';
            this.customEndDate = '';
            this.quickRange = 1;
            
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            localStorage.setItem('quickRange', 1);
            
            // 顯示中間載入動畫
            this.showCenterLoading();
            
            this.fetchData({ days: 1 });
        },
        
        getChartMinTime() {
            if (this.filterRange.days) {
                const now = new Date();
                return new Date(now.getTime() - this.filterRange.days * 24 * 60 * 60 * 1000);
            } else if (this.filterRange.start) {
                return new Date(this.filterRange.start);
            }
            return null;
        },
        
        getChartMaxTime() {
            if (this.filterRange.end) {
                return new Date(this.filterRange.end);
            }
            return new Date();
        },
        
        calculateStats() {
            const stats = {};
            
            this.filteredTimelineData.forEach(item => {
                if (!stats[item.station]) {
                    stats[item.station] = {
                        ALARM: { count: 0, totalMinutes: 0 },
                        BUSY: { count: 0, totalMinutes: 0 },
                        timeline: []
                    };
                }

                // 正規化 status：修正常見打字錯誤，只保留 ALARM / BUSY
                const rawStatus = (item.status || '').toUpperCase().trim();
                const status = rawStatus.startsWith('ALARM') ? 'ALARM'
                             : rawStatus.startsWith('BUSY')  ? 'BUSY'
                             : null;

                if (!status) {
                    console.warn(`⚠️ 未知狀態值「${item.status}」，已跳過 (station: ${item.station})`);
                    return;
                }

                // 讓後續 timeline 使用正規化後的 status
                item = { ...item, status };

                stats[item.station][item.status].count++;
                stats[item.station][item.status].totalMinutes += item.duration_minutes;
                
                const startDate = new Date(item.start);
                const endDate = new Date(item.end);
                const formatTime = (date) => {
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const day = String(date.getDate()).padStart(2, '0');
                    const hour = String(date.getHours()).padStart(2, '0');
                    const minute = String(date.getMinutes()).padStart(2, '0');
                    return `${month}/${day} ${hour}:${minute}`;
                };
                
                stats[item.station].timeline.push({
                    status: item.status,
                    start: item.start,
                    end: item.end,
                    startFormatted: formatTime(startDate),
                    endFormatted: formatTime(endDate),
                    duration: Math.round(item.duration_minutes)
                });
            });
            
            for (const station in stats) {
                stats[station].ALARM.hours = (stats[station].ALARM.totalMinutes / 60).toFixed(1);
                stats[station].BUSY.hours = (stats[station].BUSY.totalMinutes / 60).toFixed(1);
            }
            
            this.stats = stats;
            
            const stationKeys = Object.keys(stats);
            // 若 selectedStation 已不在新資料中，重設為第一個
            if (!this.selectedStation || !stats[this.selectedStation]) {
                this.selectedStation = stationKeys.length > 0 ? stationKeys[0] : null;
            }
        },
        
        getStationItems(station) {
            return this.filteredTimelineData.filter(d => d.station === station);
        },

        getBarStyle(item) {
            const { min, max } = this.chartTimeRange;
            const total = max - min;
            if (total <= 0) return {};
            const s = new Date(item.start).getTime();
            const e = new Date(item.end).getTime();
            const left  = Math.max(0, (s - min) / total * 100);
            const width = Math.max(0.05, (e - s) / total * 100);
            const color = item.status === 'ALARM' ? '#ef4444' : '#22c55e';
            return {
                position: 'absolute',
                left:   left  + '%',
                width:  width + '%',
                top:    '0',
                height: '100%',
                backgroundColor: color,
                cursor: 'pointer',
                transition: 'opacity .15s',
            };
        },

        getBarTooltip(item) {
            const fmt = t => new Date(t).toLocaleString('zh-TW', {
                month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
            });
            return `${item.status}  ${fmt(item.start)} → ${fmt(item.end)}  (${Math.round(item.duration_minutes)} 分)`;
        },

        onBarClick(station) {
            this.selectedStation = station;
            this.$nextTick(() => {
                const s = document.getElementById('statsSection');
                if (s) {
                    s.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    s.style.boxShadow = '0 0 20px rgba(59,130,246,0.5)';
                    setTimeout(() => { s.style.boxShadow = ''; }, 1000);
                }
            });
        },

        renderChart() {
            if (this._renderTimer) clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null;
                this._doRender();
            }, 50);
        },

        _doRender() {
            const container = this.$refs.chartContainer || document.getElementById('chartContainer');
            if (!container) {
                console.error('❌ chartContainer not found');
                return;
            }

            // 銷毀所有舊圖表
            (this.charts || []).forEach(c => { try { c.destroy(); } catch(e){} });
            this.charts = [];
            container.innerHTML = '';

            const stations = [...new Set(this.filteredTimelineData.map(d => d.station))];
            console.log(`🔧 stations: ${stations.length}, data rows: ${this.filteredTimelineData.length}`);

            if (stations.length === 0) return;

            const statusColors = { 'ALARM': '#ef4444', 'BUSY': '#22c55e' };
            const minTime = this.getChartMinTime();
            const maxTime = this.getChartMaxTime();
            const entries = [];

            // ── Step 1: 建 DOM ──
            stations.forEach((station, idx) => {
                const isLast = idx === stations.length - 1;

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;width:100%;height:100px;margin-bottom:' + (isLast ? '0' : '30px') + ';';

                const label = document.createElement('div');
                label.textContent = station;
                label.style.cssText = 'flex-shrink:0;width:480px;font-size:100px;font-weight:600;line-height:100px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:16px;';

                const chartWrap = document.createElement('div');
                chartWrap.style.cssText = 'flex:1;min-width:0;height:100px;position:relative;overflow:hidden;';

                const canvas = document.createElement('canvas');
                chartWrap.appendChild(canvas);
                row.appendChild(label);
                row.appendChild(chartWrap);
                container.appendChild(row);

                entries.push({ canvas, chartWrap, station, isLast });
            });

            // ── Step 2: 強制 reflow，確保取得真實寬高 ──
            void container.offsetWidth;

            // ── Step 3: 初始化每個 Chart ──
            entries.forEach(({ canvas, chartWrap, station, isLast }) => {
                const w = chartWrap.clientWidth || 800;
                const h = 100;
                canvas.width  = w;
                canvas.height = h;

                const stationData = this.filteredTimelineData.filter(d => d.station === station);
                const data   = stationData.map(item => ({
                    x: [new Date(item.start), new Date(item.end)],
                    y: station,
                    status: item.status,
                    duration: item.duration_minutes,
                    station: item.station
                }));
                const colors = stationData.map(item => statusColors[item.status] || '#999');

                try {
                    const chart = new Chart(canvas, {
                        type: 'bar',
                        data: {
                            datasets: [{
                                data,
                                backgroundColor: colors,
                                borderWidth: 1,
                                borderColor: 'rgba(255,255,255,0.3)',
                                barPercentage: 1.0,
                                categoryPercentage: 1.0
                            }]
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: false,
                            animation: false,
                            onHover: (event, activeElements) => {
                                event.native.target.style.cursor = activeElements.length > 0 ? 'pointer' : 'default';
                            },
                            onClick: (event, activeElements) => {
                                if (activeElements.length > 0) {
                                    this.selectedStation = station;
                                    setTimeout(() => {
                                        const s = document.getElementById('statsSection');
                                        if (s) {
                                            s.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                            s.style.boxShadow = '0 0 20px rgba(59,130,246,0.5)';
                                            setTimeout(() => { s.style.boxShadow = ''; }, 1000);
                                        }
                                    }, 100);
                                }
                            },
                            layout: { padding: 0 },
                            scales: {
                                x: {
                                    type: 'time',
                                    time: { unit: 'hour', displayFormats: { hour: 'MM/dd HH:mm' } },
                                    min: minTime,
                                    max: maxTime,
                                    display: isLast,
                                    grid: { color: 'rgba(0,0,0,0.05)' },
                                    ticks: { font: { size: 12 } }
                                },
                                y: {
                                    type: 'category',
                                    labels: [station],
                                    display: false,
                                    grid: { display: false }
                                }
                            },
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    backgroundColor: 'rgba(0,0,0,0.8)',
                                    padding: 12,
                                    titleFont: { size: 14, weight: 'bold' },
                                    bodyFont: { size: 13 },
                                    callbacks: {
                                        title: () => station,
                                        label: (ctx) => {
                                            const d = ctx.raw;
                                            const fmt = t => new Date(t).toLocaleString('zh-TW', {
                                                month:'2-digit', day:'2-digit',
                                                hour:'2-digit', minute:'2-digit'
                                            });
                                            return [`狀態: ${d.status}`, `開始: ${fmt(d.x[0])}`, `結束: ${fmt(d.x[1])}`, `持續: ${d.duration.toFixed(1)} 分鐘`];
                                        },
                                        footer: () => '💡 點擊查看詳細統計資訊'
                                    }
                                }
                            }
                        }
                    });
                    this.charts.push(chart);
                } catch(e) {
                    console.error('❌ Chart 建立失敗:', station, e);
                }
            });

            console.log(`✅ 完成 ${this.charts.length} 個圖表`);
        }
    }
});

app.mount('#app');

// Loading 動畫控制
window.addEventListener('load', function() {
    // 等待2秒後隱藏 loading 畫面
    setTimeout(function() {
        const loadingScreen = document.getElementById('loadingScreen');
        const appElement = document.getElementById('app');
        
        // 添加淡出效果
        loadingScreen.classList.add('fade-out');
        
        // 同時顯示主內容
        appElement.classList.add('show');
        
        // 動畫結束後移除 loading 元素
        setTimeout(function() {
            loadingScreen.style.display = 'none';
        }, 500); // 等待淡出動畫完成（0.5秒）
    }, 2000); // 2秒延遲
});


// 10.11.99.135:5003/