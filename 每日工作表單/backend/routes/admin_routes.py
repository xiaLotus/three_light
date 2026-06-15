"""管理員任務清單與名單管理路由。"""
from flask import Blueprint, jsonify, request
from loguru import logger

import utils

bp = Blueprint('admin', __name__)


@bp.route('/api/admin_tasks/<account>')
def admin_tasks(account):
    admin_orgs = utils.get_admin_orgs(account)
    if not admin_orgs:
        logger.warning(f"[權限拒絕] 帳號={account} 嘗試存取管理員資料但不在 admin.json 內")
        return jsonify({"error": "forbidden", "message": "無管理員權限"}), 403
    data = [d for d in utils.load_data() if d.get('組織類別') in admin_orgs]
    for d in data:
        d['當前最新進度'] = utils.latest_progress(d['id'])
    logger.info(f"[管理員清單] 帳號={account} 管轄={admin_orgs} 回傳 {len(data)} 筆")
    return jsonify(data)


@bp.route('/api/admin_config/<account>')
def get_admin_config_for(account):
    my_orgs = utils.get_admin_orgs(account)
    if not my_orgs:
        return jsonify({"error": "forbidden"}), 403
    full = utils.load_admin_config()
    cfg  = {org: full[org] for org in full if org in my_orgs}
    return jsonify({"config": cfg, "users": utils.load_user_names()})


@bp.route('/api/admin_config/<account>', methods=['POST'])
def update_admin_config(account):
    my_orgs = utils.get_admin_orgs(account)
    if not my_orgs:
        logger.warning(f"[權限拒絕-名單] 帳號={account} 嘗試修改管理員名單")
        return jsonify({"error": "forbidden", "message": "需管理員權限"}), 403

    req    = request.json or {}
    org    = req.get('org', '').strip()
    target = (req.get('target') or '').strip().upper()
    action = req.get('action')

    cfg = utils.load_admin_config()
    if org not in cfg:
        return jsonify({"error": "bad_org", "message": "組織不存在"}), 400
    if org not in my_orgs:
        logger.warning(f"[權限拒絕-名單] 帳號={account} 嘗試修改非管轄組織 {org}")
        return jsonify({"error": "forbidden", "message": "僅能管理自己擁有的組織"}), 403
    if not target:
        return jsonify({"error": "bad_target", "message": "帳號不得為空"}), 400

    if action == 'add':
        if target not in cfg[org]:
            cfg[org].append(target)
    elif action == 'remove':
        cfg[org] = [a for a in cfg[org] if a != target]
    else:
        return jsonify({"error": "bad_action"}), 400

    utils.save_admin_config(cfg)
    logger.info(f"[管理員名單] 操作者={account} {action} {target} @ {org}")
    return jsonify({"status": "ok", "config": cfg})