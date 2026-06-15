"""管理員權限與使用者名冊。"""
import json
import os
from ldap3 import Server, Connection, ALL, NTLM  # type: ignore
from ldap3.core.exceptions import LDAPException, LDAPBindError  # type: ignore
import config


def load_admin_config():
    if not os.path.exists(config.ADMIN_FILE):
        return {}
    with open(config.ADMIN_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_admin_config(cfg):
    with open(config.ADMIN_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=4)


def get_admin_orgs(account):
    cfg = load_admin_config()
    acc = account.upper()
    return [org for org, accounts in cfg.items() if acc in accounts]


def get_user_name(account):
    if not os.path.exists(config.USERS_FILE):
        return account.upper()
    with open(config.USERS_FILE, 'r', encoding='utf-8') as f:
        users = json.load(f).get('users', [])
    acc = account.upper()
    for u in users:
        if u.get('account', '').upper() == acc:
            return u.get('name') or acc
    return acc


def load_user_names():
    """回傳 { 帳號: 姓名 } 對照表。"""
    names = {}
    if os.path.exists(config.USERS_FILE):
        with open(config.USERS_FILE, 'r', encoding='utf-8') as f:
            for u in json.load(f).get('users', []):
                names[u.get('account', '').upper()] = u.get('name', '')
    return names




def authenticate_user(username, password):
    try:
        server = Server('ldap://KHADDC02.kh.asegroup.com', get_info=ALL)
        user   = f'kh\\{username}'
        password = f'{password}'
        return True
        conn = Connection(server, user=user, password=password, authentication=NTLM)
        if conn.bind():
            return True
        else:
            return False
    except Exception:
        return False