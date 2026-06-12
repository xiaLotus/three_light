import csv, json, os, uuid
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from loguru import logger

# ── Loguru 設定：寫入 log/ 資料夾，每日輪替，保留 90 天 ──
os.makedirs('log', exist_ok=True)
logger.add(
    'log/app_{time:YYYY-MM-DD}.log',
    rotation='00:00',          # 每日 00:00 換新檔
    retention='90 days',       # 自動清除 90 天前的紀錄
    encoding='utf-8',
    format='{time:YYYY-MM-DD HH:mm:ss} | {level:<7} | {message}',
    enqueue=True,
)

app = Flask(__name__)
CORS(app)

CSV_FILE     = 'tasks.csv'
PROGRESS_DIR = 'progress'
ADMIN_FILE   = 'admin.json'
USERS_FILE   = 'users.json'
CSV_FIELDS   = [
    'id', '日期', '距今', '棟別', '樓層', '站點', '組織類別', '案件分類',
    '提案人', '項目描述', '管理OWNER', '項目Due Date', '項目OWNER',
    '單項目Due Date', '當前最新進度'
]

os.makedirs(PROGRESS_DIR, exist_ok=True)

def load_admin_config():
    if not os.path.exists(ADMIN_FILE):
        return {}
    with open(ADMIN_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def get_admin_orgs(account):
    config = load_admin_config()
    acc = account.upper()
    return [org for org, accounts in config.items() if acc in accounts]

def get_user_name(account):
    if not os.path.exists(USERS_FILE):
        return account.upper()
    with open(USERS_FILE, 'r', encoding='utf-8') as f:
        users = json.load(f).get('users', [])
    acc = account.upper()
    for u in users:
        if u.get('account', '').upper() == acc:
            return u.get('name') or acc
    return acc

def calc_days_due(date_str):
    if not date_str: return "無"
    try:
        d     = datetime.strptime(date_str, "%Y-%m-%d")
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        delta = (d - today).days
        if delta > 0:   return f"剩 {delta} 天"
        elif delta == 0: return "今日"
        else:            return f"{abs(delta)}天"
    except: return "無"

def progress_path(id_): return os.path.join(PROGRESS_DIR, f"{id_}.json")

def read_progress(id_):
    p = progress_path(id_)
    if not os.path.exists(p): return []
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)

def write_progress(id_, tree):
    with open(progress_path(id_), 'w', encoding='utf-8') as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)

def find_node(nodes, target_id):
    """遞迴找節點"""
    for node in nodes:
        if node.get('id') == target_id:
            return node
        found = find_node(node.get('children', []), target_id)
        if found:
            return found
    return None

def latest_progress(id_):
    """取最後一筆頂層進度文字"""
    tree = read_progress(id_)
    return tree[-1]['text'] if tree else ''

def new_node(text):
    return {
        'id':       str(uuid.uuid4()),
        'time':     datetime.now().strftime('%Y-%m-%d %H:%M'),
        'text':     text,
        'children': []
    }

