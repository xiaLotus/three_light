import os
os.environ['PYTHONUNBUFFERED'] = '1'

import json
import sys
import time
import threading
import requests
import logging
from logging.handlers import TimedRotatingFileHandler
from pymodbus.client.sync import ModbusTcpClient # type: ignore
from datetime import datetime
import configparser

# =====================================================
# 基礎工具函數
# =====================================================
def get_base_dir():
    """取得程式執行基礎路徑（支援 PyInstaller 打包）"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

# =====================================================
# 全域變數
# =====================================================
stop_event = threading.Event()
threads = []
running_machines = {}
running_machines_lock = threading.Lock()   # 🔹 保護 running_machines 的讀寫
device_loggers = {}
logger_lock = threading.Lock()
heartbeat_stop = threading.Event()

# =====================================================
# 標準 logging 設定（主控台）
# =====================================================
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_formatter = logging.Formatter(
    '%(asctime)s.%(msecs)03d | %(levelname)-8s | %(name)s:%(funcName)s:%(lineno)d - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
console_handler.setFormatter(console_formatter)

main_logger = logging.getLogger('main')
main_logger.setLevel(logging.INFO)
main_logger.addHandler(console_handler)
main_logger.propagate = False

# =====================================================
# 讀取 config.ini
# =====================================================
config = configparser.ConfigParser()
BASE_DIR = get_base_dir()
config_path = os.path.join(BASE_DIR, "config.ini")

if not os.path.exists(config_path):
    raise FileNotFoundError(f"❌ 找不到 config.ini: {config_path}")

config.read(config_path, encoding="utf-8-sig")

TV_url        = config.get("api", "tv_url")
DASHBOARD_URL = config.get("api", "dashboard_url")
HEADERS       = {'Content-Type': config.get("api", "content_type")}
MACHINE_CONFIG = config.get("path", "machine_config")
BUILDING      = config.get("site", "building")
FLOOR         = config.get("site", "floor")
SOURCE_TYPE   = config.get("site", "source_type")

if not TV_url or not DASHBOARD_URL:
    main_logger.error("[ERROR] config.ini 缺少必要 API 設定 (tv_url / dashboard_url)")
    sys.exit(1)

if not os.path.exists(MACHINE_CONFIG):
    main_logger.error(f"[ERROR] 找不到機器設定檔：{MACHINE_CONFIG}")
    sys.exit(1)

main_logger.info(f"[INFO] 程式啟動 | Building:{BUILDING} Floor:{FLOOR} Source:{SOURCE_TYPE}")
main_logger.info(f"[INFO] TV_API: {TV_url}")
main_logger.info(f"[INFO] Dashboard_API: {DASHBOARD_URL}")

# =====================================================
# 狀態持久化（避免重開程式 / 斷線重連後誤觸 Dashboard）
# =====================================================
STATE_DIR = os.path.join(get_base_dir(), "state")

def save_last_state(machine_id, state):
    """
    將設備最後一次上拋的狀態寫入 JSON 檔案，供下次程式啟動時恢復使用。
    - 狀態檔存放於 state/{MachineID}.json
    - 寫入失敗只記錄警告，不中斷程式
    """
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, f"{machine_id}.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "state":      state,
                    "updated_at": datetime.now().isoformat()
                },
                f,
                ensure_ascii=False
            )
    except Exception as e:
        main_logger.warning(f"[WARN] 無法儲存 {machine_id} 狀態：{e}")


def load_last_state(machine_id):
    """
    從 JSON 檔案讀取設備上次狀態。
    - 找不到檔案（第一次執行）→ 回傳 None，行為與原始啟動相同
    - 讀取 / 解析失敗 → 回傳 None
    """
    path = os.path.join(STATE_DIR, f"{machine_id}.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f).get("state")
    except FileNotFoundError:
        return None
    except Exception as e:
        main_logger.warning(f"[WARN] 無法讀取 {machine_id} 狀態：{e}")
        return None


def get_device_logger(ip):
    """為每個 IP 建立獨立的檔案 logger（每天一個檔名）"""
    with logger_lock:

        today = datetime.now().strftime("%Y-%m-%d")

        # 🔹 如果已存在 logger
        if ip in device_loggers:
            # 同一天 → 直接使用
            if device_loggers[ip]['date'] == today:
                return device_loggers[ip]['logger']
            else:
                # 🔹 跨日 → 關閉舊 handler，重新建立
                try:
                    device_loggers[ip]['handler'].close()
                except Exception:
                    pass
                device_loggers[ip]['logger'].handlers.clear()
                del device_loggers[ip]

        base_dir = get_base_dir()
        log_dir  = os.path.join(base_dir, "Log", ip.replace(".", "_"))
        os.makedirs(log_dir, exist_ok=True)

        # ✅ 直接使用日期當檔名
        log_path = os.path.join(log_dir, f"{today}.log")

        file_logger = logging.getLogger(f"device_{ip}")
        file_logger.setLevel(logging.INFO)
        file_logger.propagate = False
        file_logger.handlers.clear()

        file_handler = logging.FileHandler(log_path, encoding='utf-8-sig')
        file_handler.setLevel(logging.INFO)

        file_formatter = logging.Formatter(
            '%(asctime)s.%(msecs)03d | %(levelname)-8s | %(name)s:%(funcName)s:%(lineno)d - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(file_formatter)
        file_logger.addHandler(file_handler)

        device_loggers[ip] = {
            'logger': file_logger,
            'handler': file_handler,
            'date': today   # 🔹 記錄日期用來判斷跨日
        }

        return file_logger


def write_log(ip, machine_id, state):
    log = get_device_logger(ip)
    log.info(f"[INFO] {machine_id} 狀態切換為 {state}")


def log_reconnect(ip, machine_id, success):
    log = get_device_logger(ip)
    status_msg = "✅ 連線成功" if success else "🔁 正在重新嘗試連線中..."
    log.info(f"[INFO] {machine_id} {status_msg}")

# =====================================================
# 🔹 模組級別 helper（移出迴圈，避免每秒重建）
# =====================================================
def safe_get_di(di_array, index):
    return di_array[index] if index < len(di_array) else 0


def post_dashboard_alarm(machine, state, prev_state=None, is_startup=False):
    """
    上拋設備狀態到 Dashboard API
    規則：
      🟢 綠燈：Flag=false → 啟動 | Flag=true → 關閉
      🔴 紅燈：Flag=true  → 啟動 | Flag=false → 關閉

    is_startup=True 時，跳過「舊狀態結束」的請求。
    原因：程式重啟後 Dashboard 不一定還記得舊狀態，
         補送一個無效的結束請求反而造成誤判。
    """
    machine_id = machine.get("MachineID", "Unknown")
    alarm_code = machine.get("AlarmCode", {})
    alarm_msg  = machine.get("AlarmMessage", {})
    flag_map   = machine.get("Flag", {})

    # 🔹 輔助函數：建立 Payload + 計算語意標籤
    def build_payload_and_action(color, flag_value):
        """
        回傳 (payload, action_text)
        action_text 範例：
          🟢啟動綠燈 / 🔴關閉綠燈 / 🔴啟動紅燈 / 🟢關閉紅燈
        """
        if color == "GREEN":
            action = "🟢啟動綠燈" if not flag_value else "🔴關閉綠燈"
        else:
            action = "🔴啟動紅燈" if flag_value else "🟢關閉紅燈"

        payload = {
            "System":       machine.get("System", machine_id),
            "Mechanism":    machine.get("Mechanism", "Robot"),
            "ClassName":    machine.get("ClassName", machine_id),
            "Plant":        machine.get("Plant", ""),
            "Site":         machine.get("Site", ""),
            "Place":        machine.get("Place", ""),
            "AlarmCode":    alarm_code.get(color, ""),
            "AlarmMessage": alarm_msg.get(color, ""),
            "Flag":         flag_value
        }
        return payload, action

    # =========================
    # 1️⃣ 舊狀態結束（反轉 Flag）
    # =========================
    # is_startup=True 時略過：程式剛啟動，Dashboard 不一定有舊狀態的紀錄，
    # 避免送出無效的結束請求造成誤判
    if prev_state is not None and not is_startup:
        prev_color      = "GREEN" if prev_state == "BUSY" else "RED"
        prev_flag_value = not flag_map.get(prev_color, False)  # 結束 = 原始值的反

        payload_prev, action_text = build_payload_and_action(prev_color, prev_flag_value)

        try:
            response = requests.post(DASHBOARD_URL, json=payload_prev, timeout=5)
            if response.status_code == 200:
                main_logger.info(
                    f"[Dashboard][{action_text}] {machine_id} | "
                    f"State=舊狀態結束({prev_state}) | Color={prev_color} | "
                    f"Flag={prev_flag_value} | AlarmCode={payload_prev['AlarmCode']}"
                )
            else:
                main_logger.warning(
                    f"[Dashboard][{action_text}] {machine_id} | "
                    f"Status:{response.status_code} | AlarmCode={payload_prev['AlarmCode']}"
                )
        except requests.exceptions.Timeout:
            main_logger.error(f"[Dashboard][TIMEOUT] {machine_id} 舊狀態結束 請求超時")
        except requests.exceptions.ConnectionError:
            main_logger.error(f"[Dashboard][CONN_ERROR] {machine_id} 舊狀態結束 連線失敗")
        except Exception as e:
            main_logger.error(f"[Dashboard][ERROR] {machine_id} 舊狀態結束 發送錯誤：{e}")

    # =========================
    # 2️⃣ 新狀態開始（原始 Flag）
    # =========================
    color          = "GREEN" if state == "BUSY" else "RED"
    new_flag_value = flag_map.get(color, False)  # 開始 = 設定值

    payload_new, action_text = build_payload_and_action(color, new_flag_value)

    try:
        response = requests.post(DASHBOARD_URL, json=payload_new, timeout=5)
        if response.status_code == 200:
            main_logger.info(
                f"[Dashboard][{action_text}] {machine_id} | "
                f"State=新狀態開始({state}) | Color={color} | "
                f"Flag={new_flag_value} | AlarmCode={payload_new['AlarmCode']}"
            )
        else:
            main_logger.warning(
                f"[Dashboard][{action_text}] {machine_id} | "
                f"Status:{response.status_code} | AlarmCode={payload_new['AlarmCode']}"
            )
    except requests.exceptions.Timeout:
        main_logger.error(f"[Dashboard][TIMEOUT] {machine_id} 新狀態開始 請求超時")
    except requests.exceptions.ConnectionError:
        main_logger.error(f"[Dashboard][CONN_ERROR] {machine_id} 新狀態開始 連線失敗")
    except Exception as e:
        main_logger.error(f"[Dashboard][ERROR] {machine_id} 新狀態開始 發送錯誤：{e}")


def post_state(data_template, state, ip=None, machine_id=None):
    # 🔹 移除未使用的 payload.copy()，直接取 machine_id
    machine_id = machine_id or data_template.get("MachineID", "Unknown")
    try:
        data = {
            "building":    BUILDING,
            "floor":       FLOOR,
            "station":     data_template["MachineID"],
            "status":      state,
            "source_type": SOURCE_TYPE
        }
        TV_response = requests.post(TV_url, json=data, timeout=5)
        if TV_response.status_code == 200:
            main_logger.info(f"[INFO] 上拋成功：{machine_id} - {state} Status Code: {TV_response.status_code} Response: {TV_response.json()}")
        else:
            main_logger.error(f"[ERROR] 上拋失敗：{machine_id} Status Code: {TV_response.status_code}")
    except requests.exceptions.Timeout:
        main_logger.error(f"[ERROR][TIMEOUT] {machine_id} TV 上拋超時")
    except requests.exceptions.ConnectionError:
        main_logger.error(f"[ERROR][CONN_ERROR] {machine_id} TV 連線失敗")
    except Exception as e:
        main_logger.error(f"[ERROR] {machine_id} TV 發送錯誤：{e}")

# =====================================================
# 設備設定載入
# =====================================================
def load_machines():
    try:
        with open(MACHINE_CONFIG, "r", encoding="utf-8") as f:
            machines = json.load(f)
        if isinstance(machines, dict):
            machines = [machines]
        return machines
    except json.JSONDecodeError as e:
        main_logger.error(f"[ERROR] JSON 格式錯誤：{e}")
        return []
    except Exception as e:
        main_logger.error(f"[ERROR] 讀取設定檔失敗：{e}")
        return []

# =====================================================
# 心跳監控
# =====================================================
def heartbeat_thread():
    while not heartbeat_stop.is_set():
        with running_machines_lock:
            count = len(running_machines)
        main_logger.info(f'''[💓 心跳] 監控中設備數：{count} | {datetime.now().strftime('%H:%M:%S')}''')
        time.sleep(5)



# =====================================================
# 主動 Ping 檢測
# =====================================================
import subprocess
import platform

def ping_host(ip):
    """
    對目標 IP 發送一次 ICMP ping，確認主機是否存活。

    Args:
        ip (str): 目標設備 IP。

    Returns:
        bool: True 表示有回應（存活），False 表示無回應（可能關機或網路中斷）。
    """
    system = platform.system().lower()

    # Windows 使用 -n（次數）-w（毫秒）；Linux/Mac 使用 -c（次數）-W（秒）
    if system == "windows":
        cmd = ["ping", "-n", "1", "-w", "2000", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "2", ip]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,  # 不印出 ping 的輸出內容
            stderr=subprocess.DEVNULL,
            timeout=5                   # 最多等 5 秒，避免卡住整個重連流程
        )
        return result.returncode == 0   # returncode=0 表示有收到回應
    except Exception as e:
        main_logger.warning(f"[WARN] ping {ip} 執行失敗：{e}")
        return False


# =====================================================
# 設備監控核心
# =====================================================
def poll_machine(machine, stop_flag):
    # 從設備設定取得 IP、Port、機器ID
    ip         = machine["IP"]
    port       = machine.get("Port", 502)
    machine_id = machine["MachineID"]

    # 印出開始監控的訊息到主控台
    main_logger.info(f"[INFO] 開始監控設備 {machine_id} ({ip}:{port})")

    # 寫入設備獨立 log 檔：記錄程式啟動時間點
    log = get_device_logger(ip)
    log.info(f"[INFO] {machine_id} 🚀 程式啟動，開始監控 ({ip}:{port})")

    # 從持久化檔案恢復上次狀態，避免重開程式後誤觸 Dashboard
    # 若無歷史紀錄（第一次執行），回傳 None
    last_state = load_last_state(machine_id)
    main_logger.info(f"[INFO] {machine_id} 上次狀態：{last_state or '(無紀錄，首次啟動)'}")

    # 建立上拋 TV 用的資料模板（提前建立，首次上拋時也需要用到）
    data_template = {
        "Plant":     machine.get("Plant", ""),
        "Site":      machine.get("Site", ""),
        "MachineID": machine_id
    }

    # 首次執行（無歷史紀錄）→ 主動上拋 ALARM 作為初始狀態
    # 原因：設備狀態未知，保守起見先視為異常，等真實狀態讀回後再正確切換
    if last_state is None:
        post_state(data_template, "ALARM", ip=ip, machine_id=machine_id)
        post_dashboard_alarm(machine, "ALARM", prev_state=None, is_startup=True)
        write_log(ip, machine_id, "ALARM")
        save_last_state(machine_id, "ALARM")
        last_state = "ALARM"
        main_logger.info(f"[INFO] {machine_id} 首次啟動，預設上拋 ALARM")

    # 程式啟動旗標：第一次上拋時為 True，之後自動切換為 False
    # 用途：通知 post_dashboard_alarm 跳過「舊狀態結束」，避免補送無效請求
    is_startup = True

    # 記錄定時派報已觸發的時間點，避免同一時間點重複上拋
    last_timed_post_key = None

    # 記錄第一次斷線的時間，None 表示目前連線正常
    disconnect_time = None

    # 外層迴圈：負責斷線重連，只要沒收到停止信號就持續運行
    while not stop_event.is_set() and not stop_flag.is_set():
        try:
            # 建立 Modbus TCP 連線，timeout=2 秒
            with ModbusTcpClient(ip, port=port, timeout=2) as client:

                # 嘗試連線，失敗則進入斷線處理
                if not client.connect():
                    # 只在第一次斷線時記錄時間，避免重複覆蓋
                    if disconnect_time is None:
                        disconnect_time = datetime.now()
                    # 印出重連提示到主控台
                    main_logger.info(f"[INFO] {machine_id} 🔁 正在重新嘗試連線中...")
                    # 寫入檔案 log
                    log_reconnect(ip, machine_id, success=False)
                    # 拋出例外讓外層 except 接住，等 5 秒後重試
                    raise ConnectionError(f"{ip} 無法連線")

                # 連線成功，印出提示到主控台
                main_logger.info(f"[INFO] {machine_id} ✅ 連線成功")
                # 寫入檔案 log
                log_reconnect(ip, machine_id, success=True)

                # 如果之前有記錄斷線時間，表示這次是重連成功
                if disconnect_time is not None:
                    # 計算斷線總秒數
                    duration = datetime.now() - disconnect_time
                    # 轉換為分鐘和秒
                    m, s = divmod(int(duration.total_seconds()), 60)
                    # 印出斷線時長警告到主控台
                    main_logger.warning(f"[🔌 重連成功] {machine_id} 斷線時長：{m} 分 {s} 秒")
                    # 重置斷線時間
                    disconnect_time = None

                # 【移除】原本重連後會強制將 last_state = None
                # 保留 last_state 的目的：讓重連後只有狀態真正改變才觸發上拋
                # 若重連期間設備狀態確實改變，下方邏輯會正確偵測到並上拋

                # 內層迴圈：連線正常時每秒讀取一次設備狀態
                while not stop_event.is_set() and not stop_flag.is_set():
                    try:
                        # 讀取 Modbus DI（離散輸入），從位址 0 開始讀 12 個點
                        result = client.read_discrete_inputs(0, 12, unit=1)

                        # 如果 Modbus 回傳錯誤，拋出例外跳出內層迴圈重連
                        if result.isError():
                            raise IOError(f"Modbus 讀取失敗：{result}")

                        # 將 bits 轉為 0/1 的整數陣列，方便後續取值
                        di_array = [1 if bit else 0 for bit in result.bits]  # type: ignore

                        # 從設定取得 DI 腳位對應，預設 GREEN=2
                        di_map = machine.get("DI_Map", {"RED": 0, "YELLOW": 1, "GREEN": 2})
                        # 取出綠燈的值
                        green  = safe_get_di(di_array, di_map.get("GREEN", 2))

                        # 從設定取得邏輯設定，GREEN_ACTIVE 表示綠燈亮起時的值（預設為 1）
                        logic        = machine.get("Logic", {})
                        GREEN_ACTIVE = logic.get("GREEN_ACTIVE", 1)

                        # 判斷綠燈是否亮起
                        green_on = (green == GREEN_ACTIVE)
                        # 綠燈亮 → BUSY（運行中），否則 → ALARM（異常）
                        state    = "BUSY" if green_on else "ALARM"

                        # 狀態有變化才上拋，避免重複送出相同狀態
                        if state != last_state:
                            # 上拋狀態到 TV 看板
                            post_state(data_template, state, ip=ip, machine_id=machine_id)
                            # 寫入設備狀態切換的檔案 log
                            write_log(ip, machine_id, state)
                            # 上拋狀態到 Dashboard
                            # is_startup=True 時跳過舊狀態結束，只送新狀態開始
                            # is_startup=False 時正常送出舊狀態結束 + 新狀態開始
                            post_dashboard_alarm(machine, state, prev_state=last_state, is_startup=is_startup)
                            # 更新記錄的狀態
                            last_state = state
                            # 同步將最新狀態持久化至檔案
                            save_last_state(machine_id, state)
                            # 第一次上拋完成後關閉啟動旗標，後續恢復正常雙送邏輯
                            is_startup = False

                        # 取得當下時間
                        now = datetime.now()
                        # 建立含日期的時間 key，用來防止跨日重複觸發
                        time_key = now.strftime("%Y-%m-%d %H:%M")

                        # 判斷是否到達定時派報時間點
                        if (
                            now.strftime("%H:%M") in ["07:30", "19:30"] and  # 時間符合
                            now.second < 5 and                                 # 在該分鐘前 5 秒內
                            last_timed_post_key != time_key                    # 這個時間點還沒拋過
                        ):
                            # 定時上拋當下真實狀態到 TV
                            post_state(data_template, state, ip=ip, machine_id=machine_id)
                            # 印出定時派報提示
                            main_logger.info(f"[⏰ 定時派報] {machine_id} 狀態：{state}")
                            # 記錄已觸發的時間點，防止同一時間點重複觸發
                            last_timed_post_key = time_key

                        # 等待 1 秒後進行下一次讀取
                        time.sleep(1)

                    except Exception as inner_e:
                        # 內層讀取失敗，記錄斷線時間（若尚未記錄）
                        if disconnect_time is None:
                            disconnect_time = datetime.now()
                        # 印出錯誤訊息
                        main_logger.error(f"[ERROR] {machine_id} 讀取失敗：{inner_e}")
                        # 跳出內層迴圈，回到外層重新建立連線
                        break

        except Exception as e:
            # 外層連線失敗，印出錯誤訊息
            main_logger.error(f"[ERROR] {machine_id} 通訊錯誤，5 秒後重試：{e}")

            # 若已斷線超過 10 分鐘，主動 ping 確認主機是否存活
            if disconnect_time is not None:
                elapsed = (datetime.now() - disconnect_time).total_seconds()

                if elapsed >= 600:  # 600 秒 = 10 分鐘
                    main_logger.warning(
                        f"[🔍 主動 Ping] {machine_id} 已斷線 "
                        f"{int(elapsed // 60)} 分 {int(elapsed % 60)} 秒，正在 ping {ip}..."
                    )
                    alive = ping_host(ip)

                    if alive:
                        # 主機有回應，代表網路通但 Modbus 服務可能異常
                        main_logger.info(f"[🟢 Ping 有回應] {machine_id} ({ip}) 主機存活，繼續嘗試 Modbus 連線")
                    else:
                        # 主機無回應，代表設備可能已關機或網路完全中斷
                        main_logger.warning(f"[🔴 Ping 無回應] {machine_id} ({ip}) 主機可能已關機或網路中斷")

            # 等待 5 秒後重試
            time.sleep(5)

    # while 迴圈結束，表示收到停止信號（stop_event 或 stop_flag）
    # 寫入設備獨立 log 檔：記錄程式關閉時間點
    log = get_device_logger(ip)
    log.info(f"[INFO] {machine_id} 🛑 程式關閉，停止監控")


# =====================================================
# 設備熱插拔監控
# =====================================================
def monitor_new_devices():
    while not stop_event.is_set():
        try:
            machines = load_machines()

            with running_machines_lock:
                current_ips  = set(m["IP"] for m in machines)
                # 🔹 明確轉為 set，避免 dict_keys 操作不穩定
                existing_ips = set(running_machines.keys())
                new_ips      = current_ips - existing_ips
                removed_ips  = existing_ips - current_ips

            for m in machines:
                ip = m["IP"]
                if ip not in new_ips:
                    continue
                main_logger.info(f"[INFO] 新設備 {ip} ({m['MachineID']})，啟動監控...")
                get_device_logger(ip)
                time.sleep(0.5)
                stop_flag = threading.Event()
                t = threading.Thread(
                    target=poll_machine,
                    args=(m, stop_flag),
                    daemon=True,
                    name=f"Poll_{ip}"
                )
                t.start()
                with running_machines_lock:
                    running_machines[ip] = (t, stop_flag)

            for ip in list(removed_ips):
                main_logger.info(f"[INFO] 設備 {ip} 已被移除，停止監控")
                with running_machines_lock:
                    if ip not in running_machines:
                        continue
                    t, stop_flag = running_machines[ip]

                stop_flag.set()
                t.join(timeout=10)

                with logger_lock:
                    if ip in device_loggers:
                        device_loggers[ip]['handler'].close()
                        del device_loggers[ip]

                with running_machines_lock:
                    del running_machines[ip]

        except Exception as e:
            main_logger.error(f"[ERROR] 載入設備失敗：{e}")

        # 🔹 無論正常或例外，都等 15 秒後再掃描，避免 CPU 空轉
        time.sleep(15)

# =====================================================
# 主程式入口
# =====================================================
def main():

    main_logger.info(f"[INFO] 🚀 三色燈監控系統啟動 | PID: {os.getpid()}")

    monitor_thread = threading.Thread(
        target=monitor_new_devices,
        daemon=True,
        name="MonitorThread"
    )
    monitor_thread.start()
    threads.append(monitor_thread)

    hb = threading.Thread(
        target=heartbeat_thread, 
        daemon=True, 
        name="Heartbeat"
    )
    hb.start()
    threads.append(hb)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        main_logger.info("[INFO] ⚠️ 偵測到 Ctrl+C，正在停止所有設備...")
        stop_event.set()
        heartbeat_stop.set()

        with running_machines_lock:
            items = list(running_machines.items())
        for ip, (t, flag) in items:
            flag.set()
            t.join(timeout=5)

        monitor_thread.join(timeout=10)

        with logger_lock:
            for info in device_loggers.values():
                info['handler'].close()

        main_logger.info("[INFO] ✅ 所有設備已停止，程式結束")
        sys.exit(0)
    except Exception as e:
        main_logger.error(f"[ERROR] 未預期的錯誤：{e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

# pyinstaller --onefile --console --name "ADAM_機故上拋" --icon "picture/adam.ico" --collect-all requests --collect-all urllib3 --collect-all certifi app.py
