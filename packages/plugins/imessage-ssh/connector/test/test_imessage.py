import base64
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import reader
import gateway


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "chat.db"
        db = sqlite3.connect(self.database)
        db.executescript("""
          CREATE TABLE message (guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER,handle_id INTEGER,
            attributedBody BLOB,associated_message_type INTEGER,associated_message_guid TEXT,
            date_edited INTEGER,date_retracted INTEGER,cache_has_attachments INTEGER,item_type INTEGER);
          CREATE TABLE chat (guid TEXT,display_name TEXT,chat_identifier TEXT,service_name TEXT);
          CREATE TABLE handle (id TEXT);
          CREATE TABLE chat_handle_join (chat_id INTEGER,handle_id INTEGER);
          CREATE TABLE chat_message_join (chat_id INTEGER,message_id INTEGER);
          INSERT INTO handle VALUES ('+15550001111');
          INSERT INTO chat VALUES ('iMessage;-;one','Team','+15550001111','iMessage');
          INSERT INTO chat_handle_join VALUES (1,1);
        """)
        db.executemany("INSERT INTO message(guid,text,date,is_from_me,handle_id) VALUES (?,?,?,0,1)",
                       [(str(i), "rare target" if i == 1 else "hello " + str(i), 800000000000000000 + i) for i in range(1, 506)])
        db.executemany("INSERT INTO chat_message_join VALUES (1,?)", [(i,) for i in range(1, 506)])
        db.commit()
        db.close()

    def tearDown(self):
        self.directory.cleanup()

    def call(self, operation, **args):
        return reader.execute({"operation": operation, "arguments": args}, self.database)

    def test_history_pages_are_disjoint_and_database_unchanged(self):
        before = self.database.read_bytes()
        page = self.call("history", chat_id=1, limit=2)
        self.assertEqual([m["id"] for m in page["messages"]], [505, 504])
        next_page = self.call("history", chat_id=1, limit=2, before_id=page["next_before_id"])
        self.assertEqual([m["id"] for m in next_page["messages"]], [503, 502])
        self.assertEqual(before, self.database.read_bytes())

    def test_search_continues_after_empty_scan_page(self):
        first = self.call("search", query="rare target")
        self.assertEqual(first["messages"], [])
        self.assertEqual(first["scanned"], 500)
        self.assertFalse(first["complete"])
        last = self.call("search", query="rare target", before_id=first["next_before_id"])
        self.assertEqual(last["messages"][0]["id"], 1)
        self.assertTrue(last["complete"])

    def test_search_limit_never_skips_remaining_matches(self):
        first = self.call("search", query="hello", limit=1)
        second = self.call("search", query="hello", limit=1, before_id=first["next_before_id"])
        self.assertEqual(first["messages"][0]["id"] - 1, second["messages"][0]["id"])

    def test_parameterization_and_strict_operations(self):
        self.assertEqual(self.call("chats", query="' OR 1=1 --")["chats"], [])
        self.assertEqual(len(self.call("chats", query="1111")["chats"]), 1)
        for request in [{"operation": "sql", "arguments": {}}, {"operation": "status", "arguments": {"database": "/etc/passwd"}},
                        {"operation": "history", "arguments": {"chat_id": True}}, {"operation": "chats", "arguments": {"limit": 1000}},
                        {"operation": "search", "arguments": {"query": []}}]:
            with self.assertRaises(ValueError):
                reader.execute(request, self.database)

    def test_archives_reactions_and_retracted_text(self):
        db = sqlite3.connect(self.database)
        blob = b"\x04\x0bstreamtyped" + b"\x01+\x0barchive hit"
        db.execute("UPDATE message SET text=NULL, attributedBody=? WHERE ROWID=505", (blob,))
        db.execute("UPDATE message SET date_retracted=800000000000000000, text='secret retracted' WHERE ROWID=504")
        db.execute("UPDATE message SET associated_message_type=2001, associated_message_guid='target' WHERE ROWID=503")
        db.commit()
        db.close()
        messages = self.call("history", chat_id=1, limit=3)["messages"]
        self.assertEqual(messages[0]["text"], "archive hit")
        self.assertTrue(messages[0]["body_fallback"])
        self.assertEqual(messages[1]["kind"], "unsent")
        self.assertIsNone(messages[1]["text"])
        self.assertEqual(messages[2]["kind"], "reaction")
        self.assertEqual(self.call("search", query="archive hit")["messages"][0]["id"], 505)
        self.assertEqual(self.call("search", query="secret retracted")["messages"], [])

    def test_cli_rejects_database_path_in_request(self):
        result = subprocess.run([sys.executable, str(Path(reader.__file__)), "--database", str(self.database)],
                                input=json.dumps({"operation": "status", "arguments": {"database": "/tmp/other"}}), text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["error"], "invalid_request")


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        for name in ("key", "hosts", "token"):
            path = root / name
            path.write_text("x" * 40)
            path.chmod(0o600)
        self.config = {"ssh_target": "user@mac.example", "identity_file": str(root / "key"),
                       "known_hosts_file": str(root / "hosts"), "token_file": str(root / "token")}
        self.gateway = gateway.Gateway(self.config)
        self.server = gateway.make_server(self.gateway, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%s/mcp" % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, value, token=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if origin:
            headers["Origin"] = origin
        return urlopen(Request(self.url, data=json.dumps(value).encode(), headers=headers), timeout=5)

    def test_authentication_and_browser_origin(self):
        for token, origin, status in [(None, None, 401), ("bad", None, 401), ("x" * 40, "https://evil.example", 403)]:
            with self.assertRaises(HTTPError) as caught:
                self.request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token, origin)
            self.assertEqual(caught.exception.code, status)
            caught.exception.close()

    def test_mcp_initialization_tools_and_notification(self):
        response = self.request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}, "x" * 40)
        self.assertEqual(json.load(response)["result"]["protocolVersion"], "2025-03-26")
        response = self.request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, "x" * 40)
        self.assertEqual(len(json.load(response)["result"]["tools"]), 4)
        response = self.request({"jsonrpc": "2.0", "method": "notifications/initialized"}, "x" * 40)
        self.assertEqual(response.status, 202)
        self.assertEqual(response.read(), b"")

    def test_ssh_is_fixed_and_input_is_stdin(self):
        def fake_run(command, **options):
            self.assertEqual(command[-1], "openteam-imessage-reader")
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertIn("ForwardAgent=no", command)
            payload = json.loads(options["input"])
            self.assertEqual(payload["arguments"]["query"], "$(touch /tmp/pwned)")
            options["stdout"].write(b'{"chats":[]}')
            return subprocess.CompletedProcess(command, 0)
        with patch.object(gateway.subprocess, "run", side_effect=fake_run):
            self.assertEqual(self.gateway.execute("chats", {"query": "$(touch /tmp/pwned)"}), {"chats": []})

    def test_errors_do_not_expose_ssh_stderr(self):
        with patch.object(gateway.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 25)):
            self.assertEqual(self.gateway.execute("status", {})["error"], "ssh_unavailable")
        result = self.gateway.rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "imessage_history", "arguments": {"chat_id": "1; rm"}}})
        self.assertTrue(result["result"]["isError"])

    def test_permissions_on_credentials(self):
        Path(self.config["identity_file"]).chmod(0o644)
        with self.assertRaises(ValueError):
            gateway.Gateway(self.config)


class InstallerTests(unittest.TestCase):
    def test_restricted_key_preserves_existing_access_and_is_idempotent(self):
        spec = importlib.util.spec_from_file_location("installer", Path(reader.__file__).with_name("install-reader.py"))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".ssh").mkdir()
            authorized = home / ".ssh/authorized_keys"
            authorized.write_text("existing-access\n")
            public = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()
            installer.install(public, home)
            first = authorized.read_text()
            installer.install(public, home)
            self.assertEqual(first, authorized.read_text())
            self.assertTrue(first.startswith("existing-access\nrestrict,command="))
            self.assertIn("reader.py", first)
            self.assertEqual(authorized.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
