const app = Vue.createApp({
    data() {
        return {
            loading: true,
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
            selectedBuilding: '',
            selectedFloor: ''
        };
    },
    
    computed: {
        chartHeight() {
            const stations = [...new Set(this.timelineData.map(d => d.station))];
            const stationCount = stations.length;
            const height = Math.max(800, stationCount * 100);
            console.log('📊 Station 數量:', stationCount, '| 計算高度:', height + 'px');
            return height;
        }
    },
    
    mounted() {
        this.fetchFilters();
    },
    
    methods: {
        async fetchFilters() {
            try {
                const response = await fetch('http://127.0.0.1:5000/api/filters');
                const data = await response.json();
                
                this.availableBuildings = data.buildings;
                this.availableFloors = data.floors;
                
                const savedBuilding = localStorage.getItem('selectedBuilding');
                const savedFloor = localStorage.getItem('selectedFloor');
                const savedQuickRange = localStorage.getItem('quickRange');
                const savedStartDate = localStorage.getItem('customStartDate');
                const savedEndDate = localStorage.getItem('customEndDate');
                
                if (savedBuilding && this.availableBuildings.includes(savedBuilding)) {
                    this.selectedBuilding = savedBuilding;
                } else if (this.availableBuildings.length > 0) {
                    this.selectedBuilding = this.availableBuildings[0];
                }
                
                if (savedFloor && this.availableFloors.includes(savedFloor)) {
                    this.selectedFloor = savedFloor;
                } else if (this.availableFloors.length > 0) {
                    this.selectedFloor = this.availableFloors[0];
                }
                
                if (savedQuickRange !== null) {
                    this.quickRange = parseInt(savedQuickRange);
                }
                if (savedStartDate) {
                    this.customStartDate = savedStartDate;
                }
                if (savedEndDate) {
                    this.customEndDate = savedEndDate;
                }
                
                if (this.customStartDate && this.customEndDate) {
                    this.fetchData({ start: this.customStartDate, end: this.customEndDate });
                } else {
                    this.fetchData({ days: this.quickRange });
                }
            } catch (err) {
                console.error('無法載入篩選選項:', err);
                this.fetchData({ days: 1 });
            }
        },
        
        onLocationChange() {
            localStorage.setItem('selectedBuilding', this.selectedBuilding);
            localStorage.setItem('selectedFloor', this.selectedFloor);
            
            this.loading = true;
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
                
                await this.$nextTick();
                
                setTimeout(() => {
                    this.renderChart();
                }, 100);
                
                this.loading = false;
            } catch (err) {
                this.error = err.message;
                this.loading = false;
            }
        },
        
        selectQuickRange(days) {
            this.quickRange = days;
            this.customStartDate = '';
            this.customEndDate = '';
            this.loading = true;
            
            localStorage.setItem('quickRange', days);
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            
            this.fetchData({ days });
        },
        
        applyCustomRange() {
            if (!this.customStartDate || !this.customEndDate) {
                alert('請選擇完整的日期範圍');
                return;
            }
            
            this.quickRange = null;
            this.loading = true;
            
            localStorage.setItem('customStartDate', this.customStartDate);
            localStorage.setItem('customEndDate', this.customEndDate);
            localStorage.removeItem('quickRange');
            
            this.fetchData({ 
                start: this.customStartDate, 
                end: this.customEndDate 
            });
        },
        
        resetFilter() {
            this.customStartDate = '';
            this.customEndDate = '';
            this.quickRange = 1;
            this.loading = true;
            
            localStorage.removeItem('customStartDate');
            localStorage.removeItem('customEndDate');
            localStorage.setItem('quickRange', 1);
            
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
        
        onBuildingOrFloorChange() {
            this.onLocationChange();
        },
        
        calculateStats() {
            const stats = {};
            
            this.timelineData.forEach(item => {
                if (!stats[item.station]) {
                    stats[item.station] = {
                        ALARM: { count: 0, totalMinutes: 0 },
                        BUSY: { count: 0, totalMinutes: 0 },
                        timeline: []
                    };
                }
                
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
            
            if (!this.selectedStation && Object.keys(stats).length > 0) {
                this.selectedStation = Object.keys(stats)[0];
            }
        },
        
        renderChart() {
            if (!this.$refs.chartCanvas) {
                console.error('Canvas element not found, retrying...');
                setTimeout(() => this.renderChart(), 200);
                return;
            }
            
            if (this.chart) {
                this.chart.destroy();
            }
            
            const allStations = [...new Set(this.timelineData.map(d => d.station))];
            console.log('📊 所有 Station:', allStations);
            console.log('📊 timelineData 總筆數:', this.timelineData.length);
            
            const stationDataCount = {};
            allStations.forEach(station => {
                stationDataCount[station] = this.timelineData.filter(d => d.station === station).length;
            });
            console.log('📊 每個 Station 的數據量:', stationDataCount);
            
            const stations = allStations.filter(station => stationDataCount[station] > 0);
            console.log('📊 有數據的 Station:', stations);
            console.log('📊 Station 數量:', stations.length);
            
            const statusColors = {
                'ALARM': '#ef4444',
                'BUSY': '#22c55e'
            };
            
            const allData = [];
            const allColors = [];
            
            this.timelineData.forEach(item => {
                allData.push({
                    x: [new Date(item.start), new Date(item.end)],
                    y: item.station,
                    status: item.status,
                    duration: item.duration_minutes,
                    station: item.station
                });
                allColors.push(statusColors[item.status] || '#999');
            });
            
            console.log('📊 總數據點:', allData.length);
            console.log('📊 數據點示例:', allData.slice(0, 3));
            
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