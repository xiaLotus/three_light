"""任務 CSV 讀寫。"""
import csv
import os
import uuid

import config
from utils.dates import calc_days_due


def load_data():
    if not os.path.exists(config.CSV_FILE):
        seed = [{f: "" for f in config.CSV_FIELDS}]
        seed[0].update({
            'id': str(uuid.uuid4()), '日期': '2026-05-09', '棟別': 'A棟',
            '樓層': '3F', '站點': 'Server01', '組織類別': 'FT01營運(硬)',
            '案件分類': '日常(一般)', '提案人': '王羽', '項目描述': '主馬達溫度異常偵測',
            '管理OWNER': '張主任', '項目Due Date': '2026-05-09', '項目OWNER': '李工',
            '單項目Due Date': '2026-05-08',
        })
        save_data(seed)
        return seed
    data = []
    with open(config.CSV_FILE, 'r', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            row['距今'] = calc_days_due(row.get('項目Due Date', ''))
            data.append(row)
    return data


def save_data(data):
    with open(config.CSV_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=config.CSV_FIELDS)
        writer.writeheader()
        writer.writerows(data)