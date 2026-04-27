import os
import pandas as pd
from sqlalchemy import create_engine, text

db_config = {
    'host': '10.11.104.247',
    'port': 3306,
    'user': 'A3CIM',
    'password': 'A3CIM',
    'database': 'machine_monitoring',
    'charset': 'utf8mb4'
}

engine = create_engine(
    f"mysql+pymysql://{db_config['user']}:{db_config['password']}@{db_config['host']}:{db_config['port']}/{db_config['database']}?charset={db_config['charset']}"
)

# delete_sql = text("""
# DELETE FROM machine_status
# WHERE id BETWEEN :start_id AND :end_id
# """)

# with engine.begin() as conn:  # ✔ 自動 commit
#     result = conn.execute(delete_sql, {
#         "start_id": 42700,
#         "end_id": 42704
#     })
#     print(f"已刪除 {result.rowcount} 筆資料")

# 只撈 Building = 'K21'
sql = """
SELECT *
FROM machine_status
"""

df = pd.read_sql(sql, engine)

# 存成 CSV
csv_path = "三色燈上拋資訊.csv"
df.to_csv(csv_path, index=False, encoding="utf-8-sig")

print(f"已輸出 {len(df)} 筆的資料到 {csv_path}")


# update_sql = text("""
# UPDATE machine_status
# SET station = :new_station
# WHERE station = :old_station
# """)

# with engine.begin() as conn:  # ✔ 自動 commit
#     result = conn.execute(
#         update_sql,
#         {
#             "old_station": "K22-8F_烤箱",
#             "new_station": "K22-8F_3380_烤箱Loader"
#         }
#     )
#     print(f"✅ 已更新 {result.rowcount} 筆資料")