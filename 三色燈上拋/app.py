from flask import Flask, jsonify, send_file, request
from flask_cors import CORS
import pandas as pd
from datetime import datetime
from sqlalchemy import create_engine
from loguru import logger
import os
import sys

app = Flask(__name__)
CORS(app)

# Loguru 設定
# ===============================
logger.remove()  # 移除預設 logger

logger.add(
    sys.stdout,
    level="INFO",
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level}</level> | {message}"
)

logger.add(
    "timeline_api.log",
    level="INFO",
    encoding="utf-8-sig",
    rotation="100 MB",     # 🔥 單一檔案最大 100MB
    retention=1,           # 🔥 只保留 1 份（超過即刪舊）
    format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}"
)

# ===============================
# MySQL 連線設定
# ===============================
db_config = {
    'host': '10.11.104.247',
    'port': 3306,
    'user': 'A3CIM',
    'password': 'A3CIM',
    'database': 'machine_monitoring',
    'charset': 'utf8mb4'
}

engine = create_engine(
    f"mysql+pymysql://{db_config['user']}:{db_config['password']}"
    f"@{db_config['host']}:{db_config['port']}/{db_config['database']}"
    f"?charset={db_config['charset']}",
    pool_pre_ping=True
)
@app.route('/api/filters')
def get_filters():
    """獲取可用的 building 和 floor 列表"""
    df = pd.read_csv('machine_status.csv')
    sql = """
        SELECT *
        FROM machine_status
    """
    # df = pd.read_sql(sql, engine)
    
    buildings = sorted(df['building'].unique().tolist())
    floors = sorted(df['floor'].unique().tolist())
    
    # 獲取 building + floor 組合
    combinations = df.groupby(['building', 'floor']).size().reset_index()[['building', 'floor']]
    combos = combinations.to_dict('records') # type: ignore
    
    return jsonify({
        'buildings': buildings,
        'floors': floors,
        'combinations': combos
    })



@app.route('/api/timeline-data')
def get_timeline_data():
    # 讀取 CSV
    logger.info("📥 收到 /api/timeline-data 請求")
    df_all = pd.read_csv('machine_status.csv')
    sql = """
            SELECT *
            FROM machine_status
    """
    # df_all = pd.read_sql(sql, engine)

    logger.info(f"📊 DB 撈取筆數: {len(df_all)}")
    if df_all.empty:
        logger.warning("⚠️ 查無資料，回傳空陣列")
        return jsonify([])
    
    df_all['received_at'] = pd.to_datetime(df_all['received_at'])
    
    # 獲取時間範圍參數
    days = request.args.get('days', type=int)
    start_date = request.args.get('start')
    end_date = request.args.get('end')
    
    # 獲取 building 和 floor 參數
    building = request.args.get('building')
    floor = request.args.get('floor')
    
    # 先按 building 和 floor 篩選
    if building:
        df_all = df_all[df_all['building'] == building]
    if floor:
        df_all = df_all[df_all['floor'] == floor]
    
    # 獲取時間範圍參數
    days = request.args.get('days', type=int)
    start_date = request.args.get('start')
    end_date = request.args.get('end')
    
    # 記錄篩選範圍
    filter_start = None
    filter_end = None
    
    # 根據參數設定篩選範圍
    if start_date and end_date:
        # 自訂時間範圍
        filter_start = pd.to_datetime(start_date)
        filter_end = pd.to_datetime(end_date) + pd.Timedelta(days=1) - pd.Timedelta(seconds=1)
    elif days:
        # 快速選擇（N天前到現在）
        filter_start = pd.Timestamp.now() - pd.Timedelta(days=days)
        filter_end = pd.Timestamp.now()
    else:
        # 預設24小時
        filter_start = pd.Timestamp.now() - pd.Timedelta(days=1)
        filter_end = pd.Timestamp.now()
    
    # 統一 station 名稱
    # df_all['station'] = df_all['station'].str.replace('K21_8F', 'K21-8F')
    df_all['station'] = df_all['station']
    df_all = df_all.sort_values(['station', 'received_at'])  # type: ignore
    
    # 建立狀態區間數據
    timeline_data = []
    
    for station in df_all['station'].unique():
        station_df = df_all[df_all['station'] == station].reset_index(drop=True)
        
        # 找出在範圍內的記錄
        in_range = station_df[
            (station_df['received_at'] >= filter_start) & 
            (station_df['received_at'] <= filter_end)
        ].reset_index(drop=True)
        
        if len(in_range) == 0:
            # 如果範圍內沒有記錄，找最後一筆早於範圍的記錄
            before_range = station_df[station_df['received_at'] < filter_start]
            if len(before_range) > 0:
                last_before = before_range.iloc[-1]
                # 用這個狀態填充整個範圍
                timeline_data.append({
                    'station': station,
                    'status': last_before['status'],
                    'start': filter_start.isoformat(),
                    'end': filter_end.isoformat(),
                    'duration_minutes': round((filter_end - filter_start).total_seconds() / 60, 2)
                })
            continue
        
        # 處理第一筆記錄之前的時間段
        first_record = in_range.iloc[0]
        if first_record['received_at'] > filter_start:
            # 找前一筆記錄的狀態
            before_range = station_df[station_df['received_at'] < filter_start]
            if len(before_range) > 0:
                last_before = before_range.iloc[-1]
                # 從範圍開始到第一筆記錄，使用前一個狀態
                timeline_data.append({
                    'station': station,
                    'status': last_before['status'],
                    'start': filter_start.isoformat(),
                    'end': first_record['received_at'].isoformat(),
                    'duration_minutes': round((first_record['received_at'] - filter_start).total_seconds() / 60, 2)
                })
        
        # 處理範圍內的記錄
        for i in range(len(in_range)):
            start_time = in_range.loc[i, 'received_at']
            status = in_range.loc[i, 'status']
            
            # 結束時間
            if i < len(in_range) - 1:
                end_time = in_range.loc[i + 1, 'received_at']
            else:
                # 最後一筆記錄：檢查是否有更晚的記錄
                after_records = station_df[station_df['received_at'] > start_time]
                if len(after_records) > 0:
                    end_time = min(after_records.iloc[0]['received_at'], filter_end)
                else:
                    end_time = filter_end
            
            # 確保不超出範圍
            if end_time > filter_end:
                end_time = filter_end
            
            timeline_data.append({
                'station': station,
                'status': status,
                'start': start_time.isoformat(),
                'end': end_time.isoformat(),
                'duration_minutes': round((end_time - start_time).total_seconds() / 60, 2)
            })
    
    return jsonify(timeline_data)

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000, threaded=True)