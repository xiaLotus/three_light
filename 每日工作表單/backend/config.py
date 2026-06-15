"""讀取 config.ini，集中管理所有設定與路徑。"""
import os
import configparser

BASE_DIR = ""

_cfg = configparser.ConfigParser()
_cfg.read(os.path.join(BASE_DIR, 'config.ini'), encoding='utf-8-sig')


def _get(section, key, fallback):
    try:
        return _cfg.get(section, key)
    except (configparser.NoSectionError, configparser.NoOptionError):
        return fallback


# ── 路徑（皆相對於本專案目錄）──
CSV_FILE     = os.path.join(BASE_DIR, _get('paths', 'csv_file',     'tasks.csv'))
PROGRESS_DIR = os.path.join(BASE_DIR, _get('paths', 'progress_dir', 'progress'))
ADMIN_FILE   = os.path.join(BASE_DIR, _get('paths', 'admin_file',   'admin.json'))
USERS_FILE   = os.path.join(BASE_DIR, _get('paths', 'users_file',   'users.json'))

# ── Logging ──
LOG_DIR       = os.path.join(BASE_DIR, _get('logging', 'log_dir',   'log'))
LOG_FILE      = _get('logging', 'log_file',  'app_{time:YYYY-MM-DD}.log')
LOG_ROTATION  = _get('logging', 'rotation',  '00:00')
LOG_RETENTION = _get('logging', 'retention', '90 days')

# ── Server ──
SRV_HOST  = _get('server', 'host',  '127.0.0.1')
SRV_PORT  = int(_get('server', 'port', '5000'))
SRV_DEBUG = _get('server', 'debug', 'true').strip().lower() in ('1', 'true', 'yes', 'on')

# ── CSV 欄位 ──
CSV_FIELDS = [
    'id', '日期', '距今', '棟別', '樓層', '站點', '組織類別', '案件分類',
    '提案人', '項目描述', '管理OWNER', '項目Due Date', '項目OWNER',
    '單項目Due Date', '當前最新進度', '狀態'
]


def setup_logger():
    """設定 loguru，回傳 logger。"""
    from loguru import logger
    os.makedirs(LOG_DIR, exist_ok=True)
    logger.add(
        os.path.join(LOG_DIR, LOG_FILE),
        rotation=LOG_ROTATION,
        retention=LOG_RETENTION,
        encoding='utf-8-sig',
        format='{time:YYYY-MM-DD HH:mm:ss} | {level:<7} | {message}',
        enqueue=True,
    )
    return logger