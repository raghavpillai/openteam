import base64
import datetime
import json
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import reader

NOW = time.time_ns() - reader.APPLE_EPOCH * reader.NS
MINUTE, DAY = 60 * reader.NS, reader.DAY
ARCHIVED = b"\x04\x0bstreamtyped" + b"\x01+\x0farchived SECRET"
MENTIONED = (b"\x04\x0bstreamtyped\x01+\x0chey Bo, look\x86\x84\x1c__kIMMentionConfirmedMention"
             b"\x86\x92\x84\x96\x96\x0c+15550002222\x86\x86")


def build_messages(path):
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER,
        service TEXT, attributedBody BLOB, associated_message_type INTEGER, associated_message_guid TEXT, associated_message_emoji TEXT,
        date_edited INTEGER, date_retracted INTEGER, cache_has_attachments INTEGER, item_type INTEGER, group_title TEXT,
        thread_originator_guid TEXT, is_system_message INTEGER);
      CREATE INDEX message_idx_date ON message(date);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, chat_identifier TEXT, service_name TEXT, style INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    """)
    handles = ["+15550001111", "friend@example.com", "73981", "VM-HDFCBK", "+15550002222", "+447700900123",
               "+15550003333/TYPE=PLMN@tmomail.net"]
    db.executemany("INSERT INTO handle(ROWID, id) VALUES (?,?)", enumerate(handles, 1))
    chats = [(1, "any;-;+15550001111", None, "+15550001111", "iMessage", 45, [1]),
             (2, "any;-;73981", None, "73981(smsft)", "SMS", 45, [3]),
             (3, "any;-;VM-HDFCBK", None, "VM-HDFCBK", "SMS", 45, [4]),
             (4, "any;+;chat123", "Weekend Crew", "chat123", "iMessage", 43, [1, 5]),
             (5, "any;-;friend@example.com", None, "friend@example.com", "iMessage", 45, [2]),
             (6, "any;-;+15550003333", None, "+15550003333/TYPE=PLMN@tmomail.net", "SMS", 45, [7]),
             (7, "any;-;+447700900123", None, "+447700900123", "iMessage", 45, [6])]
    for row in chats:
        db.execute("INSERT INTO chat VALUES (?,?,?,?,?,?)", row[:6])
        db.executemany("INSERT INTO chat_handle_join VALUES (?,?)", [(row[0], handle) for handle in row[6]])
    # (rowid, chat, text, age, from_me, handle, service, extra columns). Insert order deliberately differs from date order,
    # as Messages in iCloud backfill does.
    messages = [
        (1, 3, "Your OTP is 222222", 5 * MINUTE, 0, 4, "SMS", {}),
        (2, 1, "hello there", 10 * DAY, 0, 1, "iMessage", {}),
        (3, 1, "hi Alex", 9 * DAY, 1, None, "iMessage", {}),
        (4, 4, "weekend plans?", 2 * DAY, 0, 5, "iMessage", {}),
        (5, 2, "BofA: code 111111", 3 * DAY, 0, 3, "SMS", {}),
        (6, 1, None, DAY, 0, 1, "iMessage", {"attributedBody": ARCHIVED}),
        (7, 1, "Loved “hi Alex”", DAY - 1, 0, 1, "iMessage", {"associated_message_type": 2000, "associated_message_guid": "p:0/G3"}),
        (8, 1, "oops", 20 * 60 * MINUTE, 1, None, "iMessage", {"date_retracted": NOW}),
        (9, 5, "100% sure about a_b", 6 * 60 * MINUTE, 0, 2, "iMessage", {}),
        (10, 1, "￼", 30 * MINUTE, 1, None, "iMessage", {"cache_has_attachments": 1}),
        (11, 6, "mms hello", 2 * 60 * MINUTE, 0, 7, "SMS", {}),
        (12, 4, None, 3 * DAY, 0, 5, "iMessage", {"item_type": 2, "group_title": "Weekend Crew"}),
        (13, 5, "axb only", 7 * 60 * MINUTE, 0, 2, "iMessage", {}),
        (14, 7, "Café crème", 4 * DAY, 0, 6, "iMessage", {}),
        (15, 1, "Liked hello there", 9 * DAY + 3 * MINUTE, 0, 1, "iMessage", {"associated_message_type": 2001, "associated_message_guid": "p:0/G2"}),
        (16, 1, "Removed a like", 9 * DAY + 2 * MINUTE, 0, 1, "iMessage", {"associated_message_type": 3001, "associated_message_guid": "p:0/G2"}),
        (17, 1, "Reacted with fire", 9 * DAY + MINUTE, 1, None, "iMessage", {"associated_message_type": 2006, "associated_message_guid": "bp:G2", "associated_message_emoji": "\U0001f525"}),
        (18, 4, None, 2 * DAY - MINUTE, 0, 1, "iMessage", {"attributedBody": MENTIONED}),
    ] + [(100 + n, 1, "bulk %d" % n, 30 * DAY + n * MINUTE, n % 2, 1 if n % 2 == 0 else None, "iMessage", {}) for n in range(40)]
    for rowid, chat, text, age, from_me, handle, service, extra in messages:
        values = {"ROWID": rowid, "guid": "G%d" % rowid, "text": text, "date": NOW - age, "is_from_me": from_me,
                  "handle_id": handle or 0, "service": service, **extra}
        db.execute("INSERT INTO message(%s) VALUES (%s)" % (",".join(values), ",".join("?" * len(values))), list(values.values()))
        db.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (chat, rowid, NOW - age))
    db.executemany("INSERT INTO attachment VALUES (?,?,?,?,?,?)", [
        (1, "A1", "~/Library/Messages/Attachments/x/IMG_1.HEIC", "IMG_1.HEIC", "image/heic", 2048),
        (2, "A2", "~/Library/Messages/Attachments/y/lease.pdf", "lease.pdf", "application/pdf", 13),
        (3, "A3", "/etc/hosts", "hosts", "text/plain", 10),
        (4, "A4", "~/Library/Messages/Attachments/z/gone.jpg", "gone.jpg", "image/jpeg", 10)])
    db.executemany("INSERT INTO message_attachment_join VALUES (?,?)", [(10, 1), (9, 2), (9, 3), (9, 4)])
    db.commit()
    db.close()


def build_contacts(home, duplicate=True):
    (home / "Library/Preferences").mkdir(parents=True)
    (home / "Library/Preferences/.GlobalPreferences.plist").write_bytes(plistlib.dumps({"AppleLocale": "en_US"}))
    root = home / "Library/Application Support/AddressBook"
    for path, people in [(root / "Sources/S1/AddressBook-v22.abcddb", [
            (1, 22, "Alex", "Chen", None, None, ["(555) 000-1111"], []),
            (2, 22, "Bo", "Li", None, None, ["+1 555-000-2222"], []),
            (3, 22, "Email", "Pal", None, None, [], ["Friend@Example.com"]),
            (4, 22, "Uma", "Shah", None, None, ["07700 900123", "1-800-MY-APPLE"], []),
            (5, 22, "Cara", None, None, None, ["555.000.3333"], []),
            (6, 22, None, None, None, "101", [], []),
            (7, 19, "Family", None, None, None, [], [])]),
                         (root / "AddressBook-v22.abcddb", [(1, 22, "Alex", "Chen", None, None, ["(555) 000-1111"], [])] if duplicate else [])]:
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path)
        db.executescript("""
          CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME TEXT);
          INSERT INTO Z_PRIMARYKEY VALUES (19, 'ABCDGroup'), (22, 'ABCDContact');
          CREATE TABLE ZABCDRECORD (Z_PK INTEGER, Z_ENT INTEGER, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZMIDDLENAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
          CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
          CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
        """)
        for pk, entity, first, last, nickname, organization, phones, emails in people:
            db.execute("INSERT INTO ZABCDRECORD VALUES (?,?,?,?,NULL,?,?)", (pk, entity, first, last, nickname, organization))
            db.executemany("INSERT INTO ZABCDPHONENUMBER VALUES (?,?)", [(pk, phone) for phone in phones])
            db.executemany("INSERT INTO ZABCDEMAILADDRESS VALUES (?,?)", [(pk, email) for email in emails])
        db.commit()
        db.close()


class ProtocolTwoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = Path(self.directory.name)
        (self.home / "Library/Messages").mkdir(parents=True)
        self.database = self.home / "Library/Messages/chat.db"
        build_messages(self.database)
        build_contacts(self.home)

    def tearDown(self):
        self.directory.cleanup()

    def call(self, operation, **args):
        return reader.execute({"operation": operation, "arguments": args}, self.database, self.home)

    def walk(self, operation, **args):
        ids = []
        while True:
            page = self.call(operation, **args)
            ids += [item["id"] for item in reversed(page["items"])]
            if not page.get("nextBefore"):
                return ids, page
            args["before"] = page["nextBefore"]

    def test_newest_across_every_chat_follows_date_not_insert_order(self):
        page = self.call("items", limit=3)
        self.assertEqual([item["id"] for item in page["items"]], [11, 10, 1])  # Newest last.
        self.assertEqual(page["items"][-1]["text"], "Your OTP is 222222")
        self.assertEqual(page["total"], 54)
        self.assertIn("every chat", page["notice"])
        ids, last = self.walk("items", limit=7)
        self.assertEqual(len(ids), 54)
        self.assertEqual(len(set(ids)), 54)
        self.assertNotIn("nextBefore", last)

    def test_chat_items_describe_each_kind_and_name_people(self):
        page = self.call("items", chatGuid="any;-;+15550001111", limit=7)
        items = {item["id"]: item for item in page["items"]}
        self.assertEqual({item["chatGuid"] for item in page["items"]}, {"any;-;+15550001111"})
        self.assertEqual(page["people"], {"+15550001111": "Alex Chen"})
        self.assertEqual(items[10]["handle"], "+15550001111")  # The other party, even on the user's own messages.
        self.assertEqual(items[10]["attachments"], [{"guid": "A1", "filename": "IMG_1.HEIC", "mime": "image/heic", "sizeBytes": 2048}])
        self.assertNotIn("text", items[10])
        self.assertNotIn("notice", items[10])
        self.assertEqual((items[8]["kind"], "text" in items[8], "retractedAt" in items[8]), ("unsent", False, True))
        self.assertNotIn(7, items)  # Tapbacks fold onto the message they react to.
        self.assertEqual([(t["type"], t["fromMe"], t["handle"]) for t in items[3]["tapbacks"]], [("loved", False, "+15550001111")])
        # A like and its removal cancel out; the user's emoji reaction stays.
        self.assertEqual([(t["type"], t["fromMe"], t.get("emoji")) for t in items[2]["tapbacks"]], [("reacted", True, "\U0001f525")])
        self.assertEqual((items[6]["text"], items[6]["textLossy"]), ("archived SECRET", True))
        self.assertEqual(page["total"], 45)

    def test_chat_items_read_a_time_window(self):
        day = self.call("items", chatGuid="any;-;+15550001111", since=reader.iso(NOW - 10 * DAY - MINUTE), until=reader.iso(NOW - 8 * DAY))
        self.assertEqual([item["id"] for item in day["items"]], [2, 3])
        self.assertEqual(day["total"], 2)
        self.assertEqual([item["id"] for item in self.call("items", since="45m")["items"]], [10, 1])
        with self.assertRaises(ValueError):
            self.call("items", since="1h", until="2h")

    def test_group_items_carry_sender_and_chat_name(self):
        items = self.call("items", chatGuid="any;+;chat123")["items"]
        self.assertEqual(items[0]["kind"], "group-event")
        self.assertEqual(items[0]["groupTitle"], "Weekend Crew")
        self.assertEqual((items[1]["handle"], items[1]["group"], items[1]["chatName"]), ("+15550002222", True, "Weekend Crew"))
        self.assertEqual((items[2]["text"], items[2]["mentions"]), ("hey Bo, look", ["+15550002222"]))
        self.assertEqual(self.call("items", chatGuid="any;+;chat123")["people"], {"+15550002222": "Bo Li", "+15550001111": "Alex Chen"})

    def test_activity_is_the_inbox_view(self):
        recent = self.call("activity", since="15m")
        self.assertEqual([chat["chatGuid"] for chat in recent["chats"]], ["any;-;VM-HDFCBK"])
        self.assertEqual(recent["chats"][0]["lastMessage"]["text"], "Your OTP is 222222")
        hour = self.call("activity", since="1h")
        self.assertEqual([chat["chatGuid"] for chat in hour["chats"]], ["any;-;VM-HDFCBK", "any;-;+15550001111"])
        self.assertEqual(hour["chats"][1]["lastMessage"]["text"], "[1 attachment]")
        self.assertEqual(hour["people"], {"+15550001111": "Alex Chen"})
        window = self.call("activity", since="1h", until="10m")
        self.assertEqual([(c["chatGuid"], c["count"], c["sent"], c["received"]) for c in window["chats"]], [("any;-;+15550001111", 1, 1, 0)])
        week = self.call("activity", since="7d", limit=2)
        self.assertEqual((week["total"], len(week["chats"]), week["truncated"]), (7, 2, "count"))
        empty = self.call("activity", since="2099-01-01T00:00:00Z")
        self.assertEqual(empty["chats"], [])
        self.assertEqual(empty["latestMessageOnMac"], reader.iso(NOW - 5 * MINUTE))
        self.assertIn("IMessageStatus", empty["notice"])

    def test_search_covers_archived_bodies_and_skips_tapbacks_and_unsent(self):
        self.assertEqual([i["id"] for i in self.call("text_search", query="ARCHIVED secret")["items"]], [6])
        self.assertEqual([i["id"] for i in self.call("text_search", query="100%")["items"]], [9])
        self.assertEqual([i["id"] for i in self.call("text_search", query="a_b")["items"]], [9])  # "_" is literal.
        self.assertEqual(self.call("text_search", query="Loved")["total"], 0)
        self.assertEqual(self.call("text_search", query="oops")["total"], 0)
        self.assertEqual([i["id"] for i in self.call("text_search", query="CAFÉ")["items"]], [14])
        self.assertEqual(self.call("text_search", query="hello", chatGuid="any;-;+15550003333")["total"], 1)
        self.assertEqual(self.call("text_search", query="bulk", since="7d")["total"], 0)
        ids, _ = self.walk("text_search", query="BULK", limit=15)
        self.assertEqual(sorted(ids), list(range(100, 140)))
        self.assertEqual(self.call("text_search", query="bulk", limit=1)["total"], 40)

    def test_find_chats_matches_numbers_emails_short_codes_and_sender_names(self):
        listing = self.call("find_chats")["chats"]
        self.assertEqual(listing[0]["chatGuid"], "any;-;VM-HDFCBK")
        self.assertEqual(listing[0]["lastMessage"]["text"], "Your OTP is 222222")
        dates = [chat["latestDate"] for chat in listing]
        self.assertEqual(dates, sorted(dates, reverse=True))
        for handle, expected in [("(555) 000-1111", {"any;-;+15550001111", "any;+;chat123"}), ("5550001111", {"any;-;+15550001111", "any;+;chat123"}),
                                 ("FRIEND@example.com", {"any;-;friend@example.com"}), ("73981", {"any;-;73981"}),
                                 ("hdfcbk", {"any;-;VM-HDFCBK"}), ("+1 555 000 3333", {"any;-;+15550003333"}),
                                 ("+44 7700 900123", {"any;-;+447700900123"})]:
            self.assertEqual({chat["chatGuid"] for chat in self.call("find_chats", handle=handle)["chats"]}, expected, handle)
        person = self.call("find_chats", handle="Alex")
        self.assertEqual(person["chats"], [])
        self.assertIn("FindContacts", person["notice"])
        self.assertEqual([c["chatGuid"] for c in self.call("find_chats", displayName="weekend")["chats"]], ["any;+;chat123"])

    def test_lists_stay_within_the_size_budget(self):
        db = sqlite3.connect(self.database)
        for n in range(400):  # Many active one-to-one chats with long latest messages.
            db.execute("INSERT INTO handle(ROWID, id) VALUES (?, ?)", (1000 + n, "+1555900%04d" % n))
            db.execute("INSERT INTO chat VALUES (?,?,?,?,?,?)", (1000 + n, "any;-;bulk%d" % n, None, "+1555900%04d" % n, "SMS", 45))
            db.execute("INSERT INTO chat_handle_join VALUES (?,?)", (1000 + n, 1000 + n))
            db.execute("INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id, service) VALUES (?,?,?,?,0,?,'SMS')",
                       (5000 + n, "B%d" % n, "x" * 400, NOW - (n + 60) * MINUTE, 1000 + n))
            db.execute("INSERT INTO chat_message_join VALUES (?,?,?)", (1000 + n, 5000 + n, NOW - (n + 60) * MINUTE))
        db.commit()
        db.close()
        for result in (self.call("find_chats", limit=500), self.call("activity", since="2d", limit=200)):
            self.assertLessEqual(len(json.dumps(result, ensure_ascii=False)), reader.BUDGET + 4000)
            self.assertEqual(result["truncated"], "bytes")
            self.assertIn("bigger limit will not help", result["notice"])
        self.assertEqual(self.call("find_chats", limit=5)["truncated"], "count")

    def test_contacts_by_name_number_and_email(self):
        alex = self.call("contacts", query="alex ch")
        self.assertEqual(alex["contacts"], [{"name": "Alex Chen", "phones": ["+15550001111"], "emails": []}])  # Deduplicated.
        self.assertEqual(alex["region"], "US")
        self.assertEqual([c["name"] for c in self.call("contacts", query="555-000-2222")["contacts"]], ["Bo Li"])
        self.assertEqual([c["name"] for c in self.call("contacts", query="0002222")["contacts"]], ["Bo Li"])
        self.assertEqual([c["name"] for c in self.call("contacts", query="friend@EXAMPLE")["contacts"]], ["Email Pal"])
        self.assertEqual(self.call("contacts", query="uma")["contacts"][0]["unresolvedPhones"], ["07700 900123", "1-800-MY-APPLE"])
        self.assertEqual([c["name"] for c in self.call("contacts", query="101")["contacts"]], ["101"])
        self.assertEqual(self.call("contacts", query="Family")["total"], 0)  # Groups are not people.
        self.assertEqual(self.call("items", chatGuid="any;-;+15550003333")["people"], {"+15550003333/TYPE=PLMN@tmomail.net": "Cara"})

    def test_status_reports_freshness(self):
        status = self.call("status")
        self.assertEqual((status["readable"], status["readOnly"], status["protocolVersion"]), (True, True, reader.PROTOCOL))
        self.assertEqual(status["latestMessage"], reader.iso(NOW - 5 * MINUTE))
        self.assertEqual(status["latestByService"]["SMS"], reader.iso(NOW - 5 * MINUTE))
        self.assertEqual(status["receivedLast24h"], 4)
        self.assertEqual(status["contacts"], {"readable": True, "count": 6})
        self.assertNotIn("receivingNotice", status)
        self.assertNotIn("iCloudSync", status)
        db = sqlite3.connect(self.database)
        db.execute("UPDATE message SET date = date - ?", (3 * DAY,))
        db.commit()
        db.close()
        self.assertIn("Text Message Forwarding", self.call("status")["receivingNotice"])
        # Other reads carry the same warning, so the agent sees it without an extra call.
        self.assertIn("receivingNotice", self.call("activity", since="1w"))
        self.assertIn("receivingNotice", self.call("items", limit=1))

    def test_icloud_catch_up_is_reported_everywhere(self):
        prefs = self.home / "Library/Preferences/com.apple.madrid.plist"
        prefs.write_bytes(plistlib.dumps({"CloudKitSyncingEnabled": True, "CloudKitIsSyncing": True,
                                          "CloudKitHasAvailableRecordsToDownload": True,
                                          "CloudKitSyncDate": datetime.datetime(2026, 10, 14, 22, 32, 9)}))
        status = self.call("status")
        self.assertEqual(status["iCloudSync"], {"enabled": True, "syncing": True, "recordsWaiting": True, "lastSync": "2026-10-14T22:32:09Z"})
        for result in (status, self.call("items"), self.call("text_search", query="hello")):
            self.assertIn("new messages arrive normally", result["syncNotice"])
        for result in (self.call("activity", since="1h"), self.call("find_chats")):  # New arrivals are live.
            self.assertNotIn("syncNotice", result)
        prefs.write_bytes(plistlib.dumps({"CloudKitSyncingEnabled": True, "CloudKitIsSyncing": False}))
        self.assertNotIn("syncNotice", self.call("items"))

    def test_without_contacts_handles_still_work(self):
        home = self.home / "other"
        home.mkdir()
        status = reader.execute({"operation": "status", "arguments": {}}, self.database, home)
        self.assertFalse(status["contacts"]["readable"])
        self.assertIn("contactsNotice", status)
        self.assertEqual(reader.execute({"operation": "contacts", "arguments": {"query": "x"}}, self.database, home)["error"], "contacts_unavailable")
        self.assertEqual(reader.execute({"operation": "items", "arguments": {}}, self.database, home)["people"], {})

    def test_errors_explain_the_fix(self):
        for operation, args, message in [
                ("activity", {"since": "yesterday"}, "duration before now"), ("activity", {"since": "2026-10-14"}, "offset"),
                ("activity", {"since": "1h", "until": "2h"}, "until must be after since"),
                ("items", {"before": {"date": "2h", "id": 1}}, "offset"), ("items", {"before": {"id": 1}}, "nextBefore"),
                ("items", {"limit": 201}, "1 to 200"), ("items", {"chat": "x"}, "Unsupported argument: chat"),
                ("text_search", {}, "query is required"), ("find_chats", {"handle": " "}, "non-empty")]:
            with self.assertRaises(ValueError) as caught:
                self.call(operation, **args)
            self.assertIn(message, str(caught.exception))
        self.assertEqual(self.call("items", chatGuid="any;-;nobody")["error"], "unknown_chat")

    def test_reads_never_change_the_database(self):
        before = self.database.read_bytes()
        for operation, args in [("status", {}), ("activity", {"since": "1w"}), ("items", {}), ("text_search", {"query": "a"}),
                                ("find_chats", {}), ("contacts", {"query": "a"})]:
            self.call(operation, **args)
        self.assertEqual(before, self.database.read_bytes())

    def test_cli_returns_specific_validation_messages(self):
        script = str(Path(reader.__file__))
        run = lambda request: subprocess.run([sys.executable, script, "--database", str(self.database), "--home", str(self.home)],
                                             input=json.dumps(request), text=True, capture_output=True)
        ok = run({"operation": "items", "arguments": {"limit": 1}})
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(json.loads(ok.stdout)["items"][0]["text"], "Your OTP is 222222")
        bad = run({"operation": "activity", "arguments": {"since": "soon"}})
        self.assertEqual(bad.returncode, 1)
        self.assertIn("15m", json.loads(bad.stdout)["message"])


class AttachmentTests(unittest.TestCase):
    setUp, tearDown, call = ProtocolTwoTests.setUp, ProtocolTwoTests.tearDown, ProtocolTwoTests.call

    def files(self):
        root = self.home / "Library/Messages/Attachments"
        (root / "y").mkdir(parents=True)
        (root / "y/lease.pdf").write_bytes(b"%PDF-1.4 test")
        (root / "x").mkdir(parents=True)
        if not Path("/usr/bin/sips").exists():
            return False
        png = root / "x/source.png"
        png.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
        subprocess.run(["/usr/bin/sips", "-s", "format", "heic", str(png), "--out", str(root / "x/IMG_1.HEIC")],
                       check=True, capture_output=True)
        return True

    def test_files_are_returned_and_heic_becomes_jpeg(self):
        heic = self.files()
        pdf = self.call("attachment", messageGuid="G9", attachmentGuid="A2")
        self.assertEqual((pdf["filename"], pdf["mime"], base64.b64decode(pdf["bytesBase64"])), ("lease.pdf", "application/pdf", b"%PDF-1.4 test"))
        if not heic:
            self.skipTest("sips is only on macOS")
        photo = self.call("attachment", messageGuid="G10", attachmentGuid="A1")
        self.assertEqual((photo["filename"], photo["mime"]), ("IMG_1.jpg", "image/jpeg"))
        self.assertTrue(base64.b64decode(photo["bytesBase64"]).startswith(b"\xff\xd8"))

    def test_only_downloaded_files_inside_messages_for_that_message(self):
        self.files()
        self.assertEqual(self.call("attachment", messageGuid="G9", attachmentGuid="A3")["error"], "attachment_unavailable")
        self.assertEqual(self.call("attachment", messageGuid="G9", attachmentGuid="A4")["error"], "attachment_unavailable")
        self.assertEqual(self.call("attachment", messageGuid="G10", attachmentGuid="A2")["error"], "attachment_not_found")
        with self.assertRaises(ValueError):
            self.call("attachment", messageGuid="G9")


class FormatTests(unittest.TestCase):
    def test_e164(self):
        for raw, region, expected in [("(555) 000-1111", "US", "+15550001111"), ("1 555 000 1111", "US", "+15550001111"),
                                      ("+44 7700 900123", "US", "+447700900123"), ("011 44 7700 900123", "US", "+447700900123"),
                                      ("07700 900123", "GB", "+447700900123"), ("0044 7700 900123", "GB", "+447700900123"),
                                      ("98765 43210", "IN", "+919876543210"), ("07700 900123", "US", None),
                                      ("1-800-MY-APPLE", "US", None), ("555-0000 ext 2", "US", None), ("73981", "US", None),
                                      ("5550001111", None, None)]:
            self.assertEqual(reader.e164(raw, region), expected, raw)

    def test_times_round_trip_exactly(self):
        value = reader.parse_time("2026-10-14T18:37:20.123456789-04:00", 0)
        self.assertEqual(reader.iso(value, exact=True), "2026-10-14T22:37:20.123456789Z")
        self.assertEqual(reader.parse_time(reader.iso(value, exact=True), 0, relative=False), value)
        self.assertEqual(reader.parse_time("2026-10-14T22:37:20Z", 0), reader.parse_time("2026-10-14 18:37:20-0400", 0))
        self.assertEqual(reader.parse_time("90 minutes", 10**15), 10**15 - 90 * MINUTE)
        self.assertEqual(reader.parse_time("2w", 10**16), 10**16 - 14 * DAY)
        for bad in ("2026-02-30T00:00:00Z", "15", "1 month", "noon", None, 5):
            with self.assertRaises(ValueError):
                reader.parse_time(bad, 0)


if __name__ == "__main__":
    unittest.main()
