const app = Vue.createApp({
    data() {
        return {
            loading: true,
            centerLoading: false, // 中間載入動畫狀態
            error: null,
            timelineData: [],
            chart: null,
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
        chartHeight() {
            // 使用未過濾的資料決定高度，避免切換製程代號時觸發 canvas 重建
            const stations = [...new Set(this.timelineData.map(d => d.station))];
            return Math.max(800, stations.length * 100);
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
                await this.$nextTick();
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
        
        renderChart() {
            // Debounce：50ms 內多次呼叫只執行最後一次
            if (this._renderTimer) clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null;
                this._doRender();
            }, 50);
        },

        _doRender() {
            const canvas = this.$refs.chartCanvas;
            if (!canvas) return;

            // Chart.js 4.x 內建：清除此 canvas 上任何殘存的圖表實例
            const stale = Chart.getChart(canvas);
            if (stale) stale.destroy();
            if (this.chart) { this.chart.destroy(); this.chart = null; }

            const allStations = [...new Set(this.filteredTimelineData.map(d => d.station))];
            
            const stationDataCount = {};
            allStations.forEach(station => {
                stationDataCount[station] = this.filteredTimelineData.filter(d => d.station === station).length;
            });
            
            const stations = allStations.filter(station => stationDataCount[station] > 0);
            
            const statusColors = {
                'ALARM': '#ef4444',
                'BUSY': '#22c55e'
            };
            
            const allData = [];
            const allColors = [];
            
            this.filteredTimelineData.forEach(item => {
                allData.push({
                    x: [new Date(item.start), new Date(item.end)],
                    y: item.station,
                    status: item.status,
                    duration: item.duration_minutes,
                    station: item.station
                });
                allColors.push(statusColors[item.status] || '#999');
            });
            
            const ctx = this.$refs.chartCanvas.getContext('2d');
            this.chart = new Chart(ctx, {
                type: 'bar',
                data: {
                    datasets: [{
                        label: '設備狀態',
                        data: allData,
                        backgroundColor: allColors,
                        borderWidth: 1,
                        borderColor: 'rgba(255, 255, 255, 0.3)',
                        barThickness: 30
                    }]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    // 鼠標懸停時顯示手型游標
                    onHover: (event, activeElements) => {
                        event.native.target.style.cursor = activeElements.length > 0 ? 'pointer' : 'default';
                    },
                    // 添加點擊事件
                    onClick: (event, activeElements) => {
                        if (activeElements.length > 0) {
                            const dataIndex = activeElements[0].index;
                            const clickedData = allData[dataIndex];
                            const clickedStation = clickedData.station;
                            
                            // 設置選中的設備
                            this.selectedStation = clickedStation;
                            
                            // 滾動到統計資訊區域
                            setTimeout(() => {
                                const statsSection = document.getElementById('statsSection');
                                if (statsSection) {
                                    // 滾動到統計區域
                                    statsSection.scrollIntoView({ 
                                        behavior: 'smooth', 
                                        block: 'start' 
                                    });
                                    
                                    // 添加短暫的高亮效果
                                    statsSection.style.boxShadow = '0 0 20px rgba(59, 130, 246, 0.5)';
                                    setTimeout(() => {
                                        statsSection.style.boxShadow = '';
                                    }, 1000);
                                }
                            }, 100);
                            
                            console.log('點擊了設備:', clickedStation);
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                unit: 'hour',
                                displayFormats: {
                                    hour: 'MM/dd HH:mm'
                                }
                            },
                            min: this.getChartMinTime(),
                            max: this.getChartMaxTime(),
                            title: {
                                display: true,
                                text: '時間',
                                font: { size: 14, weight: 'bold' }
                            },
                            grid: {
                                color: 'rgba(0, 0, 0, 0.05)'
                            }
                        },
                        y: {
                            type: 'category',
                            labels: stations,
                            title: {
                                display: true,
                                text: '設備站點',
                                font: { size: 14, weight: 'bold' }
                            },
                            grid: {
                                display: false
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            backgroundColor: 'rgba(0, 0, 0, 0.8)',
                            padding: 12,
                            titleFont: { size: 14, weight: 'bold' },
                            bodyFont: { size: 13 },
                            callbacks: {
                                title: function(context) {
                                    const data = context[0].raw;
                                    return data.station;
                                },
                                label: function(context) {
                                    const data = context.raw;
                                    const start = new Date(data.x[0]).toLocaleString('zh-TW', {
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    });
                                    const end = new Date(data.x[1]).toLocaleString('zh-TW', {
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    });
                                    const duration = data.duration.toFixed(1);
                                    return [
                                        `狀態: ${data.status}`,
                                        `開始: ${start}`,
                                        `結束: ${end}`,
                                        `持續: ${duration} 分鐘`
                                    ];
                                },
                                footer: function(context) {
                                    return '💡 點擊查看詳細統計資訊';
                                }
                            }
                        }
                    }
                }
            });
            
            console.log('✅ 圖表已創建');
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