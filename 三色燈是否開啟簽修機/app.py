import json
import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from filelock import FileLock

app = Flask(__name__)
CORS(app)


# 設定 JSON 檔案路徑 (假設與 app.py 在同一目錄)
JSON_FILE_PATH = os.path.join(os.path.dirname(__file__), 'normal.json')

LOCK_FILE = JSON_FILE_PATH + ".lock"

def load_machine_data():
    """讀取並回傳 JSON 檔案內容"""
    try:
        # 檢查檔案是否存在
        if not os.path.exists(JSON_FILE_PATH):
            print(f"錯誤: 找不到檔案 {JSON_FILE_PATH}")
            return []
            
        with open(JSON_FILE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data
    except Exception as e:
        print(f"讀取 JSON 時發生錯誤: {e}")
        return []

@app.route('/api/machines', methods=['GET'])
def get_machines():
    # 每次請求時重新讀取檔案，確保抓到最新狀態
    data = load_machine_data()
    
    
    return jsonify(data)


@app.route('/api/update_status', methods=['POST'])
def update_status():
    try:
        data = request.get_json()

        machine_id = data.get('MachineID')
        ip = data.get('IP')
        new_status = data.get('Status')  # Y / N

        if not machine_id or not ip:
            return jsonify({"message": "缺少欄位"}), 400

        with FileLock(LOCK_FILE, timeout=5):

            with open(JSON_FILE_PATH, 'r', encoding='utf-8') as f:
                machines = json.load(f)

            updated = False

            for m in machines:
                if m.get("MachineID") == machine_id and m.get("IP") == ip:

                    # ⭐ 這裡改成字串
                    m["open_d99"] = new_status

                    updated = True
                    break

            if not updated:
                return jsonify({"message": "找不到機台"}), 404

            with open(JSON_FILE_PATH, 'w', encoding='utf-8') as f:
                json.dump(machines, f, ensure_ascii=False, indent=2)

        return jsonify({"message": "OK"})

    except Exception as e:
        return jsonify({"message": str(e)}), 500


@app.route('/api/update_machine', methods=['POST'])
def update_machine():
    """更新整筆機台資料（除 MachineID / IP 外所有欄位）"""
    try:
        data = request.get_json()

        machine_id = data.get('MachineID')
        ip = data.get('IP')

        if not machine_id or not ip:
            return jsonify({"message": "缺少 MachineID 或 IP"}), 400

        # 不允許透過此 API 修改識別欄位
        data.pop('MachineID', None)
        data.pop('IP', None)

        with FileLock(LOCK_FILE, timeout=5):
            with open(JSON_FILE_PATH, 'r', encoding='utf-8') as f:
                machines = json.load(f)

            updated = False
            for m in machines:
                if m.get("MachineID") == machine_id and m.get("IP") == ip:
                    m.update(data)   # 把前端傳來的欄位全部寫入
                    m["MachineID"] = machine_id  # 確保識別欄位不被蓋掉
                    m["IP"] = ip
                    updated = True
                    break

            if not updated:
                return jsonify({"message": "找不到機台"}), 404

            with open(JSON_FILE_PATH, 'w', encoding='utf-8') as f:
                json.dump(machines, f, ensure_ascii=False, indent=2)

        return jsonify({"message": "OK"})

    except Exception as e:
        return jsonify({"message": str(e)}), 500
if __name__ == '__main__':
    # 確保 API 啟動在 5000 埠
    app.run(debug=True, port=5000)