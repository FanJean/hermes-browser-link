"""凭据私有端口的合成任务、代次、互斥与单次填写验证。"""

import json
import hashlib
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
sys.path.insert(0, str(ROOT / "executor-plugin"))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
from vault_client import call  # noqa: E402
from vault_private import VaultPrivateService  # noqa: E402
from vault_adapter.adapter import VaultAdapter  # noqa: E402
from vault_adapter.integration import NativeVaultPrivatePort  # noqa: E402
from tests.support import temporary_bridge_home  # noqa: E402


class FakeDaemon:
    def __init__(self, home):
        self.data_dir = home / "plugin-data" / "browser-link-native"
        self.data_dir.mkdir(parents=True)
        self.stop_event = threading.Event()
        self.state_lock = threading.RLock()
        self.task_locks = {"task": threading.RLock()}
        self.tasks = {"task": {
            "id": "task", "owner": "owner", "instanceId": "browser", "generation": 3,
            "modeGeneration": 2, "allowedOrigins": ["https://example.test"], "state": "ready",
            "activeMode": "full", "agentTabIds": [7], "scriptedTabs": [],
        }}
        self.tab_leases = {("browser", 7): "task"}
        self.extensions = {"browser": {"instanceId": "browser"}}
        self.calls = []


    def _persist_tasks(self):
        pass

    def _extension_call(self, extension, method, params, timeout=15):
        self.calls.append((method, params))
        if method == "browser.vault_inspect":
            return {"origin": "https://example.test", "documentGeneration": 4,
                    "controls": [{"index": 0, "type": "password", "name": "password", "label": "Password",
                                  "autocomplete": "current-password", "maxLength": None, "formIndex": 0}]}
        if method == "browser.vault_fill":
            return {"filled": len(params["fills"])}
        raise AssertionError("unexpected extension method")


