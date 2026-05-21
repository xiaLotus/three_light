from flask import Flask, jsonify, request
from flask_cors import CORS
import pandas as pd
from sqlalchemy import create_engine, text
from loguru import logger
import threading
import time
import os
import sys

app = Flask(__name__)
CORS(app)

# ── Loguru ─────────────────────────────────────────────────────
logger.remove()
logger.add(sys.stdout, level="INFO",
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level}</level> | {message}")
logger.add("timeline_api.log", level="INFO", encoding="utf-8-sig",
    rotation="100 MB", retention=1,
    format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}")

# ══════════════════════════════════════════════════════════════
#  MySQL
# ══════════════════════════════════════════════════════════════
db_config = {
    'host': '10.11.104.247', 'port': 3306,
    'user': 'A3CIM', 'password': 'A3CIM',
    'database': 'machine_monitoring', 'charset': 'utf8mb4'
}
engine = create_engine(
    f"mysql+pymysql://{db_config['user']}:{db_config['password']}"
    f"@{db_config['host']}:{db_config['port']}/{db_config['database']}"
    f"?charset={db_config['charset']}",
    pool_pre_ping=True, pool_recycle=1800,
    connect_args={"connect_timeout": 5}
)

_db_ok        = None        # None=未測試 True=可用 False=不可用
_db_lock      = threading.Lock()
_DB_RETRY_SEC = 60
_db_fail_t    = 0.0

def _check_db() -> bool:
    global _db_ok, _db_fail_t
    with _db_lock:
        if _db_ok is True:
            return True
        now = time.time()
        if _db_ok is False and (now - _db_fail_t) < _DB_RETRY_SEC:
            return False
        try:
            with engine.connect() as c:
                c.execute(text("SELECT 1"))
            _db_ok = True
            logger.info("✅ MySQL 連線成功")
            return True
        except Exception as e:
            _db_ok     = False
            _db_fail_t = time.time()
            logger.warning(f"⚠️ MySQL 無法連線：{e}，使用 CSV fallback")
            return False

def _mark_db_fail():
    global _db_ok, _db_fail_t
    _db_ok     = False
    _db_fail_t = time.time()

# ══════════════════════════════════════════════════════════════
#  CSV 記憶體快取
# ══════════════════════════════════════════════════════════════
CSV_PATH     = 'machine_status.csv'
_csv_cache   = None
_csv_mtime   = None
_csv_lock    = threading.Lock()

def _get_csv() -> pd.DataFrame:
    global _csv_cache, _csv_mtime
    try:
        mtime = os.path.getmtime(CSV_PATH)
    except FileNotFoundError:
        logger.error(f"找不到 CSV：{CSV_PATH}")
        return pd.DataFrame()
    with _csv_lock:
        if _csv_cache is None or mtime != _csv_mtime:
            logger.info(f"📂 載入 CSV（{'首次' if _csv_cache is None else '更新'}）")
            df = pd.read_csv(CSV_PATH)
            df['received_at'] = pd.to_datetime(df['received_at'])
            df['building']    = df['building'].astype(str).str.strip()
            df['floor']       = df['floor'].astype(str).str.strip()
            _csv_cache = df
            _csv_mtime = mtime
            logger.info(f"✅ CSV 快取：{len(df):,} 筆")
        else:
            logger.debug("⚡ CSV 記憶體快取命中")
    return _csv_cache  # type: ignore[return-value]

def _warmup():
    logger.info("🔥 預熱...")
    _check_db()
    _get_csv()

threading.Thread(target=_warmup, daemon=True).start()

# ══════════════════════════════════════════════════════════════
#  核心：取得 building/floor 的完整資料（不含時間過濾）
#
#  ★ 關鍵設計：時間過濾留給 Python 演算法處理
#    這樣 before_range（範圍前的最後狀態）才能正確找到
#    不會有白色空白，也不會遺漏沒有近期記錄的設備
# ══════════════════════════════════════════════════════════════
def _fetch_data(building: str, floor: str) -> tuple[pd.DataFrame, str]:
    """
    回傳指定 building/floor 的所有記錄（不過濾時間）。
    優先 DB，失敗則 CSV。
    """
    # ── DB ──────────────────────────────────────────────────
    if _check_db():
        try:
            conditions = []
            params: dict = {}
            if building:
                conditions.append("building = :building")
                params['building'] = building
            if floor:
                conditions.append("floor = :floor")
                params['floor'] = floor

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            sql   = text(f"SELECT * FROM machine_status {where} ORDER BY station, received_at")

            with engine.connect() as conn:
                df = pd.read_sql(sql, conn, params=params)

            df['received_at'] = pd.to_datetime(df['received_at'])
            df['building']    = df['building'].astype(str).str.strip()
            df['floor']       = df['floor'].astype(str).str.strip()
            logger.info(f"🗄️  DB 查詢 {building}/{floor}：{len(df):,} 筆")
            return df, "DB"

        except Exception as e:
            logger.error(f"❌ DB 查詢失敗：{e}，切換 CSV")
            _mark_db_fail()

    # ── CSV fallback ─────────────────────────────────────────
    logger.info(f"📄 CSV fallback {building}/{floor}")
    df = _get_csv().copy()
    if building:
        df = df[df['building'] == building]
    if floor:
        df = df[df['floor'] == floor]
    logger.info(f"📄 CSV 過濾後：{len(df):,} 筆")
    return df, "CSV"


