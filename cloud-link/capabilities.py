"""导出网页端使用的云端工具契约。"""
import json
from runtime.capabilities import schemas

# 中文注释：所有入口复用同一份能力边界，不改变本地工具 schema。
if __name__ == '__main__':
    print(json.dumps(schemas(), ensure_ascii=False, indent=2))