class VaultPrivateTests(unittest.TestCase):
    def setUp(self):
        self.home = self.enterContext(temporary_bridge_home())
        self.daemon = FakeDaemon(self.home)
        self.service = VaultPrivateService(self.daemon)
        self.service.start()
        self.addCleanup(self.service.close)
        self.scope = {"sessionId": "session", "owner": "owner", "taskId": "task",
                      "instanceId": "browser", "generation": 3, "modeGeneration": 2,
                      "tabId": 7, "allowedOrigins": ["https://example.test"]}

    def test_fixture_uses_owned_tmpdir_and_bindable_private_socket(self):
        self.assertEqual(self.home.parent, Path(tempfile.gettempdir()).resolve())
        self.assertLessEqual(len(str(self.service.socket_path).encode()), 103)
        self.assertTrue(self.service.socket_path.is_socket())

    def test_secret_uses_private_socket_and_nonce_is_single_use(self):
        # 中文注释：普通 RPC 不提供 Vault 方法；私有填写只回传数量并一次性消耗检查 nonce。
        with self.assertRaises(ProtocolError) as ordinary:
            # 中文注释：先提供可信 owner 通过活动钩子，才能验证普通端口未注册 Vault 方法。
            BridgeDaemon._dispatch_client(BridgeDaemon(self.home), "shared.vault_fill", {"owner": "owner"})
        self.assertEqual(ordinary.exception.code, "unknown_method")
        inspected = call(self.home, "inspect", {"scope": self.scope})
        self.assertEqual(inspected["origin"], "https://example.test")
        fill = {"scope": self.scope, "nonce": inspected["nonce"], "documentGeneration": 4,
                "expectedOrigin": "https://example.test", "kind": "login",
                "fills": [{"index": 0, "token": "current-password", "value": "SyntheticSecret!"}]}
        receipt = call(self.home, "fill", fill)
        self.assertEqual(receipt, {"filled": 1})
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.tasks))
        self.assertNotIn("SyntheticSecret!", json.dumps(receipt))
        self.assertEqual(self.daemon.tasks["task"]["credentialTabs"], [7])
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.calls))
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "fill", {**fill, "fills": [{"index": 0, "token": "current-password", "value": "AnotherSecret"}]})
        self.assertEqual(len([method for method, _ in self.daemon.calls if method == "browser.vault_fill"]), 1)

    def test_generation_and_script_conflicts_fail_before_inspection(self):
        # 中文注释：代次错误和已执行脚本的页面都不能把凭据元信息交给错误任务页。
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "inspect", {"scope": {**self.scope, "modeGeneration": 1}})
        self.daemon.tasks["task"]["scriptedTabs"] = [7]
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "inspect", {"scope": self.scope})
        self.assertEqual(self.daemon.calls, [])

    def test_smart_fill_requires_one_time_approval(self):
        # 中文注释：智能审批未获批准时秘密不会派发；同一批准只能填写一次。
        self.daemon.tasks['task']['activeMode'] = 'smart'
        inspected = call(self.home, 'inspect', {'scope': self.scope})
        approval = {'requestId': 'vault-smart-1', 'handleDigest': 'a' * 64, 'vaultAction': 'fill'}
        fill = {'scope': self.scope, 'nonce': inspected['nonce'], 'documentGeneration': 4,
                'expectedOrigin': 'https://example.test', 'kind': 'login', 'approval': approval,
                'fills': [{'index': 0, 'token': 'current-password', 'value': 'SyntheticSecret!'}]}
        with self.assertRaisesRegex(RuntimeError, 'denied'):
            call(self.home, 'fill', fill)
        self.assertEqual(len([method for method, _ in self.daemon.calls if method == 'browser.vault_fill']), 0)
        inspected = call(self.home, 'inspect', {'scope': self.scope})
        fill['nonce'] = inspected['nonce']
        self.daemon.tasks['task']['vaultPermit'] = {
            'requestIdHash': hashlib.sha256(approval['requestId'].encode()).hexdigest(),
            'handleDigest': approval['handleDigest'], 'vaultAction': 'fill', 'tabId': 7,
            'modeGeneration': 2, 'expiresAt': time.time() + 120}
        self.assertEqual(call(self.home, 'fill', fill), {'filled': 1})
        self.assertNotIn('vaultPermit', self.daemon.tasks['task'])

    def adapter(self):
        # 中文注释：统一复用官方适配层、私有客户端及真实 socket 的跨模块夹具。
        scope = self.scope
        home = self.home

        class Profile:
            authority = type("Authority", (), {"owner_for_session": lambda self, session: "owner"})()

            def call(self, method, params):
                if method == "shared.get":
                    return {**daemon.tasks["task"], "tabIds": [7],
                            "workTabs": [{"tabId": 7, "groupId": 1, "windowId": 2}]}
                if method == "browser.list":
                    return [{"instanceId": "browser", "connected": True}]
                raise AssertionError("secret entered ordinary RPC")

            def vault_private_call(self, operation, params):
                return call(home, operation, params)

        class Host:
            def resolve_vault_binding(self, session):
                if session != "session":
                    return None
                return {"owner": scope["owner"], "task_id": scope["taskId"],
                        "instance_id": scope["instanceId"], "generation": scope["generation"],
                        "mode_generation": scope["modeGeneration"], "tab_id": scope["tabId"]}

        class Source:
            def get_meta(self, handle):
                return {"kind": "login", "origin": "https://example.test"} if handle == "login" else None

            def resolve(self, handle, kind):
                return {"password": "SyntheticSecret!"}

            def register_secret(self, value):
                pass

        daemon = self.daemon
        profile = Profile()
        return VaultAdapter(profile, Host(), Source(), NativeVaultPrivatePort(profile))

    def test_adapter_crosses_real_private_socket_without_public_secret(self):
        adapter = self.adapter()
        result = json.loads(adapter.invoke("browser_vault_fill", {"handle": "login"}, session_id="session"))
        self.assertEqual(result["success"], True)
        self.assertEqual(result["filled_fields"], 1)
        self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.tasks))
        self.assertEqual([name for name, _ in self.daemon.calls], ["browser.vault_inspect", "browser.vault_fill"])
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.calls))

    def test_write_transport_failure_is_unknown_scrubbed_and_never_replayed(self):
        # 中文注释：扩展已收到秘密但回执超时或断线时，公开工具只返回未知，私有 nonce 已消耗。
        original = self.daemon._extension_call
        for failure in (TimeoutError, ConnectionError):
            with self.subTest(failure=failure.__name__):
                self.daemon.calls.clear()

                def extension_call(extension, method, params, timeout=15):
                    result = original(extension, method, params, timeout)
                    if method == 'browser.vault_fill':
                        raise failure('SyntheticSecret!')
                    return result

                self.daemon._extension_call = extension_call
                result = json.loads(self.adapter().invoke('browser_vault_fill', {'handle': 'login'}, session_id='session'))
                self.assertEqual(result, {'success': False, 'error_type': 'outcome_unknown'})
                self.assertEqual([method for method, _ in self.daemon.calls], ['browser.vault_inspect', 'browser.vault_fill'])
                self.assertEqual(self.daemon.tasks['task']['credentialTabs'], [7])
                self.assertEqual(self.service._nonces, {})
                self.assertNotIn('SyntheticSecret!', json.dumps([result, self.daemon.tasks, self.daemon.calls]))

    def test_revocation_and_nonce_session_expiry_or_restart_reject_before_fill(self):
        # 中文注释：检查和填写之间的撤权、会话变化、过期以及私有服务重启均不能复用旧检查。
        for change in ('revoked', 'session', 'expired', 'restart'):
            with self.subTest(change=change):
                self.daemon.tasks['task']['state'] = 'ready'
                inspected = call(self.home, 'inspect', {'scope': self.scope})
                scope = dict(self.scope)
                if change == 'revoked':
                    self.daemon.tasks['task']['state'] = 'cancelled'
                elif change == 'session':
                    scope['sessionId'] = 'another-session'
                elif change == 'expired':
                    self.service._nonces[('session', 'task', 7)]['expiresAt'] = 0
                else:
                    self.service.close()
                    self.service = VaultPrivateService(self.daemon)
                    self.service.start()
                    self.addCleanup(self.service.close)
                with self.assertRaisesRegex(RuntimeError, 'denied'):
                    call(self.home, 'fill', {'scope': scope, 'nonce': inspected['nonce'], 'documentGeneration': 4,
                         'expectedOrigin': 'https://example.test', 'kind': 'login',
                         'fills': [{'index': 0, 'token': 'current-password', 'value': 'SyntheticSecret!'}]})
                self.assertEqual([method for method, _ in self.daemon.calls if method == 'browser.vault_fill'], [])


if __name__ == "__main__":
    unittest.main()
