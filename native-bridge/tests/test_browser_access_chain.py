"""Production daemon/client access request roundtrip with a synthetic extension."""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))
sys.path.insert(0, str(BRIDGE_DIR / "tests"))
from client import BridgeClient, ensure_service  # noqa: E402
from support import ExtensionPeer, stop_fixture_daemon  # noqa: E402


class BrowserAccessChainTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes" / "cache" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="ba-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "h"
        ensure_service(self.home)
        self.addCleanup(self.stop_service)
        self.client = BridgeClient(self.home, timeout=5)
        self.addCleanup(self.client.close)
        self.peer = ExtensionPeer(
            self.home,
            instance_id="target-browser",
            capabilities={"consentStatus": True, "accessRequest": True},
        )
        self.addCleanup(self.peer.close)

    def stop_service(self):
        stop_fixture_daemon(self.home)

    def test_fresh_status_and_single_flight_ui_request_cross_real_socket_daemon(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            listed = pool.submit(self.client.call, "browser.list", {})
            status_request = self.peer.receive_request("extension.consent_status")
            self.assertEqual(status_request["params"], {})
            self.peer.respond(status_request, {"consentStatus": "enabled"})
            rows = listed.result(timeout=5)

        self.assertEqual(rows, [{
            "instanceId": "target-browser",
            "browser": "chrome",
            "version": "0.1.0",
            # 中文注释：未声明能力时返回空能力列表，不推断浏览器支持情况。
            "features": [],
            "connected": True,
            "consentStatus": "enabled",
            "primary": False,
            "accessRequestSupported": True,
        }])

        with ThreadPoolExecutor(max_workers=1) as pool:
            requested = pool.submit(self.client.call, "browser.access_request", {"instanceId": "target-browser"})
            message = self.peer.receive_request("extension.access_request")
            params = message["params"]
            self.assertEqual(params["instanceId"], "target-browser")
            self.assertEqual(params["connectionGeneration"], self.peer.connection_generation)
            self.assertTrue(params["requestId"])
            self.peer.respond(message, {
                "requestId": params["requestId"],
                "instanceId": params["instanceId"],
                "connectionGeneration": params["connectionGeneration"],
                "status": "opened",
            })
            first = requested.result(timeout=5)

        self.assertEqual(first["status"], "confirmation_requested")
        self.assertNotIn("enabled", first)
        duplicate = self.client.call("browser.access_request", {"instanceId": "target-browser"})
        self.assertEqual(duplicate, {"requestId": first["requestId"], "status": "already_requested"})

        with ThreadPoolExecutor(max_workers=1) as pool:
            refreshed = pool.submit(self.client.call, "browser.list", {})
            status_request = self.peer.receive_request("extension.consent_status")
            self.peer.respond(status_request, {"consentStatus": "disabled"})
            rows = refreshed.result(timeout=5)
        self.assertEqual(rows[0]["consentStatus"], "disabled")


if __name__ == "__main__":
    unittest.main()
