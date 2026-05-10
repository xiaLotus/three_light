import csv
import os
import uuid
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

CSV_FILE = 'tasks.csv'
# 完全對齊你指定的 CSV 欄位
CSV_FIELDS = [
    'id', '日期', '距今', '棟別', '樓層', '站點', '組織類別', '案件分類',
    '提案人', '項目描述', '管理OWNER', '項目Due Date', '項目OWNER',
    '單項目Due Date', '當前最新進度'
]

def calc_days_due(date_str):
    if not date_str: return "無"
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        delta = (d - today).days
        if delta > 0: return f"剩 {delta} 天"
        elif delta == 0: return "今日"
        else: return f"逾期 {abs(delta)} 天"
    except: return "無"

def load_data():
    if not os.path.exists(CSV_FILE):
        # 初始化種子資料
        seed = [{f: "" for f in CSV_FIELDS}]
        seed[0].update({
            'id': str(uuid.uuid4()), '日期': '2026-05-09', '棟別': 'A棟', '樓層': '3F', '站點': 'Server01',
            '組織類別': 'FT01營運(硬)', '案件分類': '日常(一般)', '提案人': '王羽', '項目描述': '主馬達溫度異常偵測',
            '管理OWNER': '張主任', '項目Due Date': '2026-05-09', '項目OWNER': '李工',
            '單項目Due Date': '2026-05-08', '當前最新進度': '現場勘查中'
        })
        save_data(seed)
        return seed

    data = []
    with open(CSV_FILE, 'r', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            row['距今'] = calc_days_due(row.get('項目Due Date', ''))
            data.append(row)
    return data

def save_data(data):
    with open(CSV_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(data)

@app.route('/api/today_page')
def today_page():
    data = load_data()
    today = datetime.now().strftime("%Y-%m-%d")
    # 回傳前端表格用的簡易欄位（保持主頁面清爽）
    simple = [{'id': d['id'], '日期': d['日期'], '提案人': d['提案人'], '組織類別': d['組織類別'], 
               '項目描述': d['項目描述'], '項目Due Date': d['項目Due Date'], '距今': d['距今']} for d in data]
    return jsonify({
        "today": [d for d in simple if d["日期"] == today],
        "due": [d for d in simple if d["項目Due Date"] <= today]
    })

@app.route('/api/all')
def all_tasks():
    data = load_data()
    return jsonify(data)

@app.route('/api/add', methods=['POST'])
def add_task():
    data = load_data()
    req = request.json
    # 完整寫入 CSV 所有欄位
    new_task = {field: req.get(field, "") for field in CSV_FIELDS}
    new_task['id'] = str(uuid.uuid4())
    new_task['日期'] = req.get('日期', datetime.now().strftime("%Y-%m-%d"))
    new_task['距今'] = calc_days_due(req.get('項目Due Date', ''))
    data.append(new_task)
    save_data(data)
    return jsonify({"status": "ok"})

@app.route('/api/delete', methods=['POST'])
def delete_task():
    data = load_data()
    id_ = request.json.get("id")
    data = [d for d in data if d["id"] != id_]
    save_data(data)
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    load_data()
    app.run(debug=True, port=5000)