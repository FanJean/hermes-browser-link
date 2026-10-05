"""复用原 BridgeClient，每个云端执行线程独立连接；不启动本地服务。"""
import threading
from .capabilities import NATIVE_BRIDGE, native_tools


class BridgePool:
    def __init__(self, home):
        self.home = home
        self.module = native_tools._runtime.load_module(NATIVE_BRIDGE / 'client.py', 'cloud_bridge_client_')
        self.clients = {}
        self.guard = threading.Lock()
        self.closed = False

    def call(self, method, params):
        with self.guard:
            if self.closed:
                raise RuntimeError('cloud_bridge_closed')
            thread = threading.current_thread()
            client = self.clients.get(thread)
            if client is None:
                client = self.module.BridgeClient(self.home, timeout=35, autostart=False)
                self.clients[thread] = client
        return client.call(method, params)

    def close(self):
        # 中文注释：关闭所有云端私有套接字，不关闭共享 daemon 或本地客户端。
        with self.guard:
            self.closed = True
            clients = list(self.clients.values())
            self.clients.clear()
        for client in clients:
            client.close()
