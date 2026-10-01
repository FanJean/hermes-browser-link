"""Focused consent-status and access-request protocol tests."""
import tempfile
import time
import unittest
from pathlib import Path
from threading import Lock

from daemon import BridgeDaemon, ProtocolError


class BrowserAccessRequestTests(unittest.TestCase):
    def setUp(self):
        scratch = Path.home() / ".hermes/cache/scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.extension = {
            "instanceId": "browser-a",
            "browser": "chrome",
            "version": "2.0",
            "consentStatusSupported": True,
            "accessRequestSupported": True,
            "connectionGeneration": "connection-a",
            "pending": {},
            "pendingLock": Lock(),
            "sendLock": Lock(),
            "socket": object(),
        }
        self.daemon.extensions["browser-a"] = self.extension

    def test_browser_list_reads_fresh_status_and_reports_supported_extension(self):
        values = iter([{"consentStatus": "disabled"}, {"consentStatus": "enabled"}])
        calls = []

        def extension_call(extension, method, params, **_):
            calls.append((extension, method, params))
            return next(values)

        self.daemon._extension_call = extension_call
        first = self.daemon._dispatch_client("browser.list", {})
        second = self.daemon._dispatch_client("browser.list", {})

        self.assertEqual(first[0]["consentStatus"], "disabled")
        self.assertEqual(second[0]["consentStatus"], "enabled")
        self.assertTrue(first[0]["accessRequestSupported"])
        self.assertEqual([call[1] for call in calls], ["extension.consent_status"] * 2)

    def test_missing_or_invalid_fresh_status_is_unknown_not_disabled(self):
        self.extension["consentStatusSupported"] = False
        self.extension["accessRequestSupported"] = False
        self.daemon._extension_call = lambda *_args, **_kwargs: self.fail("legacy extension must not receive RPC")
        rows = self.daemon._dispatch_client("browser.list", {})
        self.assertEqual(rows[0]["consentStatus"], "unknown")
        self.assertFalse(rows[0]["accessRequestSupported"])

        self.extension["consentStatusSupported"] = True
        for invalid in ({}, {"consentStatus": False}, {"consentStatus": "unknown"}):
            self.daemon._extension_call = lambda *_args, result=invalid, **_kwargs: result
            rows = self.daemon._dispatch_client("browser.list", {})
            self.assertEqual(rows[0]["consentStatus"], "unknown")

    def test_access_request_is_single_flight_and_never_claims_consent_changed(self):
        # An enabled browser still needs the management UI for explicit revocation.
        self.extension["lastConsentStatus"] = "enabled"
        sent = []

        def extension_call(extension, method, params, **_):
            sent.append((extension, method, params))
            return {
                "requestId": params["requestId"],
                "instanceId": "browser-a",
                "connectionGeneration": "connection-a",
                "status": "opened",
            }

        self.daemon._extension_call = extension_call
        params = {"instanceId": "browser-a"}
        first = self.daemon._dispatch_client("browser.access_request", params)
        second = self.daemon._dispatch_client("browser.access_request", params)

        self.assertEqual(first["requestId"], second["requestId"])
        self.assertEqual(first["status"], "confirmation_requested")
        self.assertEqual(second["status"], "already_requested")
        self.assertNotIn("enabled", first)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1], "extension.access_request")
        self.assertEqual(self.daemon.extensions["browser-a"], self.extension)

    def test_changed_consent_readback_retires_the_old_prompt(self):
        self.extension["lastConsentStatus"] = "disabled"
        self.extension["accessRequest"] = {
            "requestId": "old-request",
            "status": "confirmation_requested",
            "initialConsentStatus": "disabled",
            "expiresAt": time.monotonic() + 60,
        }
        self.daemon._extension_call = lambda *_args, **_kwargs: {"consentStatus": "enabled"}

        rows = self.daemon._dispatch_client("browser.list", {})

        self.assertEqual(rows[0]["consentStatus"], "enabled")
        self.assertIsNone(self.extension["accessRequest"])

    def _opening_call(self, opened):
        def extension_call(_extension, method, params, **_):
            opened.append(method)
            return {
                "requestId": params["requestId"],
                "instanceId": "browser-a",
                "connectionGeneration": "connection-a",
                "status": "opened",
            }
        return extension_call

    def test_explicit_request_after_expiry_opens_a_fresh_prompt_in_the_same_call(self):
        for stale_status in ("confirmation_requested", "unknown"):
            with self.subTest(stale_status=stale_status):
                self.extension["accessRequest"] = {
                    "requestId": "expired-request",
                    "status": stale_status,
                    "initialConsentStatus": "disabled",
                    "expiresAt": time.monotonic() - 1,
                }
                opened = []
                self.daemon._extension_call = self._opening_call(opened)
                result = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
                self.assertEqual(result["status"], "confirmation_requested")
                self.assertNotEqual(result["requestId"], "expired-request")
                self.assertEqual(opened, ["extension.access_request"])
                self.extension["accessRequest"] = None

    def test_unexpired_unknown_prompt_is_not_replayed_by_an_explicit_request(self):
        self.extension["accessRequest"] = {
            "requestId": "uncertain",
            "status": "unknown",
            "initialConsentStatus": "disabled",
            "expiresAt": time.monotonic() + 60,
        }
        self.daemon._extension_call = lambda *_a, **_k: self.fail("unknown prompt must not be replayed")
        result = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(result, {"requestId": "uncertain", "status": "unknown"})

    def test_closed_prompt_lets_the_user_request_again_without_waiting_for_expiry(self):
        opened = []
        self.daemon._extension_call = self._opening_call(opened)
        first = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(first["status"], "confirmation_requested")

        closed = self.daemon._dispatch_extension("browser-a", "extension.access_request_closed", {
            "requestId": first["requestId"], "connectionGeneration": "connection-a"})
        self.assertEqual(closed, {"closed": True})
        self.assertIsNone(self.extension["accessRequest"])

        second = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(second["status"], "confirmation_requested")
        self.assertNotEqual(second["requestId"], first["requestId"])
        self.assertEqual(opened, ["extension.access_request"] * 2)

    def test_close_report_that_is_stale_or_foreign_does_not_retire_the_live_prompt(self):
        self.daemon._extension_call = self._opening_call([])
        live = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        for params in (
            {"requestId": "other-request", "connectionGeneration": "connection-a"},
            {"requestId": live["requestId"], "connectionGeneration": "connection-old"},
        ):
            self.assertEqual(
                self.daemon._dispatch_extension("browser-a", "extension.access_request_closed", params),
                {"closed": False})
        self.assertEqual(
            self.daemon._dispatch_extension("browser-b", "extension.access_request_closed",
                                            {"requestId": live["requestId"], "connectionGeneration": "connection-a"}),
            {"closed": False})
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension("browser-a", "extension.access_request_closed",
                                            {"requestId": live["requestId"], "connectionGeneration": "connection-a",
                                             "consentStatus": "enabled"})
        self.assertEqual(self.extension["accessRequest"]["requestId"], live["requestId"])
        again = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(again, {"requestId": live["requestId"], "status": "already_requested"})

    def test_close_reported_while_opening_retires_the_prompt_once_acknowledged(self):
        def extension_call(_extension, _method, params, **_):
            self.daemon._dispatch_extension("browser-a", "extension.access_request_closed", {
                "requestId": params["requestId"], "connectionGeneration": "connection-a"})
            return {"requestId": params["requestId"], "instanceId": "browser-a",
                    "connectionGeneration": "connection-a", "status": "opened"}

        self.daemon._extension_call = extension_call
        result = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(result["status"], "confirmation_requested")
        self.assertIsNone(self.extension["accessRequest"])

    def test_close_report_carries_no_consent_and_list_readback_stays_authoritative(self):
        self.daemon._extension_call = self._opening_call([])
        live = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.daemon._dispatch_extension("browser-a", "extension.access_request_closed", {
            "requestId": live["requestId"], "connectionGeneration": "connection-a"})
        self.daemon._extension_call = lambda *_a, **_k: {"consentStatus": "disabled"}
        rows = self.daemon._dispatch_client("browser.list", {})
        self.assertEqual(rows[0]["consentStatus"], "disabled")

    def test_reconnected_instance_starts_without_the_old_prompt(self):
        self.daemon._extension_call = self._opening_call([])
        old = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        replacement = dict(self.extension, connectionGeneration="connection-b", accessRequest=None)
        self.daemon.extensions["browser-a"] = replacement
        # A late close from the old connection cannot touch the new one.
        self.assertEqual(
            self.daemon._dispatch_extension("browser-a", "extension.access_request_closed", {
                "requestId": old["requestId"], "connectionGeneration": "connection-a"}),
            {"closed": False})

        def new_generation_call(_extension, _method, params, **_):
            return {"requestId": params["requestId"], "instanceId": "browser-a",
                    "connectionGeneration": "connection-b", "status": "opened"}

        self.daemon._extension_call = new_generation_call
        fresh = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(fresh["status"], "confirmation_requested")
        self.assertNotEqual(fresh["requestId"], old["requestId"])

    def test_revoke_then_enable_again_each_retire_the_prompt_via_readback(self):
        opened = []
        self.daemon._extension_call = self._opening_call(opened)
        self.extension["lastConsentStatus"] = "enabled"
        manage = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.daemon._extension_call = lambda *_a, **_k: {"consentStatus": "disabled"}
        self.daemon._dispatch_client("browser.list", {})
        self.assertIsNone(self.extension["accessRequest"])

        self.daemon._extension_call = self._opening_call(opened)
        enable = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(enable["status"], "confirmation_requested")
        self.assertNotEqual(enable["requestId"], manage["requestId"])
        self.daemon._extension_call = lambda *_a, **_k: {"consentStatus": "enabled"}
        self.daemon._dispatch_client("browser.list", {})
        self.assertIsNone(self.extension["accessRequest"])
        self.assertEqual(opened, ["extension.access_request"] * 2)

    def test_access_request_requires_supported_connected_target_and_exact_params(self):
        self.daemon._extension_call = lambda *_args, **_kwargs: self.fail("must reject before extension RPC")
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client("browser.access_request", {})
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a", "enabled": True})

        self.extension["accessRequestSupported"] = False
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(caught.exception.code, "access_request_unsupported")
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._dispatch_client("browser.access_request", {"instanceId": "missing"})
        self.assertEqual(caught.exception.code, "instance_unavailable")

    def test_late_access_reply_from_replaced_connection_is_not_reported_as_opened(self):
        replacement = dict(self.extension, connectionGeneration="connection-b")

        def late_reply(_extension, _method, params, **_):
            self.daemon.extensions["browser-a"] = replacement
            return {
                "requestId": params["requestId"],
                "instanceId": "browser-a",
                "connectionGeneration": "connection-a",
                "status": "opened",
            }

        self.daemon._extension_call = late_reply
        result = self.daemon._dispatch_client("browser.access_request", {"instanceId": "browser-a"})
        self.assertEqual(result["requestId"], self.extension["accessRequest"]["requestId"])
        self.assertEqual(result["status"], "unknown")
        self.assertNotEqual(self.daemon.extensions["browser-a"]["connectionGeneration"], "connection-a")


if __name__ == "__main__":
    unittest.main()