# ══════════════════════════════════════════════════════════════
#  API
# ══════════════════════════════════════════════════════════════
@app.route('/api/filters')
def get_filters():
    df = _get_csv()
    if df.empty and _check_db():
        try:
            with engine.connect() as conn:
                df = pd.read_sql(text("SELECT building, floor FROM machine_status"), conn)
            df['building'] = df['building'].astype(str).str.strip()
            df['floor']    = df['floor'].astype(str).str.strip()
        except Exception as e:
            logger.error(f"❌ DB filters 失敗：{e}")
            return jsonify({'buildings': [], 'floors': [], 'combinations': []})

    buildings: list[str] = sorted([str(v) for v in df['building'].dropna().unique()])
    floors:    list[str] = sorted([str(v) for v in df['floor'].dropna().unique()])
    combinations = (
        df.groupby(['building', 'floor']).size()
          .reset_index()[['building', 'floor']]
          .astype(str).to_dict('records')
    )
    return jsonify({'buildings': buildings, 'floors': floors, 'combinations': combinations})


@app.route('/api/timeline-data')
def get_timeline_data():
    logger.info("📥 /api/timeline-data")

    building = request.args.get('building', '').strip()
    floor    = request.args.get('floor',    '').strip()
    days     = request.args.get('days', type=int)
    start_dt = request.args.get('start')
    end_dt   = request.args.get('end')

    # ── 時間範圍（Python 處理）────────────────────────────────
    if start_dt and end_dt:
        filter_start = pd.to_datetime(start_dt)
        filter_end   = pd.to_datetime(end_dt) + pd.Timedelta(days=1) - pd.Timedelta(seconds=1)
    elif days:
        filter_start = pd.Timestamp.now() - pd.Timedelta(days=days)
        filter_end   = pd.Timestamp.now()
    else:
        filter_start = pd.Timestamp.now() - pd.Timedelta(days=1)
        filter_end   = pd.Timestamp.now()

    logger.info(f"🕐 {building}/{floor}  {filter_start} ~ {filter_end}")

    # ── 取資料（不含時間過濾，保留 before_range 供演算法使用）
    df_all, src = _fetch_data(building, floor)

    if df_all.empty:
        logger.warning("⚠️ 查無資料")
        return jsonify([])

    df_all = df_all.sort_values(['station', 'received_at']).reset_index(drop=True)

    # ══════════════════════════════════════════════════════════
    #  建立狀態區間（原始邏輯，完整保留）
    # ══════════════════════════════════════════════════════════
    timeline_data: list[dict] = []

    def _ts(val) -> pd.Timestamp:
        return pd.Timestamp(val)  # type: ignore[arg-type]

    for station, station_df in df_all.groupby('station'):
        station_df = station_df.reset_index(drop=True)

        # 範圍內 / 範圍前
        in_range     = station_df[
            (station_df['received_at'] >= filter_start) &
            (station_df['received_at'] <= filter_end)
        ].reset_index(drop=True)
        before_range = station_df[station_df['received_at'] < filter_start]

        # ── 情況 A：範圍內完全沒有記錄 ─────────────────────
        if len(in_range) == 0:
            if len(before_range) > 0:
                last = before_range.iloc[-1]
                timeline_data.append({
                    'station'         : str(station),
                    'status'          : str(last['status']),
                    'start'           : filter_start.isoformat(),
                    'end'             : filter_end.isoformat(),
                    'duration_minutes': round(
                        (filter_end - filter_start).total_seconds() / 60, 2)
                })
            continue

        # ── 情況 B：填補第一筆前的空白（維持前一個時間點狀態）
        first_ts = _ts(in_range.iloc[0]['received_at'])
        if first_ts > filter_start and len(before_range) > 0:
            last = before_range.iloc[-1]
            timeline_data.append({
                'station'         : str(station),
                'status'          : str(last['status']),
                'start'           : filter_start.isoformat(),
                'end'             : first_ts.isoformat(),
                'duration_minutes': round(
                    (first_ts - filter_start).total_seconds() / 60, 2)
            })

        # ── 情況 C：逐筆處理範圍內記錄 ─────────────────────
        for i in range(len(in_range)):
            start_time: pd.Timestamp = _ts(in_range.loc[i, 'received_at'])
            status: str              = str(in_range.loc[i, 'status'])

            if i < len(in_range) - 1:
                end_time: pd.Timestamp = _ts(in_range.loc[i + 1, 'received_at'])
            else:
                after = station_df[station_df['received_at'] > start_time]
                if len(after) > 0:
                    end_time = min(_ts(after.iloc[0]['received_at']), filter_end)
                else:
                    end_time = filter_end

            if end_time > filter_end:
                end_time = filter_end

            timeline_data.append({
                'station'         : str(station),
                'status'          : status,
                'start'           : start_time.isoformat(),
                'end'             : end_time.isoformat(),
                'duration_minutes': round(
                    (end_time - start_time).total_seconds() / 60, 2)
            })

    logger.info(f"✅ 回傳 {len(timeline_data):,} 筆（來源：{src}）")
    return jsonify(timeline_data)


if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000, threaded=True)
