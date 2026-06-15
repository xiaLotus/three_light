"""任務清單與增改刪路由。"""
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request
from loguru import logger

import config
import utils

bp = Blueprint('task', __name__)


@bp.route('/api/today_page')
def today_page():
    data  = utils.load_data()
    today = datetime.now().strftime("%Y-%m-%d")
    simple = [{
        'id': d['id'], '日期': d['日期'], '提案人': d['提案人'],
        '組織類別': d['組織類別'], '案件分類': d['案件分類'],
        '項目描述': d['項目描述'], '項目Due Date': d['項目Due Date'],
        '距今': d['距今'], '狀態': d.get('狀態', ''),
        '項目OWNER': d.get('項目OWNER', ''),
        '當前最新進度': utils.latest_progress(d['id'])
    } for d in data]
    return jsonify({
        "today": [d for d in simple if d["日期"] == today],
        "due":   [d for d in simple if d["項目Due Date"] and d["項目Due Date"] <= today]
    })


@bp.route('/api/all')
def all_tasks():
    data = utils.load_data()
    for d in data:
        d['當前最新進度'] = utils.latest_progress(d['id'])
    return jsonify(data)


@bp.route('/api/add', methods=['POST'])
def add_task():
    data     = utils.load_data()
    req      = request.json
    new_task = {field: req.get(field, "") for field in config.CSV_FIELDS}
    new_task['id']   = str(uuid.uuid4())
    new_task['日期'] = req.get('日期', datetime.now().strftime("%Y-%m-%d"))
    new_task['距今'] = utils.calc_days_due(req.get('項目Due Date', ''))
    new_task['當前最新進度'] = ''
    data.append(new_task)
    utils.save_data(data)
    logger.info(f"[新增任務] id={new_task['id']} 提案人={new_task['提案人']} 組織={new_task['組織類別']} 描述={new_task['項目描述'][:50]}")

    init_text = req.get('當前最新進度', '').strip()
    if init_text:
        utils.write_progress(new_task['id'], [{
            "time": datetime.now().strftime("%Y-%m-%d %H:%M"), "text": init_text
        }])
    return jsonify({"status": "ok", "id": new_task['id']})


@bp.route('/api/update', methods=['POST'])
def update_task():
    data    = utils.load_data()
    req     = request.json
    id_     = req.get('id')
    account = (req.get('_account') or '').strip().upper()

    task = next((r for r in data if r['id'] == id_), None)
    if task is None:
        return jsonify({"error": "not_found", "message": "找不到任務"}), 404

    is_owner     = task.get('提案人', '') in (account, utils.get_user_name(account))
    is_org_admin = task.get('組織類別') in utils.get_admin_orgs(account)
    if not (is_owner or is_org_admin):
        logger.warning(f"[權限拒絕-更新] 帳號={account} 嘗試修改 id={id_} 組織={task.get('組織類別')} 提案人={task.get('提案人')}")
        return jsonify({"error": "forbidden", "message": "僅提案人本人或該組織管理員可修改"}), 403

    updatable = ['管理OWNER', '項目Due Date', '項目OWNER', '單項目Due Date',
                 '項目描述', '案件分類', '組織類別', '棟別', '樓層', '站點', '狀態']
    changed = {f: req[f] for f in updatable if f in req}
    for field in updatable:
        if field in req:
            task[field] = req[field]
    task['距今'] = utils.calc_days_due(task.get('項目Due Date', ''))
    utils.save_data(data)
    logger.info(f"[更新任務] 帳號={account} id={id_} 變更欄位={list(changed.keys())} 內容={changed}")
    return jsonify({"status": "ok"})


@bp.route('/api/delete', methods=['POST'])
def delete_task():
    data    = utils.load_data()
    id_     = request.json.get("id")
    deleted = next((d for d in data if d["id"] == id_), None)
    data    = [d for d in data if d["id"] != id_]
    utils.save_data(data)
    utils.delete_progress(id_)
    logger.warning(f"[刪除任務] id={id_} 提案人={deleted.get('提案人') if deleted else '?'} 描述={(deleted.get('項目描述','') if deleted else '')[:50]}")
    return jsonify({"status": "ok"})