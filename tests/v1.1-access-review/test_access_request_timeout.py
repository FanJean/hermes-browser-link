"""Independent authorization-request regressions; no browser or profile startup."""
from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parents[2]
BRIDGE_DIR = ROOT / "native-bridge"
sys.path.insert(0, str(BRIDGE_DIR))
_daemon = importlib.import_module("daemon")
BridgeDaemon = _daemon.BridgeDaemon
ProtocolError = _daemon.ProtocolError


class AccessRequestTimeoutReviewTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes" / "cache" / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="access-review-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.sent = []
        self.extension = {
            "instanceId": "browser-review",
            "browser": "chrome",
            "version": "review-fixture",
            "consentStatusSupported": True,
            "accessRequestSupported": True,
            "connectionGeneration": "generation-review",
            "lastConsentStatus": "disabled",
            "pending": {},
            "pendingLock": Lock(),
            "sendLock": Lock(),
            "socket": object(),
        }
        self.daemon.extensions[self.extension["instanceId"]] = self.extension
        self.daemon._send_extension = lambda _extension, value: self.sent.append(value)

    def test_late_open_ack_after_timeout_is_ignored_and_request_is_not_replayed(self):
        real_call = self.daemon._extension_call

        def short_deadline(extension, method, params, timeout=15.0):
            return real_call(extension, method, params, timeout=0.01)

        self.daemon._extension_call = short_deadline
        first = self.daemon._dispatch_client(
            "browser.access_request", {"instanceId": self.extension["instanceId"]}
        )

        self.assertEqual(first["status"], "unknown")
        self.assertEqual(len(self.sent), 1)
        request = self.sent[0]
        self.assertEqual(request["method"], "extension.access_request")
        self.assertEqual(request["params"]["instanceId"], self.extension["instanceId"])
        self.assertEqual(request["params"]["connectionGeneration"], "generation-review")

        late_reply = {
            "id": request["id"],
            "result": {
                "requestId": request["params"]["requestId"],
                "instanceId": request["params"]["instanceId"],
                "connectionGeneration": request["params"]["connectionGeneration"],
                "status": "opened",
            },
        }
        self.assertTrue(self.daemon._accept_extension_response(self.extension, late_reply))
        self.assertEqual(self.extension["accessRequest"]["status"], "unknown")

        repeated = self.daemon._dispatch_client(
            "browser.access_request", {"instanceId": self.extension["instanceId"]}
        )
        self.assertEqual(repeated, {"requestId": first["requestId"], "status": "unknown"})
        self.assertEqual(len(self.sent), 1, "unknown request must not reopen or replay")

    def test_consent_read_rpc_failure_is_unknown_even_after_a_prior_enabled_read(self):
        self.extension["lastConsentStatus"] = "enabled"

        def failed_read(_extension, method, _params, **_kwargs):
            self.assertEqual(method, "extension.consent_status")
            raise ProtocolError("extension_timeout", "synthetic read timeout")

        self.daemon._extension_call = failed_read
        rows = self.daemon._dispatch_client("browser.list", {})

        self.assertEqual(rows[0]["consentStatus"], "unknown")
        self.assertTrue(rows[0]["connected"])
        self.assertEqual(rows[0]["accessRequestSupported"], True)


if __name__ == "__main__":
    unittest.main()
