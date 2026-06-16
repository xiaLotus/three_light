"""進度節點樹（每個任務一個 JSON 檔）。"""
import json
import os
import uuid
from datetime import datetime

import config


def progress_path(id_):
    return os.path.join(config.PROGRESS_DIR, f"{id_}.json")


def read_progress(id_):
    p = progress_path(id_)
    if not os.path.exists(p):
        return []
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_progress(id_, tree):
    with open(progress_path(id_), 'w', encoding='utf-8') as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)


def find_node(nodes, target_id):
    """遞迴尋找節點。"""
    for node in nodes:
        if node.get('id') == target_id:
            return node
        found = find_node(node.get('children', []), target_id)
        if found:
            return found
    return None


def latest_progress(id_):
    """遞迴整棵樹，取時間最新的一筆進度文字。"""
    tree = read_progress(id_)
    latest = {'time': '', 'text': ''}

    def walk(nodes):
        nonlocal latest
        for n in nodes:
            if n.get('time', '') > latest['time']:
                latest = {'time': n.get('time', ''), 'text': n.get('text', '')}
            walk(n.get('children', []))

    walk(tree)
    return latest['text']


def new_node(text):
    return {
        'id':       str(uuid.uuid4()),
        'time':     datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'text':     text,
        'children': []
    }


def delete_progress(id_):
    p = progress_path(id_)
    if os.path.exists(p):
        os.remove(p)