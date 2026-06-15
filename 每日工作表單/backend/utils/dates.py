"""日期計算。"""
from datetime import datetime


def calc_days_due(date_str):
    if not date_str:
        return "無"
    try:
        d     = datetime.strptime(date_str, "%Y-%m-%d")
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        delta = (d - today).days
        if delta > 0:
            return f"剩 {delta} 天"
        elif delta == 0:
            return "今日"
        else:
            return f"{abs(delta)}天"
    except ValueError:
        return "無"