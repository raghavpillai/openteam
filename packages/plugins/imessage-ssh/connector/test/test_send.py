import base64
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_protocol2 import build_messages
import gateway
import reader


class SendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.database = self.home / "chat.db"
        build_messages(self.database)
        self.args = {"chatGuid": "any;-;+15550001111", "text": 'hello " $() `literal`\nworld',
                     "requestId": "11111111-2222-4333-8444-555555555555"}
        self.permission = patch.object(reader, "check_automation", return_value={"automation": "granted"})
        self.permission.start()
        self.addCleanup(self.permission.stop)

    def tearDown(self):
        self.temp.cleanup()

    def call(self, operation="send", args=None, enabled=True):
        return reader.execute({"operation": operation, "arguments": self.args if args is None else args},
                              self.database, self.home, enabled)

    def test_disabled_gate_cannot_be_enabled_remotely(self):
        with patch.object(reader, "native_messages") as native:
            self.assertEqual(self.call(enabled=False)["error"], "sending_disabled")
            self.assertEqual(self.call("send_status", {}, False)["automation"], "not_checked")
            with self.assertRaises(ValueError):
                self.call(args={**self.args, "allow_send": True})
            native.assert_not_called()
        self.assertFalse((self.home / ".local").exists())

    def test_existing_chat_required_before_native_call(self):
        with patch.object(reader, "native_messages") as native:
            result = self.call(args={**self.args, "chatGuid": "any;-;missing"})
            self.assertEqual(result["error"], "unknown_chat")
            native.assert_not_called()

    def test_send_is_argv_only_and_replay_does_not_send_again(self):
        before = self.database.read_bytes()
        with patch.object(reader.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "submitted\n", "")) as run:
            first, second = self.call(), self.call()
            self.assertEqual(first["status"], "submitted")
            self.assertFalse(first["deliveryConfirmed"])
            self.assertTrue(second["replayed"])
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertEqual(command[-3:], ["send", self.args["chatGuid"], self.args["text"]])
            self.assertNotIn(self.args["text"], command[2])
            self.assertEqual(self.call(args={**self.args, "text": "changed"})["error"], "request_id_conflict")
        self.assertEqual(before, self.database.read_bytes())
        ledger = self.home / ".local/share/openteam-imessage/send-receipts.sqlite3"
        self.assertEqual(ledger.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.args["text"].encode(), ledger.read_bytes())

    def test_timeout_is_durable_and_never_replayed(self):
        with patch.object(reader.subprocess, "run", side_effect=subprocess.TimeoutExpired("osascript", 18)) as run:
            first, second = self.call(), self.call()
            self.assertEqual(first["status"], "unknown")
            self.assertEqual(first["cause"], "automation_timeout")
            self.assertEqual(second["error"], "send_outcome_unknown")
            self.assertTrue(second["replayed"])
            run.assert_called_once()

    def test_concurrent_duplicate_is_reserved_before_native_send(self):
        entered, release = threading.Event(), threading.Event()
        def native(*_):
            entered.set()
            release.wait(5)
            return {"status": "submitted"}
        with patch.object(reader, "native_messages", side_effect=native) as send:
            result = []
            thread = threading.Thread(target=lambda: result.append(self.call()))
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                duplicate = self.call()
                self.assertEqual(duplicate["error"], "send_outcome_unknown")
                self.assertTrue(duplicate["replayed"])
            finally:
                release.set()
                thread.join(5)
            send.assert_called_once()
            self.assertEqual(result[0]["status"], "submitted")

    def test_status_requires_native_success_and_never_sends(self):
        for code, expected in [(-1743, "denied"), (-1712, "unknown"), (-1728, "granted")]:
            with patch.object(reader.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "private text (%s)" % code)) as run:
                status = self.call("send_status", {"chatGuid": self.args["chatGuid"]})
                self.assertEqual(status["automation"], expected)
                self.assertNotIn("private text", json.dumps(status))
                self.assertEqual(run.call_args.args[0][-3], "status")
                self.assertEqual(status["transport"], "ssh")
        self.assertFalse((self.home / ".local").exists())

    def test_business_guid_passed_unchanged_and_native_ambiguity_fails(self):
        guid = "any;-;urn:biz:b15ed773-9eed-11e7-baa2-7b88b04daa8e"
        db = sqlite3.connect(self.database)
        db.execute("UPDATE chat SET guid=?, service_name='SMS' WHERE ROWID=1", (guid,))
        db.commit()
        db.close()
        with patch.object(reader.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "Chat unavailable or ambiguous (-1728)")) as run:
            result = self.call(args={**self.args, "chatGuid": guid})
            self.assertEqual(result["cause"], "chat_not_scriptable")
            self.assertEqual(run.call_args.args[0][-2], guid)
            self.assertEqual(run.call_count, 1)

    def test_invalid_payloads_rejected(self):
        for changes in [{"text": "\x00"}, {"text": "x" * 4001}, {"requestId": "not-a-uuid"},
                        {"chatGuid": "any;-;bad\nchat"}, {"chatGuid": "phone-number"}]:
            with self.assertRaises(ValueError):
                self.call(args={**self.args, **changes})

    def test_ungranted_permission_never_starts_short_lived_applescript(self):
        for operation, args in [("send", self.args), ("send_status", {})]:
            with patch.object(reader, "check_automation", return_value={"error": "automation_consent_required", "automation": "not_granted"}), \
                    patch.object(reader, "native_messages") as native:
                self.assertEqual(self.call(operation, args)["error"], "automation_consent_required")
                native.assert_not_called()
        with sqlite3.connect(self.home / ".local/share/openteam-imessage/send-receipts.sqlite3") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM receipts").fetchone()[0], 0)

    def test_preflight_never_requests_consent_and_distinguishes_failures(self):
        self.permission.stop()
        for code, expected in [(0, "granted"), (-1743, "denied"), (-1744, "not_granted"), (-600, "unknown")]:
            with patch.object(reader.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, str(code), "")) as run:
                self.assertEqual(reader.check_automation()["automation"], expected)
                self.assertEqual(run.call_args.args[0][-1], "--automation-preflight")
        with patch.object(reader.subprocess, "run", side_effect=subprocess.TimeoutExpired("probe", 5)):
            self.assertEqual(reader.check_automation()["error"], "automation_preflight_timeout")

    def test_public_permission_api_is_non_prompting(self):
        with patch("ctypes.CDLL") as library:
            api = library.return_value
            api.AECreateDesc.return_value = 0
            api.AEDeterminePermissionToAutomateTarget.return_value = -1744
            self.assertEqual(reader.automation_permission(), -1744)
            self.assertIs(api.AEDeterminePermissionToAutomateTarget.call_args.args[-1], False)
            api.AEDisposeDesc.assert_called_once()

    def test_explicit_setup_leaves_time_for_consent_without_sending(self):
        with patch.object(reader.sys, "argv", ["reader.py", "--allow-send", "--authorize-messages"]), \
                patch.object(reader.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ready", "")) as run, \
                patch("builtins.print"):
            self.assertEqual(reader.main(), 0)
            self.assertEqual(run.call_args.kwargs["timeout"], 150)
            self.assertIn("with timeout of 120 seconds", run.call_args.args[0][2])
            self.assertEqual(run.call_args.args[0][-3:], ["status", "", ""])

    def test_default_gateway_omits_send_and_rejects_direct_call(self):
        for name in ("key", "hosts", "token"):
            p = self.home / name
            p.write_text("x" * 40)
            p.chmod(0o600)
        config = {"ssh_target": "user@mac", "identity_file": str(self.home / "key"),
                  "known_hosts_file": str(self.home / "hosts"), "token_file": str(self.home / "token")}
        default = gateway.Gateway(config)
        self.assertEqual(default.listed_tools(), gateway.TOOLS)
        self.assertEqual(default.execute("send", self.args)["error"], "sending_disabled")
        enabled = gateway.Gateway({**config, "allow_send": True})
        listed = {t["name"]: t for t in enabled.listed_tools()}
        self.assertFalse(listed["SendIMessageSSH"]["annotations"]["readOnlyHint"])
        self.assertTrue(listed["IMessageSendStatus"]["annotations"]["readOnlyHint"])
        with patch.object(gateway.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 25)):
            self.assertEqual(enabled.execute("send", self.args)["error"], "send_outcome_unknown")

    def test_installer_requires_new_key_for_sending(self):
        spec = importlib.util.spec_from_file_location("installer", Path(reader.__file__).with_name("install-reader.py"))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        def key(byte):
            return "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + byte * 32).decode()
        installer.install(key(b"x"), self.home)
        authorized = self.home / ".ssh/authorized_keys"
        before = authorized.read_text()
        with self.assertRaises(ValueError):
            installer.install(key(b"x"), self.home, allow_send=True)
        self.assertEqual(before, authorized.read_text())
        installer.install(key(b"y"), self.home, allow_send=True)
        self.assertTrue(authorized.read_text().startswith(before))
        self.assertEqual(authorized.read_text().count(" --allow-send"), 1)


if __name__ == "__main__":
    unittest.main()
