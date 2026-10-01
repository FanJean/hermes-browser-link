"""任务页面执行的 daemon 与本机 CDP 网关离线测试；合成扩展，不启动浏览器。"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "native-bridge"
sys.path.insert(0, str(BRIDGE))
try:
    spec = importlib.util.spec_from_file_location("v11_advanced_daemon", BRIDGE / "daemon.py")
    daemon_module = importlib.util.module_from_spec(spec)
    sys.modules["v11_advanced_daemon"] = daemon_module
    spec.loader.exec_module(daemon_module)
finally:
    sys.path.remove(str(BRIDGE))


class WsClient:
    """最小 WebSocket 客户端：发送带掩码帧，接收未掩码帧。"""

    def __init__(self, url: str, origin: str | None = None):
        rest = url[len("ws://"):]
        host_port, path = rest.split("/", 1)
        host, port = host_port.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
        if origin:
            request += f"Origin: {origin}\r\n"
        self.sock.sendall((request + "\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                break
            head += chunk
        self.status = head.split(b" ", 2)[1].decode() if head else ""
        self.buffer = []

    def send(self, value: dict):
        data = json.dumps(value).encode()
        mask = os.urandom(4)
        head = bytearray([0x81])
        if len(data) < 126:
            head.append(0x80 | len(data))
        else:
            head.append(0x80 | 126)
            head += struct.pack(">H", len(data))
        self.sock.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self) -> dict:
        def exact(n):
            out = b""
            while len(out) < n:
                chunk = self.sock.recv(n - len(out))
                if not chunk:
                    raise EOFError
                out += chunk
            return out
        head = exact(2)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", exact(8))[0]
        payload = exact(length)
        if head[0] & 0x0F == 0x8:
            raise EOFError
        return json.loads(payload)

    def call(self, message_id: int, method: str, params=None, session=None) -> dict:
        request = {"id": message_id, "method": method, "params": params or {}}
        if session:
            request["sessionId"] = session
        self.send(request)
        while True:
            message = self.recv()
            if message.get("id") == message_id:
                return message
            self.buffer.append(message)

    def close(self):
        self.sock.close()


class PageExecutionDaemonTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.daemon = daemon_module.BridgeDaemon(Path(self.tmp.name) / "home")
        self.addCleanup(self.daemon.cdp_gateway.close)
        now = time.time()
        self.task = {"id": "task-a", "owner": "owner-a", "title": "advanced", "instanceId": "inst-a",
                     "browser": "chrome", "state": "ready", "generation": 2, "activeMode": "full", "modeGeneration": 1,
                     "allowedOrigins": ["https://site.test"],
                     "tabIds": [7], "agentTabIds": [7], "requestHistory": [], "createdAt": now, "updatedAt": now,
                     "isolation": "shared-profile", "downloadKey": "0123456789abcdef"}
        self.daemon.tasks["task-a"] = self.task
        self.daemon.task_locks["task-a"] = threading.RLock()
        self.daemon.dedupe["task-a"] = {}
        self.daemon.tab_leases[("inst-a", 7)] = "task-a"
        self.daemon.extensions["inst-a"] = {"instanceId": "inst-a"}
        self.daemon._persist_tasks = lambda: None
        self.daemon._notify_tasks_changed = lambda _instance: None
        self.calls = []

        def extension_call(extension, method, params, timeout=15.0):
            self.calls.append((method, params))
            if method == "browser.execute":
                return {"ok": True, "value": 1}
            if method == "browser.cdp_targets":
                return {"targets": [{"targetId": "T7", "type": "page", "url": "https://site.test/", "title": "S", "tabId": 7}]}
            if method == "browser.cdp":
                return {"echo": params["method"], "tabId": params["tabId"], "files": params["params"].get("files")}
            if method == "browser.cdp_version":
                return {"protocolVersion": "1.3", "product": "Chrome/1"}
            return {}

        self.daemon._extension_call = extension_call

    def run_action(self, request_id, action, **extra):
        return self.daemon._dispatch_client("shared.run", {"owner": "owner-a", "taskId": "task-a",
                                                           "requestId": request_id, "action": action, "tabId": 7, **extra})

    def test_full_runs_js_and_cdp_directly_while_smart_requests_approval(self):
        self.run_action('js-0', 'js.evaluate', expression='1')
        self.run_action('cdp-0', 'cdp.send', method='Runtime.evaluate', params={'expression': '1'})
        self.assertEqual([p['action'] for method, p in self.calls if method == 'browser.execute'], ['js.evaluate', 'cdp.send'])
        self.assertEqual(self.daemon.action_approvals, {})
        self.assertNotIn('advanced', self.task)
        self.assertEqual(self.task['scriptedTabs'], [7])
        self.task['activeMode'] = 'smart'
        # 中文注释：智能审批保留同一任务和标签，但先登记单次 JS 审批。
        pending = self.run_action('js-smart', 'js.evaluate', expression='1')
        self.assertEqual(pending['status'], 'approval_required')
        self.assertEqual([p['action'] for method, p in self.calls if method == 'browser.execute'], ['js.evaluate', 'cdp.send'])

    def test_removed_mode_actions_and_parameters_are_rejected(self):
        for action in ('advanced.enable', 'advanced.revoke'):
            with self.assertRaises(daemon_module.ProtocolError) as caught:
                self.run_action('removed-' + action, action)
            self.assertEqual(caught.exception.code, 'invalid_action')
        with self.assertRaises(daemon_module.ProtocolError):
            self.run_action('extra-grant', 'js.evaluate', expression='1', advancedGeneration=1)

    def test_cdp_target_and_frame_arguments_are_mutually_exclusive(self):
        base = {"owner": "owner-a", "taskId": "task-a", "requestId": "target-check", "action": "cdp.send",
                "tabId": 7, "method": "DOM.getDocument"}
        daemon_module.BridgeDaemon._validate_run_params("cdp.send", {**base, "targetId": "T7"})
        daemon_module.BridgeDaemon._validate_run_params("cdp.send", {**base, "frameToken": "frame-1"})
        daemon_module.BridgeDaemon._validate_run_params("cdp.send", {**base, "timeoutMs": 5000})
        # 中文注释：原始 CDP 不允许同时提供 page target 与子 frame 路由，也不接受非字符串句柄。
        for values in ({"targetId": "T7", "frameToken": "frame-1"}, {"targetId": 7}, {"targetId": ""},
                       {"timeoutMs": 10}, {"timeoutMs": True}, {"timeoutMs": 60001}):
            with self.subTest(values=values), self.assertRaises(daemon_module.ProtocolError):
                daemon_module.BridgeDaemon._validate_run_params("cdp.send", {**base, **values})

    def test_gateway_uses_existing_mode_generation_and_task_revocation(self):
        opened = self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        self.assertNotIn('expiresAt', opened)
        grant = {'taskId': 'task-a', 'owner': 'owner-a', 'generation': 2, 'modeGeneration': 1}
        self.assertIs(self.daemon._gateway_validate(grant), self.task)
        # 中文注释：接管时阻断网关，恢复后仍用原任务授权；不申请新执行权限。
        self.task['state'] = 'paused'
        with self.assertRaises(daemon_module.GatewayDenied):
            self.daemon._gateway_validate(grant)
        self.task['state'] = 'ready'
        self.assertIs(self.daemon._gateway_validate(grant), self.task)
        self.task['modeGeneration'] += 1
        with self.assertRaises(daemon_module.GatewayDenied):
            self.daemon._gateway_validate(grant)
        with self.daemon.state_lock:
            self.daemon._revoke_task_locked(self.task, 'needs_sync')
        self.assertEqual(self.daemon.cdp_gateway._grants, {})

    def test_smart_browser_exec_approval_opens_one_gateway_then_revokes(self):
        # 中文注释：智能审批脚本先进入 daemon 审批队列；批准后只签发一次网关资格。
        self.task['activeMode'] = 'smart'
        digest = 'a' * 64
        request_id = 'browser-exec-fixture'
        with self.assertRaises(daemon_module.ProtocolError) as missing:
            self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        self.assertEqual(missing.exception.code, 'approval_required')
        pending = self.daemon._dispatch_client('shared.run', {
            'owner': 'owner-a', 'taskId': 'task-a', 'requestId': request_id,
            'action': 'gateway.authorize', 'codeDigest': digest})
        self.assertEqual(pending['status'], 'approval_required')
        approval = self.daemon._dispatch_extension('inst-a', 'extension.approvals', {})[0]
        self.daemon._dispatch_extension('inst-a', 'extension.decide', {
            'taskId': self.task['id'], 'nonce': approval['nonce'], 'digest': approval['digest'], 'approve': True})
        deadline = time.time() + 3
        while time.time() < deadline and 'gatewayPermit' not in self.task:
            time.sleep(0.01)
        self.assertIn('gatewayPermit', self.task)
        opened = self.daemon._dispatch_client('shared.cdp_gateway', {
            'owner': 'owner-a', 'taskId': 'task-a', 'requestId': request_id, 'codeDigest': digest})
        self.assertTrue(opened['wsUrl'].startswith('ws://127.0.0.1:'))
        grant = next(iter(self.daemon.cdp_gateway._grants.values()))
        self.assertTrue(grant['smartAuthorized'])
        self.assertIs(self.daemon._gateway_validate(grant), self.task)
        with self.assertRaises(daemon_module.ProtocolError) as consumed:
            self.daemon._dispatch_client('shared.run', {
                'owner': 'owner-a', 'taskId': 'task-a', 'requestId': request_id,
                'action': 'gateway.authorize', 'codeDigest': digest})
        self.assertEqual(consumed.exception.code, 'approval_consumed')
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._dispatch_client('shared.cdp_gateway', {
                'owner': 'owner-a', 'taskId': 'task-a', 'requestId': request_id, 'codeDigest': digest})
        self.daemon._dispatch_client('shared.cdp_gateway_close', {'owner': 'owner-a', 'taskId': 'task-a'})
        self.assertEqual(self.daemon.cdp_gateway._grants, {})

    def test_consumed_smart_vault_approval_is_explicitly_not_reusable(self):
        # 中文注释：私有填写资格消费后，同一请求不会虚报授权成功或落入结果未知。
        self.task['activeMode'] = 'smart'
        command = {'owner': 'owner-a', 'taskId': 'task-a', 'requestId': 'vault-once',
                   'action': 'vault.authorize', 'tabId': 7, 'vaultAction': 'fill', 'handleDigest': 'b' * 64}
        self.assertEqual(self.daemon._dispatch_client('shared.run', command)['status'], 'approval_required')
        approval = self.daemon._dispatch_extension('inst-a', 'extension.approvals', {})[0]
        self.daemon._dispatch_extension('inst-a', 'extension.decide', {
            'taskId': self.task['id'], 'nonce': approval['nonce'], 'digest': approval['digest'], 'approve': True})
        deadline = time.time() + 3
        while time.time() < deadline and 'vaultPermit' not in self.task:
            time.sleep(0.01)
        self.assertIn('vaultPermit', self.task)
        self.assertEqual(self.daemon._dispatch_client('shared.run', command), {'authorized': True})
        self.task.pop('vaultPermit')
        with self.assertRaises(daemon_module.ProtocolError) as consumed:
            self.daemon._dispatch_client('shared.run', command)
        self.assertEqual(consumed.exception.code, 'approval_consumed')
        self.assertFalse(consumed.exception.data.get('outcomeUnknown'))

    def test_leaving_authorized_origin_invalidates_gateway_even_after_return(self):
        opened = self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        queued_grant = next(iter(self.daemon.cdp_gateway._grants.values()))
        old = WsClient(opened['wsUrl'])
        self.addCleanup(old.close)
        self.assertEqual(old.status, '101')
        self.daemon._handle_tab_event('inst-a', {'taskId': 'task-a', 'generation': self.daemon.tasks['task-a']['generation'], 'tabId': 7, 'event': 'navigated', 'documentGeneration': 1, 'outOfScope': True})
        self.assertEqual(self.daemon.cdp_gateway._grants, {})
        self.assertEqual(self.task['state'], 'ready')
        self.assertEqual(self.task['tabIds'], [7])
        self.daemon._handle_tab_event('inst-a', {'taskId': 'task-a', 'generation': self.daemon.tasks['task-a']['generation'], 'tabId': 7, 'event': 'navigated', 'documentGeneration': 2, 'url': 'https://site.test/back'})
        self.assertTrue(queued_grant['revoked'])
        with self.assertRaises(daemon_module.GatewayDenied):
            self.daemon._gateway_validate(queued_grant)
        with self.assertRaises(daemon_module.GatewayDenied):
            self.daemon._gateway_create_tab(queued_grant, 'https://site.test/')
        rejected = WsClient(opened['wsUrl']); self.addCleanup(rejected.close)
        self.assertEqual(rejected.status, '404')
        fresh = self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        self.assertNotEqual(fresh['wsUrl'], opened['wsUrl'])

    def test_gateway_waits_for_vault_task_lock_then_rechecks_credential_page(self):
        # 中文注释：私有填写先占用任务锁时，网关必须等锁释放后重查凭据页面标记。
        grant = {"taskId": "task-a", "owner": "owner-a", "generation": 2, "modeGeneration": 1}
        started = threading.Event()
        outcome = []

        def gateway():
            started.set()
            try:
                self.daemon._gateway_call(grant, "browser.cdp", {"tabId": 7, "method": "Runtime.evaluate", "params": {}})
            except daemon_module.GatewayDenied as error:
                outcome.append(str(error))

        lock = self.daemon.task_locks["task-a"]
        with lock:
            worker = threading.Thread(target=gateway)
            worker.start()
            self.assertTrue(started.wait(1))
            self.task["credentialTabs"] = [7]
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(outcome), 1)
        self.assertFalse(any(method == "browser.cdp" for method, _ in self.calls))

    def test_gateway_routes_task_targets_and_denies_everything_else(self):
        # 中文注释：打开脚本网关直接复用浏览器访问。
        workspace = Path(self.tmp.name) / "workspace"
        workspace.mkdir()
        (workspace / "upload.txt").write_text("ok")
        outside = Path(self.tmp.name) / "private.txt"
        outside.write_text("secret")
        opened = self.daemon._dispatch_client("shared.cdp_gateway", {"owner": "owner-a", "taskId": "task-a",
                                                                     "workspace": str(workspace)})
        url = opened["wsUrl"]
        self.assertTrue(url.startswith("ws://127.0.0.1:"))
        with self.assertRaises(daemon_module.ProtocolError):
            self.daemon._dispatch_client("shared.cdp_gateway", {"owner": "intruder", "taskId": "task-a"})
        browser_page = WsClient(url, origin="https://evil.test")
        self.assertEqual(browser_page.status, "403")
        browser_page.close()
        wrong = WsClient(url.rsplit("/", 1)[0] + "/not-the-token")
        self.assertEqual(wrong.status, "404")
        wrong.close()
        client = WsClient(url)
        self.assertEqual(client.status, "101")
        targets = client.call(1, "Target.getTargets")["result"]["targetInfos"]
        self.assertEqual([row["targetId"] for row in targets], ["T7"])
        session = client.call(2, "Target.attachToTarget", {"targetId": "T7", "flatten": True})["result"]["sessionId"]
        echoed = client.call(3, "Runtime.evaluate", {"expression": "1"}, session=session)
        self.assertEqual(echoed["result"], {"echo": "Runtime.evaluate", "tabId": 7, "files": None})
        self.assertEqual(echoed["sessionId"], session)
        for index, method in enumerate(("Browser.close", "Target.createBrowserContext", "Storage.getCookies"), start=10):
            self.assertIn("error", client.call(index, method))
        outside_result = client.call(20, "DOM.setFileInputFiles", {"nodeId": 1, "files": [str(outside)]}, session=session)
        self.assertEqual(outside_result["result"]["files"], [str(outside.resolve())])
        allowed = client.call(21, "DOM.setFileInputFiles", {"nodeId": 1, "files": [str(workspace / "upload.txt")]},
                              session=session)
        self.assertEqual(allowed["result"]["files"], [str((workspace / "upload.txt").resolve())])
        self.assertEqual(client.call(22, "Browser.getVersion")["result"]["protocolVersion"], "1.3")
        # 中文注释：扩展推来的事件只投递给同一标签页的已附加会话。
        self.daemon._dispatch_extension("inst-a", "extension.cdp_events", {"events": [
            {"taskId": "task-a", "generation": 2, "tabId": 7, "childSessionId": None,
             "method": "Page.loadEventFired", "params": {"timestamp": 1}},
            {"taskId": "task-a", "generation": 2, "tabId": 99, "method": "Page.loadEventFired", "params": {}}],
            "dropped": 0})
        event = client.recv()
        while event.get("method") != "Page.loadEventFired":
            event = client.recv()
        self.assertEqual(event["sessionId"], session)
        # 中文注释：撤销任务后连接立即关闭，旧 URL 不能再连。
        with self.daemon.state_lock:
            self.daemon._revoke_task_locked(self.task, 'cancelled')
        with self.assertRaises((EOFError, OSError, json.JSONDecodeError)):
            for _ in range(5):
                client.recv()
        client.close()
        again = WsClient(url)
        self.assertEqual(again.status, "404")
        again.close()

    def test_failed_send_closes_socket_without_reentering_send_lock(self):
        # 中文注释：对端关闭后发送失败，不能持有发送锁再次进入 close。
        sender, peer = socket.socketpair()
        peer.close()
        connection = sys.modules['cdp_gateway']._Connection(self.daemon.cdp_gateway, sender, {})
        worker = threading.Thread(target=connection.send_json, args=({'id': 1},), daemon=True)
        worker.start()
        worker.join(timeout=1)
        try:
            self.assertFalse(worker.is_alive(), '发送失败后关闭连接发生死锁')
            self.assertEqual(sender.fileno(), -1)
        finally:
            if worker.is_alive():
                # 中文注释：只为失败测试释放自锁，避免测试自身留下线程。
                connection.send_lock.release()
                worker.join(timeout=1)
            connection.pool.shutdown(wait=False, cancel_futures=True)
            sender.close()

    def test_revocation_does_not_wait_for_a_blocked_outgoing_writer(self):
        # 中文注释：模拟慢客户端导致发送方占用发送锁；撤权必须直接断开套接字。
        sender, peer = socket.socketpair()
        self.addCleanup(peer.close)
        connection = sys.modules['cdp_gateway']._Connection(self.daemon.cdp_gateway, sender, {})
        connection.send_lock.acquire()
        worker = threading.Thread(target=connection.close, daemon=True)
        worker.start()
        worker.join(timeout=0.5)
        try:
            self.assertFalse(worker.is_alive(), '撤权被慢客户端的发送锁阻塞')
            self.assertEqual(sender.fileno(), -1)
        finally:
            connection.send_lock.release()
            worker.join(timeout=1)
            connection.pool.shutdown(wait=False, cancel_futures=True)
            sender.close()

    def test_closed_connections_do_not_exhaust_live_connection_quota(self):
        # 中文注释：每次连接通过 daemon 网关查询目标，再正常断开；第三次仍应允许连接。
        opened = self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        token = opened['wsUrl'].rsplit('/', 1)[-1]
        for index in range(3):
            client = WsClient(opened['wsUrl'])
            try:
                self.assertEqual(client.status, '101', index)
                self.assertIn('result', client.call(1, 'Target.getTargets'))
            finally:
                client.close()
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                rows = self.daemon.cdp_gateway._connections.get(token, [])
                if all(row.closed.is_set() for row in rows):
                    break
                time.sleep(0.01)
        self.assertFalse(self.daemon.cdp_gateway._connections.get(token))

    def test_detaching_one_session_preserves_other_connection_subscription(self):
        # 中文注释：两条真实网关连接共用同页事件源，只有最后一个订阅离开才允许停推。
        opened = self.daemon._dispatch_client('shared.cdp_gateway', {'owner': 'owner-a', 'taskId': 'task-a'})
        clients = [WsClient(opened['wsUrl']) for _ in range(2)]
        for client in clients:
            self.addCleanup(client.close)
        sessions = [client.call(1, 'Target.attachToTarget', {'targetId': 'T7', 'flatten': True})['result']['sessionId'] for client in clients]
        clients[0].call(2, 'Target.detachFromTarget', {'sessionId': sessions[0]})
        stopped = lambda: [p for method, p in self.calls if method == 'browser.cdp_subscribe' and p['subscribe'] is False]
        self.assertEqual(stopped(), [])
        clients[1].call(2, 'Target.detachFromTarget', {'sessionId': sessions[1]})
        self.assertEqual(len(stopped()), 1)


if __name__ == "__main__":
    unittest.main()
