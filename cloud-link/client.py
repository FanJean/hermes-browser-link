#!/usr/bin/env python3
"""云端连接命令入口；运行时与浏览器 Native Messaging 共用。"""
import os
from runtime.client import main

# 中文注释：只作为命令入口，不启动或改写本地浏览器桥。
if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (ValueError, OSError):
        raise SystemExit('云端连接未完成，请检查配对和连接状态。') from None
