"""工作管理系統 — 進入點。"""
import os

from flask import Flask
from flask_cors import CORS

import config
import utils
from routes import register_routes

# ── 初始化 ──
logger = config.setup_logger()
os.makedirs(config.PROGRESS_DIR, exist_ok=True)

app = Flask(__name__)
CORS(app)

register_routes(app)


if __name__ == '__main__':
    utils.load_data()   # 確保 tasks.csv 存在
    logger.info(f"[系統啟動] 工作管理系統後端啟動 host={config.SRV_HOST} port={config.SRV_PORT}")
    app.run(host=config.SRV_HOST, port=config.SRV_PORT, debug=config.SRV_DEBUG)    
    # app.run(host="10.11.104.247", port=7001, debug=True)
    # 0971-50-2211 修哥電話