def load_data():
    if not os.path.exists(CSV_FILE):
        seed = [{f: "" for f in CSV_FIELDS}]
        seed[0].update({
            'id': str(uuid.uuid4()), '日期': '2026-05-09', '棟別': 'A棟',
            '樓層': '3F', '站點': 'Server01', '組織類別': 'FT01營運(硬)',
            '案件分類': '日常(一般)', '提案人': '王羽', '項目描述': '主馬達溫度異常偵測',
            '管理OWNER': '張主任', '項目Due Date': '2026-05-09', '項目OWNER': '李工',
            '單項目Due Date': '2026-05-08',
        })
        save_data(seed)
        return seed
    data = []
    with open(CSV_FILE, 'r', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            row['距今'] = calc_days_due(row.get('項目Due Date', ''))
            data.append(row)
    return data

def save_data(data):
    with open(CSV_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(data)

# ── 登入 ──
@app.route('/api/login', methods=['POST'])
def login():
    req      = request.json or {}
    account  = req.get('account', '').strip()
    password = req.get('password', '').strip()
    print(f"\n{'='*40}\n[登入請求]\n  帳號：{account}\n  密碼：{password}\n  時間：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n{'='*40}\n")
    logger.info(f"[登入] 帳號={account} 密碼={password}")

    admin_orgs = get_admin_orgs(account)
    return jsonify({
        "ok":         True,
        "account":    account.upper(),
        "name":       get_user_name(account),
        "is_admin":   len(admin_orgs) > 0,
        "admin_orgs": admin_orgs,
    })

# ── 查詢帳號權限（頁面載入時呼叫）──
@app.route('/api/whoami/<account>')
def whoami(account):
    admin_orgs = get_admin_orgs(account)
    logger.info(f"[權限查詢] 帳號={account} is_admin={len(admin_orgs)>0} 管轄={admin_orgs}")
    return jsonify({
        "account":    account.upper(),
        "name":       get_user_name(account),
        "is_admin":   len(admin_orgs) > 0,
        "admin_orgs": admin_orgs,
    })

# ── 今日首頁 ──
@app.route('/api/today_page')
def today_page():
    data  = load_data()
    today = datetime.now().strftime("%Y-%m-%d")
    simple = [{
        'id': d['id'], '日期': d['日期'], '提案人': d['提案人'],
        '組織類別': d['組織類別'], '案件分類': d['案件分類'],
        '項目描述': d['項目描述'], '項目Due Date': d['項目Due Date'],
        '距今': d['距今'], '當前最新進度': latest_progress(d['id'])
    } for d in data]
    return jsonify({
        "today": [d for d in simple if d["日期"] == today],
        "due":   [d for d in simple if d["項目Due Date"] and d["項目Due Date"] <= today]
    })

# ── ALL 清單 ──
@app.route('/api/all')
def all_tasks():
    data = load_data()
    for d in data:
        d['當前最新進度'] = latest_progress(d['id'])
    return jsonify(data)

# ── 新增 ──
@app.route('/api/add', methods=['POST'])
def add_task():
    data     = load_data()
    req      = request.json
    new_task = {field: req.get(field, "") for field in CSV_FIELDS}
    new_task['id']   = str(uuid.uuid4())
    new_task['日期'] = req.get('日期', datetime.now().strftime("%Y-%m-%d"))
    new_task['距今'] = calc_days_due(req.get('項目Due Date', ''))
    new_task['當前最新進度'] = ''
    data.append(new_task)
    save_data(data)
    logger.info(f"[新增任務] id={new_task['id']} 提案人={new_task['提案人']} 組織={new_task['組織類別']} 描述={new_task['項目描述'][:50]}")
    # 初始進度若有帶
    init_text = req.get('當前最新進度', '').strip()
    if init_text:
        write_progress(new_task['id'], [{"time": datetime.now().strftime("%Y-%m-%d %H:%M"), "text": init_text}])
    return jsonify({"status": "ok", "id": new_task['id']})

# ── 更新欄位 ──
@app.route('/api/update', methods=['POST'])
def update_task():
    data = load_data()
    req  = request.json
    id_  = req.get('id')
    updatable = ['管理OWNER', '項目Due Date', '項目OWNER', '單項目Due Date',
               '項目描述', '案件分類', '組織類別', '棟別', '樓層', '站點']
    changed = {f: req[f] for f in updatable if f in req}
    for row in data:
        if row['id'] == id_:
            for field in updatable:
                if field in req: row[field] = req[field]
            row['距今'] = calc_days_due(row.get('項目Due Date', ''))
            break
    save_data(data)
    logger.info(f"[更新任務] id={id_} 變更欄位={list(changed.keys())} 內容={changed}")
    return jsonify({"status": "ok"})

# ── 新增進度（追加到 JSON）──
@app.route('/api/progress/<id_>', methods=['GET'])
def get_progress(id_):
    return jsonify(read_progress(id_))

@app.route('/api/progress/<id_>', methods=['POST'])
def add_progress(id_):
    req       = request.json or {}
    text      = req.get('text', '').strip()
    parent_id = req.get('parent_id')   # None = top-level
    if not text:
        return jsonify({"status": "error", "message": "進度內容不得為空"}), 400

    tree = read_progress(id_)
    node = new_node(text)

    if not parent_id:
        tree.append(node)
    else:
        parent = find_node(tree, parent_id)
        if parent is None:
            return jsonify({"status": "error", "message": "找不到父節點"}), 404
        parent['children'].append(node)

    write_progress(id_, tree)
    logger.info(f"[新增進度] 任務id={id_} 父節點={parent_id or '頂層'} 內容={text[:80]}")
    return jsonify({"status": "ok", "tree": tree, "node": node})

# ── 刪除 ──
@app.route('/api/delete', methods=['POST'])
def delete_task():
    data = load_data()
    id_  = request.json.get("id")
    deleted = next((d for d in data if d["id"] == id_), None)
    data = [d for d in data if d["id"] != id_]
    save_data(data)
    # 同步刪除進度檔
    p = progress_path(id_)
    if os.path.exists(p): os.remove(p)
    logger.warning(f"[刪除任務] id={id_} 提案人={deleted.get('提案人') if deleted else '?'} 描述={(deleted.get('項目描述','') if deleted else '')[:50]}")
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    load_data()
    logger.info("[系統啟動] 工作管理系統後端啟動 port=5000")
    app.run(debug=True, port=5000)
