"""進度節點樹路由。"""
from datetime import datetime
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
    return jsonify({"status": "ok", "tree": tree, "node": node, "latest": utils.latest_progress(id_)})

@bp.route('/api/progress/<id_>/node/<node_id>', methods=['POST'])
def edit_node(id_, node_id):
    req  = request.json or {}
    text = req.get('text', '').strip()
    if not text:
        return jsonify({"status": "error", "message": "內容不得為空"}), 400

    tree = utils.read_progress(id_)
    node = utils.find_node(tree, node_id)
    if node is None:
        return jsonify({"status": "error", "message": "找不到節點"}), 404

    node['text'] = text
    node['time'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    utils.write_progress(id_, tree)

    # 同步更新 tasks.csv 當前最新進度
    latest = utils.latest_progress(id_)
    data = utils.load_data()
    for row in data:
        if row['id'] == id_:
            row['當前最新進度'] = latest
            break
    utils.save_data(data)

    logger.info(f"[編輯節點] 任務id={id_} 節點id={node_id} 新內容={text[:80]}")
    return jsonify({"status": "ok", "tree": tree, "latest": latest})


@bp.route('/api/progress/<id_>/node/<node_id>', methods=['DELETE'])
def delete_node(id_, node_id):
    tree = utils.read_progress(id_)

    def remove_node(nodes, target_id):
        for i, n in enumerate(nodes):
            if n['id'] == target_id:
                nodes.pop(i)
                return True
            if remove_node(n.get('children', []), target_id):
                return True
        return False

    if not remove_node(tree, node_id):
        return jsonify({"status": "error", "message": "找不到節點"}), 404

    utils.write_progress(id_, tree)

    # 同步更新 tasks.csv 當前最新進度
    latest = utils.latest_progress(id_)
    data = utils.load_data()
    for row in data:
        if row['id'] == id_:
            row['當前最新進度'] = latest
            break
    utils.save_data(data)

    logger.info(f"[刪除節點] 任務id={id_} 節點id={node_id}")
    return jsonify({"status": "ok", "tree": tree, "latest": latest})