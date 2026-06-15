"""登入與權限查詢路由。"""
from datetime import datetime

from flask import Blueprint, jsonify, request
from loguru import logger

import utils

bp = Blueprint('auth', __name__)


@bp.route('/api/login', methods=['POST'])
def login():
    req      = request.json or {}
    account  = req.get('account', '').strip()
    password = req.get('password', '').strip()
    print(f"\n{'='*40}\n[登入請求]\n  帳號：{account}\n  密碼：{password}\n  時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n{'='*40}\n")
    logger.info(f"[登入] 帳號={account} 密碼={password}")

    if not utils.authenticate_user(account, password):
        logger.warning(f"[登入失敗] 帳號={account} 密碼={password} 驗證未通過")
        return jsonify({
            "ok": False, 
            "message": "帳號或密碼錯誤"
        }), 401

    admin_orgs = utils.get_admin_orgs(account)
    return jsonify({
        "ok":         True,
        "account":    account.upper(),
        "name":       utils.get_user_name(account),
        "is_admin":   len(admin_orgs) > 0,
        "admin_orgs": admin_orgs,
    })


@bp.route('/api/whoami/<account>')
def whoami(account):
    admin_orgs = utils.get_admin_orgs(account)
    logger.info(f"[權限查詢] 帳號={account} is_admin={len(admin_orgs)>0} 管轄={admin_orgs}")
    return jsonify({
        "account":    account.upper(),
        "name":       utils.get_user_name(account),
        "is_admin":   len(admin_orgs) > 0,
        "admin_orgs": admin_orgs,
    })