"""進度節點樹路由。"""
from flask import Blueprint, jsonify, request
from loguru import logger

import utils

bp = Blueprint('progress', __name__)


@bp.route('/api/progress/<id_>', methods=['GET'])
def get_progress(id_):
    return jsonify(utils.read_progress(id_))


@bp.route('/api/progress/<id_>', methods=['POST'])
def add_progress(id_):
    req       = request.json or {}
    text      = req.get('text', '').strip()
    parent_id = req.get('parent_id')   # None = 頂層
    if not text:
        return jsonify({"status": "error", "message": "進度內容不得為空"}), 400

    tree = utils.read_progress(id_)
    node = utils.new_node(text)

    if not parent_id:
        tree.append(node)
    else:
        parent = utils.find_node(tree, parent_id)
        if parent is None:
            return jsonify({"status": "error", "message": "找不到父節點"}), 404
        parent['children'].append(node)

    utils.write_progress(id_, tree)

    # 同步寫回 tasks.csv 的「當前最新進度」
    data = utils.load_data()
    for row in data:
        if row['id'] == id_:
            row['當前最新進度'] = utils.latest_progress(id_)
            break
    utils.save_data(data)

    logger.info(f"[新增進度] 任務id={id_} 父節點={parent_id or '頂層'} 內容={text[:80]}")
    return jsonify({"status": "ok", "tree": tree, "node": node})