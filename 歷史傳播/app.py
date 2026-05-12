from loguru import logger
import requests
import sys
import os
import json
import pandas as pd
from datetime import datetime, timedelta
from sqlalchemy import create_engine, text
from loguru import logger

# db_config = {
#     "host": "10.11.104.247",
#     "port": 3306,
#     "user": "A3CIM",
#     "password": "A3CIM",
#     "database": "a3cim_department",
#     "charset": "utf8mb4"
# }

# engine = create_engine(
#     f"mysql+pymysql://{db_config['user']}:{db_config['password']}@"
#     f"{db_config['host']}:{db_config['port']}/{db_config['database']}?"
#     f"charset={db_config['charset']}",
#     pool_pre_ping=True
# )

# df = pd.read_sql("SELECT * FROM error_rate_db.timeout_status", engine)

# # 🔥 條件：搬運輸出內文 == 'N/A' 且 烘烤超時內文有值 → 移除
# df = df[~(
#     (df["搬運輸出內文"] == "N/A") &
#     (df["烘烤超時內文"].notna()) &
#     (df["烘烤超時內文"] != "")
# )]

# df.to_csv("timeout_status.csv", index=False, encoding="utf-8-sig")


from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import os

# 設定靜態檔案目錄為「當前檔案所在資料夾」
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')
CORS(app)

def load_data_from_csv():
    """
    從 timeout_status.csv 讀取資料，並轉換為 list of dict
    如果檔案不存在，回傳空列表
    """
    csv_path = os.path.join(BASE_DIR, 'timeout_status.csv')
    
    if not os.path.exists(csv_path):
        print(f"⚠️ 警告：找不到 {csv_path}，使用空資料")
        return []
    
    try:
        # 讀取 CSV，自動處理 utf-8-sig 編碼（避免 BOM 問題）
        df = pd.read_csv(csv_path, encoding='utf-8-sig')
        
        # 轉換為 list of dict，並處理 NaN 值
        data = df.where(pd.notna(df), None).to_dict(orient='records')
        
        print(f"✅ 成功載入 {len(data)} 筆資料 from timeout_status.csv")
        return data
        
    except Exception as e:
        print(f"❌ 讀取 CSV 失敗: {e}")
        return []
    
from datetime import datetime, timedelta

def format_created_at(time_str):
    """時間 +1 小時並取整到整點"""
    dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
    dt = dt + timedelta(hours=1)
    dt = dt.replace(minute=0, second=0)
    return dt.strftime("%Y-%m-%d %H:%M:%S")

@app.route('/api/alerts')
def get_alerts():
    # 🔥 1. 從 CSV 讀取原始資料
    raw_data = load_data_from_csv()
    
    if not raw_data:
        return jsonify([])
    
    # 🔥 2. 轉換 created_at 格式
    processed_data = []
    for item in raw_data:
        item_copy = {**item}
        if 'created_at' in item_copy:
            item_copy['created_at'] = format_created_at(item_copy['created_at'])
        processed_data.append(item_copy)
    
    # 🔥 3. 計算近 7 天日期範圍（含今天）
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    date_range = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
    
    # 🔥 4. 統計每日上拋次數（每筆 = 1 次），無資料補 0
    daily_counts = {date: 0 for date in date_range}
    for item in processed_data:
        if item.get('created_at'):
            date = str(item['created_at']).split(" ")[0]
            if date in daily_counts:
                daily_counts[date] += 1
    
    # 🔥 5. 將統計結果附加到每筆資料
    result = []
    for item in processed_data:
        item_copy = {**item}
        item_copy["daily_stats"] = {
            "labels": date_range,
            "data": [daily_counts[d] for d in date_range]
        }
        result.append(item_copy)
    
    return jsonify(result)

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)