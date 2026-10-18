#!/usr/bin/env python3
"""One Messages request on stdin, one JSON result on stdout. Sending requires a local opt-in."""
import argparse
import base64
import calendar
import datetime
import hashlib
import json
import mimetypes
import os
import plistlib
from pathlib import Path
import re
import sqlite3
import socket
import subprocess
import sys
import tempfile
import time

PROTOCOL = 4  # Bump whenever this file changes: bridges reinstall a Mac's reader when its protocol is older.
MAX_REQUEST = 32768
MAX_TEXT = 16000
PREVIEW = 200
BUDGET = 64_000  # Characters of JSON per page.
MAX_ATTACHMENT = 50 * 1024 * 1024
NS = 1_000_000_000
APPLE_EPOCH = 978307200
DAY = 86400 * NS
# Protocol 2 operations take the tools' camelCase arguments; limits are (default, maximum).
LIMITS = {"activity": (50, 200), "items": (50, 200), "text_search": (25, 100), "find_chats": (50, 500), "contacts": (25, 100)}
OPERATIONS = {
    "status": set(),
    "send_status": {"chatGuid"},
    "send": {"chatGuid", "text", "requestId"},
    "activity": {"since", "until", "limit"},
    "items": {"chatGuid", "limit", "before", "since", "until"},
    "text_search": {"query", "chatGuid", "limit", "before", "since", "until"},
    "find_chats": {"displayName", "handle", "limit"},
    "contacts": {"query", "limit"},
    "attachment": {"messageGuid", "attachmentGuid"},
    # Protocol 1, kept so an older bridge sharing this Mac keeps working.
    "chats": {"query", "limit", "before_id"},
    "history": {"chat_id", "limit", "before_id"},
    "search": {"query", "chat_id", "limit", "before_id"},
}
LEGACY = {"chats", "history", "search"}
REQUIRED = {"send": ("chatGuid", "text", "requestId"), "activity": ("since",), "text_search": ("query",), "contacts": ("query",), "attachment": ("messageGuid", "attachmentGuid")}
STRINGS = {"text": 4000, "requestId": 36, "query": 256, "chatGuid": 512, "displayName": 256, "handle": 256, "messageGuid": 512, "attachmentGuid": 512}
RELATIVE = re.compile(r"(\d{1,6})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)", re.I)
ISO = re.compile(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?(Z|[+-]\d\d:?\d\d)", re.I)
RECEIVING = ("No message has reached the Mac in %s. If the user expects newer messages, the Mac may have stopped receiving: "
             "ask them to check that Messages on the Mac is signed in to iMessage (Messages > Settings > iMessage) and, for SMS, "
             "that Text Message Forwarding is on for this Mac on their iPhone. Searching cannot find messages the Mac never received.")
SYNCING = ("The Mac is still downloading older messages from iCloud; new messages arrive normally. Messages from a time it "
           "wasn't receiving may be missing, so when the newest match is older than the user expects, give it and say a newer "
           "one may not have synced yet.")
REACTIONS = ("loved", "liked", "disliked", "laughed", "emphasized", "questioned", "reacted", "sticker")
NOT_TAPBACK = "(m.associated_message_type IS NULL OR m.associated_message_type NOT BETWEEN 2000 AND 3999)"
MENTION = b"__kIMMentionConfirmedMention"
CONVERT = {"image/heic", "image/heif", "image/tiff"}  # Sent as JPEG so any image viewer can open them.
# Country calling code and national trunk prefix for numbers saved without "+".
CALLING = {
    "US": ("1", "1"), "CA": ("1", "1"), "GB": ("44", "0"), "IE": ("353", "0"), "IN": ("91", "0"), "AU": ("61", "0"),
    "NZ": ("64", "0"), "DE": ("49", "0"), "FR": ("33", "0"), "ES": ("34", ""), "IT": ("39", ""), "NL": ("31", "0"),
    "BE": ("32", "0"), "CH": ("41", "0"), "AT": ("43", "0"), "SE": ("46", "0"), "NO": ("47", ""), "DK": ("45", ""),
    "FI": ("358", "0"), "PL": ("48", ""), "PT": ("351", ""), "BR": ("55", "0"), "MX": ("52", ""), "JP": ("81", "0"),
    "KR": ("82", "0"), "CN": ("86", "0"), "HK": ("852", ""), "SG": ("65", ""), "AE": ("971", "0"), "IL": ("972", "0"),
    "ZA": ("27", "0"), "PH": ("63", "0"), "PK": ("92", "0"), "NG": ("234", "0"), "TR": ("90", "0"),
}


def validate_legacy(operation, args):
    for key in ("limit", "chat_id", "before_id"):
        if key in args and (type(args[key]) is not int or not 1 <= args[key] <= (50 if key == "limit" else 2**63 - 1)):
            raise ValueError("Invalid " + key)
    if operation == "history" and "chat_id" not in args:
        raise ValueError("chat_id is required")
    if "query" in args and (not isinstance(args["query"], str) or not 1 <= len(args["query"].strip()) <= 256):
        raise ValueError("query must contain 1 to 256 characters")
    if operation == "search" and "query" not in args:
        raise ValueError("query is required")
    return args


def validate(request):
    if not isinstance(request, dict) or set(request) - {"operation", "arguments"}:
        raise ValueError("Expected operation and arguments")
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ValueError("Unknown operation")
    args = request.get("arguments", {})
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    unknown = sorted(set(args) - OPERATIONS[operation])
    if unknown:
        raise ValueError("Unsupported argument: " + ", ".join(unknown))
    if operation in LEGACY:
        return operation, validate_legacy(operation, args)
    for key in REQUIRED.get(operation, ()):
        if key not in args:
            raise ValueError(key + " is required")
    for key, size in STRINGS.items():
        if key in args and (not isinstance(args[key], str) or not args[key].strip() or len(args[key]) > size):
            raise ValueError("%s must be a non-empty string of at most %d characters" % (key, size))
    if operation in {"send", "send_status"}:
        if any("\x00" in value for value in args.values() if isinstance(value, str)):
            raise ValueError("NUL characters are not allowed")
        if "chatGuid" in args and not re.fullmatch(r"(?:any|iMessage|SMS|RCS);[+-];[^\r\n]+", args["chatGuid"]):
            raise ValueError("Copy the exact chatGuid from FindIMessageChats")
        if "requestId" in args and not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args["requestId"]):
            raise ValueError("requestId must be a lowercase UUID; reuse it for the same send attempt")
    if "limit" in args and (type(args["limit"]) is not int or not 1 <= args["limit"] <= LIMITS[operation][1]):
        raise ValueError("limit must be an integer from 1 to %d" % LIMITS[operation][1])
    if "before" in args:
        cursor = args["before"]
        if not isinstance(cursor, dict) or set(cursor) != {"date", "id"} or type(cursor["id"]) is not int or cursor["id"] < 1:
            raise ValueError("before must be the nextBefore object ({date, id}) copied from an earlier result")
        parse_time(cursor["date"], 0, relative=False)
    for key in ("since", "until"):
        if key in args:
            parse_time(args[key], 0)
    return operation, args


def parse_time(value, now, relative=True):
    """An ISO-8601 time with an offset, or a duration before now such as 15m, 2h, 3d or 1w."""
    if isinstance(value, str) and len(value) <= 64:
        text = value.strip()
        match = RELATIVE.fullmatch(text) if relative else None
        if match:
            unit = {"m": 60, "h": 3600, "d": 86400, "w": 604800}[match.group(2)[0].lower()]
            return now - int(match.group(1)) * unit * NS
        match = ISO.fullmatch(text)
        if match:
            year, month, day, hour, minute, second, fraction, offset = match.groups()
            fields = (int(year), int(month), int(day), int(hour), int(minute), int(second or 0))
            try:
                datetime.datetime(*fields)
            except ValueError:
                pass
            else:
                shift = 0
                if offset.upper() != "Z":
                    digits = offset[1:].replace(":", "")
                    shift = (int(digits[:2]) * 60 + int(digits[2:])) * 60 * (1 if offset[0] == "+" else -1)
                return (calendar.timegm(fields) - shift - APPLE_EPOCH) * NS + int((fraction or "").ljust(9, "0"))
    raise ValueError("Use an ISO-8601 time with an offset, such as 2026-10-14T18:00:00-04:00"
                     + (", or a duration before now such as 15m, 2h, 3d or 1w" if relative else ""))


def apple_ns(value):
    if not value:
        return None
    value = int(value)
    # Current Messages schemas store nanoseconds since 2001; older schemas used seconds.
    return value * NS if abs(value) < 100_000_000_000 else value


def iso(value, exact=False):
    value = apple_ns(value)
    if value is None:
        return None
    seconds, nanos = divmod(value, NS)
    moment = datetime.datetime(2001, 1, 1) + datetime.timedelta(seconds=seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + ("." + str(nanos).rjust(9, "0") if exact else "") + "Z"


def decode_body(text, blob):
    if isinstance(text, str) and text:
        return text, False
    if not isinstance(blob, bytes) or len(blob) > 2_000_000:
        return text if isinstance(text, str) else None, False
    try:
        if blob.startswith(b"bplist00"):
            archive = plistlib.loads(blob)
            objects = archive.get("$objects", [])
            value = archive.get("$top", {}).get("root")
            for _ in range(12):
                if isinstance(value, plistlib.UID):
                    value = objects[value.data]
                elif isinstance(value, str):
                    return value, True
                elif isinstance(value, dict):
                    value = value.get("NS.string", value.get("NSString", value.get("NSAttributedString")))
                else:
                    break
        elif b"streamtyped" in blob[:16]:
            marker = blob.find(b"\x01+")
            if marker >= 0:
                offset = marker + 2
                size = blob[offset]
                offset += 1
                if size in (0x81, 0x82):
                    width = 2 if size == 0x81 else 4
                    size = int.from_bytes(blob[offset:offset + width], "little")
                    offset += width
                elif size >= 0x80:
                    return None, True
                if offset + size <= len(blob):
                    return blob[offset:offset + size].decode("utf-8"), True
    except (ValueError, TypeError, IndexError, KeyError, OverflowError, plistlib.InvalidFileException):
        pass
    return None, True


def mentions(blob):
    """Handles @-mentioned in a rich message body: each mention attribute is followed by a length-prefixed handle."""
    found = []
    if not isinstance(blob, bytes):
        return found
    start = blob.find(MENTION)
    while start >= 0:
        start += len(MENTION)
        for offset in range(start, min(start + 48, len(blob) - 1)):
            size = blob[offset]
            value = blob[offset + 1:offset + 1 + size] if 3 <= size <= 120 else b""
            if re.fullmatch(rb"\+?\d{3,15}|[^\s@]+@[^\s@]+\.[^\s@]+", value):
                if value.decode() not in found:
                    found.append(value.decode())
                break
        start = blob.find(MENTION, start)
    return found


def timestamp(value):
    if not value:
        return None
    nanos = int(value)
    seconds = nanos / 1_000_000_000 if abs(nanos) >= 100_000_000_000 else nanos
    return (datetime.datetime(2001, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()


def e164(raw, region):
    """Best-effort E.164 for a number as the user saved it; None when it can't be read as complete."""
    text = (raw or "").strip()
    digits = re.sub(r"\D", "", text)
    if not digits or re.search(r"[A-Za-z]", text):
        return None  # Vanity numbers and extensions are kept as the user typed them.
    if text.startswith("+"):
        return "+" + digits if 8 <= len(digits) <= 15 else None
    code, trunk = CALLING.get(region or "", (None, None))
    if digits.startswith("00") and 10 <= len(digits) <= 17 and code != "1":
        return "+" + digits[2:]
    if code == "1":
        if digits.startswith("011") and len(digits) > 11:
            return "+" + digits[3:]
        if len(digits) == 10:
            return "+1" + digits
        return "+" + digits if len(digits) == 11 and digits[0] == "1" else None
    if code is None:
        return None
    if trunk and digits.startswith(trunk):
        national = digits[len(trunk):]
    elif digits.startswith(code) and len(digits) >= 10:
        return "+" + digits
    else:
        national = digits
    return "+" + code + national if 6 <= len(national) <= 12 else None


def handle_keys(value):
    """Matching keys for a handle: an email, a phone number's digits (plus its last ten), or a sender name."""
    value = re.sub(r"\([a-z]+\)$", "", (value or "").strip())  # e.g. "73981(smsft)"
    value = re.sub(r"(?i)^(\+?\d{5,15})/TYPE=PLMN@.*$", r"\1", value)  # Carrier MMS addresses are phone numbers.
    if "@" in value:
        return [value.casefold()]
    if re.search(r"[^\d\s()+.\-]", value):  # Alphanumeric SMS sender IDs such as "VM-HDFCBK".
        name = re.sub(r"[^0-9a-z]", "", value.casefold())
        return ["~" + name] if name else []
    digits = re.sub(r"\D", "", value)
    return [digits] + ([digits[-10:]] if len(digits) > 10 else []) if digits else []


def icloud_sync(home):
    """Messages in iCloud state from the user's Messages preferences; empty when unavailable."""
    try:
        prefs = plistlib.loads((home / "Library/Preferences/com.apple.madrid.plist").read_bytes())
    except (OSError, ValueError, plistlib.InvalidFileException):
        return {}
    state = {key: bool(prefs[name]) for key, name in (("enabled", "CloudKitSyncingEnabled"), ("syncing", "CloudKitIsSyncing"),
                                                       ("recordsWaiting", "CloudKitHasAvailableRecordsToDownload")) if name in prefs}
    if isinstance(prefs.get("CloudKitSyncDate"), datetime.datetime):
        state["lastSync"] = prefs["CloudKitSyncDate"].strftime("%Y-%m-%dT%H:%M:%SZ")
    return state


def mac_region(home):
    try:
        locale = plistlib.loads((home / "Library/Preferences/.GlobalPreferences.plist").read_bytes()).get("AppleLocale", "")
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None
    match = re.search(r"@rg=([a-z]{2})", locale) or re.search(r"_([A-Za-z]{2})\b", locale)
    return match.group(1).upper() if match else None


class Contacts:
    """Read-only view of every Contacts database on the Mac (the local store and each synced account)."""

    def __init__(self, home):
        self.region = mac_region(home)
        self.readable = False
        self.people = []
        root = home / "Library/Application Support/AddressBook"
        seen = set()
        for path in [root / "AddressBook-v22.abcddb"] + sorted(root.glob("Sources/*/AddressBook-v22.abcddb")):
            if not path.is_file():
                continue
            try:
                db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=3)
                try:
                    people = self.load(db)
                finally:
                    db.close()
            except sqlite3.Error:
                continue
            self.readable = True
            for person in people:
                key = (person["name"], tuple(sorted(person["raw"])), tuple(sorted(person["emails"])))
                if key not in seen:
                    seen.add(key)
                    self.people.append(person)
        self.index = {}
        for person in self.people:
            values = [phone or raw for phone, raw in zip(person["phones"], person["raw"])] + person["emails"]
            for value in values:
                for key in handle_keys(value):
                    self.index.setdefault(key, []).append(person)

    def load(self, db):
        entity = db.execute("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ABCDContact'").fetchone()
        if not entity:
            return []
        columns = {row[1] for row in db.execute("PRAGMA table_info(ZABCDRECORD)")}
        names = ("ZFIRSTNAME", "ZMIDDLENAME", "ZLASTNAME", "ZNICKNAME", "ZORGANIZATION")
        select = ",".join(name if name in columns else "NULL" for name in names)
        people = {}
        for row in db.execute("SELECT Z_PK," + select + " FROM ZABCDRECORD WHERE Z_ENT = ?", entity):
            first, middle, last, nickname, organization = [(part or "").strip() for part in row[1:]]
            name = " ".join(part for part in (first, middle, last) if part) or nickname or organization
            parts = [part for part in (first, middle, last, nickname, organization) if part]
            if name:
                people[row[0]] = {"name": name, "words": [w.casefold() for part in parts for w in re.split(r"[\s\-]+", part) if w],
                                  "phones": [], "raw": [], "emails": []}
        for owner, number in db.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL"):
            if owner in people:
                people[owner]["raw"].append(number)
                people[owner]["phones"].append(e164(number, self.region))
        for owner, address in db.execute("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL"):
            if owner in people and address.strip() not in people[owner]["emails"]:
                people[owner]["emails"].append(address.strip())
        return list(people.values())

    @staticmethod
    def view(person):
        phones = list(dict.fromkeys(phone for phone in person["phones"] if phone))
        unresolved = [raw for phone, raw in zip(person["phones"], person["raw"]) if not phone]
        return {"name": person["name"], "phones": phones, "emails": person["emails"],
                **({"unresolvedPhones": unresolved} if unresolved else {})}

    def names(self, handles):
        people = {}
        for handle in dict.fromkeys(h for h in handles if h):
            for key in handle_keys(handle):
                matches = self.index.get(key)
                if matches:
                    people[handle] = " / ".join(dict.fromkeys(person["name"] for person in matches))
                    break
        return people

    def find(self, query):
        """Name-part prefixes, plus email or phone matches when the query looks like one."""
        query = query.strip()
        tokens = [token.casefold() for token in re.split(r"[\s\-]+", query) if token]
        found = [p for p in self.people if all(any(word.startswith(token) for word in p["words"]) for token in tokens)]
        digits = re.sub(r"\D", "", query)
        if "@" in query:
            needle = query.casefold()
            found += [p for p in self.people if any(needle in email.casefold() for email in p["emails"])]
        elif re.fullmatch(r"[\d\s()+.\-]+", query) and len(digits) >= 3:
            keys = set(handle_keys(query))
            found += [p for p in self.people if any(
                keys.intersection(handle_keys(phone or raw)) or re.sub(r"\D", "", phone or raw).endswith(digits)
                for phone, raw in zip(p["phones"], p["raw"]))]
        return list({id(p): p for p in found}.values())


class Messages:
    COLUMNS = ("guid", "text", "date", "is_from_me", "service", "attributedBody", "associated_message_type",
               "associated_message_guid", "associated_message_emoji", "date_edited", "date_retracted",
               "cache_has_attachments", "item_type", "group_title", "thread_originator_guid", "is_system_message")

    def __init__(self, database, home):
        self.home = home
        self.now = time.time_ns() - APPLE_EPOCH * NS
        self.db = sqlite3.connect(Path(database).as_uri() + "?mode=ro", uri=True, timeout=3)
        self.db.row_factory = sqlite3.Row
        deadline = time.monotonic() + 15
        self.db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        self.db.execute("PRAGMA query_only=ON")
        self.db.execute("BEGIN")
        self.tables = {}
        self.cache = {}

    def close(self):
        self.db.close()

    def columns(self, table):
        if table not in self.tables:
            self.tables[table] = {row["name"] for row in self.db.execute("PRAGMA table_info(%s)" % table)}
        return self.tables[table]

    @property
    def contacts(self):
        if "contacts" not in self.cache:
            self.cache["contacts"] = Contacts(self.home)
        return self.cache["contacts"]

    def chats(self):
        if "chats" not in self.cache:
            if "message_date" not in self.columns("chat_message_join"):
                raise sqlite3.DatabaseError("Messages schema predates chat_message_join.message_date")
            style = "style" if "style" in self.columns("chat") else "NULL"
            chats = {}
            for row in self.db.execute("SELECT ROWID, guid, display_name, chat_identifier, service_name, %s FROM chat" % style):
                chats[row[0]] = {"id": row[0], "guid": row[1], "name": (row[2] or "").strip() or None, "identifier": row[3],
                                 "service": row[4], "style": row[5], "handles": [], "latest": None}
            for chat_id, handle in self.db.execute(
                    "SELECT ch.chat_id, h.id FROM chat_handle_join ch JOIN handle h ON h.ROWID = ch.handle_id ORDER BY ch.chat_id, h.ROWID"):
                if chat_id in chats:
                    chats[chat_id]["handles"].append(handle)
            for chat_id, latest in self.db.execute("SELECT chat_id, max(message_date) FROM chat_message_join GROUP BY chat_id"):
                if chat_id in chats:
                    chats[chat_id]["latest"] = latest
            for chat in chats.values():
                chat["group"] = chat["style"] == 43 if chat["style"] in (43, 45) else len(chat["handles"]) > 1
            self.cache["chats"] = chats
        return self.cache["chats"]

    def chat(self, guid):
        for chat in self.chats().values():
            if chat["guid"] == guid:
                return chat
        raise LookupError("No chat has that chatGuid. Copy one from IMessageActivity or FindIMessageChats.")

    def chat_view(self, chat, latest=None):
        view = {"chatGuid": chat["guid"]}
        if chat["name"]:
            view["displayName"] = chat["name"]
        view.update({"group": chat["group"], "service": chat["service"], "handles": chat["handles"],
                     "latestDate": iso(latest if latest is not None else chat["latest"])})
        return view

    def rows(self, ids):
        """Full message rows plus chat and attachment metadata, keyed by message ROWID."""
        if not ids:
            return {}
        columns = self.columns("message")
        select = ",".join("m." + name if name in columns else "NULL AS " + name for name in self.COLUMNS)
        marks = ",".join("?" * len(ids))
        rows = {row["id"]: dict(row) for row in self.db.execute(
            "SELECT m.ROWID AS id, h.id AS sender," + select + " FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id"
            " WHERE m.ROWID IN (" + marks + ")", ids)}
        for row in rows.values():
            row["chat_id"], row["attachments"] = None, []
        for message_id, chat_id in self.db.execute(
                "SELECT message_id, chat_id FROM chat_message_join WHERE message_id IN (" + marks + ") ORDER BY chat_id", ids):
            if message_id in rows and rows[message_id]["chat_id"] is None:
                rows[message_id]["chat_id"] = chat_id
        if {"guid", "transfer_name", "mime_type", "total_bytes"} <= self.columns("attachment"):
            for row in self.db.execute(
                    "SELECT ma.message_id, a.guid, a.transfer_name, a.filename, a.mime_type, a.total_bytes FROM message_attachment_join ma"
                    " JOIN attachment a ON a.ROWID = ma.attachment_id WHERE ma.message_id IN (" + marks + ")", ids):
                name = row["transfer_name"] or os.path.basename(row["filename"] or "") or None
                rows[row["message_id"]]["attachments"].append(
                    {key: value for key, value in (("guid", row["guid"]), ("filename", name), ("mime", row["mime_type"]),
                                                   ("sizeBytes", row["total_bytes"])) if value is not None})
        return rows

    def item(self, row):
        chat = self.chats().get(row["chat_id"])
        text, lossy = decode_body(row["text"], row["attributedBody"])
        if text is not None:
            text = text.replace("\ufffc", "").strip() or None  # Attachment placeholders carry no text.
        retracted = bool(row["date_retracted"])
        kind = "unsent" if retracted else "group-event" if row["item_type"] or row["is_system_message"] else "message"
        item = {"id": row["id"], "guid": row["guid"], "date": iso(row["date"]), "isFromMe": bool(row["is_from_me"]),
                "service": row["service"], "kind": kind}
        handle = row["sender"]
        if row["is_from_me"]:
            handle = chat["handles"][0] if chat and not chat["group"] and len(chat["handles"]) == 1 else None
        if handle:
            item["handle"] = handle
        if chat:
            item["chatGuid"] = chat["guid"]
            if chat["group"]:
                item["group"] = True
                if chat["name"]:
                    item["chatName"] = chat["name"]
        if retracted:
            item["retractedAt"] = iso(row["date_retracted"])
        elif text is not None:
            item["text"] = text[:MAX_TEXT]
            if len(text) > MAX_TEXT:
                item["textTruncated"] = True
            if lossy:
                item["textLossy"] = True
        mentioned = mentions(row["attributedBody"]) if not retracted else []
        if mentioned:
            item["mentions"] = mentioned
        if kind == "group-event" and row["group_title"]:
            item["groupTitle"] = row["group_title"]
        if row["thread_originator_guid"]:
            item["replyToGuid"] = row["thread_originator_guid"]
        if row["date_edited"]:
            item["editedAt"] = iso(row["date_edited"])
        if row["attachments"]:
            item["attachments"] = row["attachments"]
        if kind == "message" and "text" not in item and not row["attachments"]:
            item["notice"] = "No text could be decoded for this item"
        return item

    def preview(self, item):
        view = {"date": item["date"], "isFromMe": item["isFromMe"]}
        if item.get("group") and not item["isFromMe"] and item.get("handle"):
            view["handle"] = item["handle"]
        text = item.get("text")
        if item["kind"] == "unsent":
            text = "[unsent]"
        elif not text and item.get("attachments"):
            count = len(item["attachments"])
            text = "[%d attachment%s]" % (count, "" if count == 1 else "s")
        if text:
            view["text"] = text if len(text) <= PREVIEW else text[:PREVIEW] + "…"
        return view

    def latest_messages(self, chats, until=None):
        """Each chat's newest message (before until), as a short preview."""
        ids = {}
        for chat in chats:
            sql = ("SELECT cm.message_id FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id"
                   " WHERE cm.chat_id = ? AND " + self.not_tapback())
            params = [chat["id"]]
            if until is not None:
                sql += " AND cm.message_date < ?"
                params.append(until)
            row = self.db.execute(sql + " ORDER BY cm.message_date DESC, cm.message_id DESC LIMIT 1", params).fetchone()
            if row:
                ids[chat["id"]] = row[0]
        rows = self.rows(list(ids.values()))
        return {chat_id: self.preview(self.item(rows[message_id])) for chat_id, message_id in ids.items() if message_id in rows}

    def people(self, handles):
        return self.contacts.names(handles) if self.contacts.readable else {}

    def not_tapback(self):
        return NOT_TAPBACK if "associated_message_type" in self.columns("message") else "1"

    def tapbacks(self, guids, since):
        """Reactions folded onto the messages they target, with later removals applied: target guid -> list."""
        columns = self.columns("message")
        wanted = set(guids)
        if not wanted or not {"associated_message_guid", "associated_message_type"} <= columns:
            return {}
        emoji = "m.associated_message_emoji" if "associated_message_emoji" in columns else "NULL"
        # Targets are "p:<part>/<guid>", "bp:<guid>" or a bare guid, so scan reactions (on their partial index when present)
        # from the page's oldest message onward and match in code.
        sql = ("SELECT m.associated_message_guid AS target, m.associated_message_type AS type, m.is_from_me AS fromMe,"
               " m.date AS date, h.id AS handle, %s AS emoji FROM message m %s LEFT JOIN handle h ON h.ROWID = m.handle_id"
               " WHERE m.associated_message_guid IS NOT NULL AND m.associated_message_type BETWEEN 2000 AND 3999 AND m.date >= ?")
        try:
            rows = self.db.execute(sql % (emoji, "INDEXED BY message_idx_associated_message2"), (since,)).fetchall()
        except sqlite3.OperationalError:
            rows = self.db.execute(sql % (emoji, ""), (since,)).fetchall()
        rows = [row for row in rows if re.sub(r"^(?:p:\d+/|bp:)", "", row["target"]) in wanted]
        folded = {}
        for row in sorted(rows, key=lambda row: row["date"] or 0):
            entries = folded.setdefault(re.sub(r"^(?:p:\d+/|bp:)", "", row["target"]), [])
            code = row["type"] % 1000
            entry = {"type": REACTIONS[code] if code < len(REACTIONS) else "reacted", "fromMe": bool(row["fromMe"])}
            if row["handle"] and not row["fromMe"]:
                entry["handle"] = row["handle"]
            if row["emoji"]:
                entry["emoji"] = row["emoji"]
            if row["type"] < 3000:
                entries.append(dict(entry, date=iso(row["date"])))
                continue
            for index in range(len(entries) - 1, -1, -1):  # A 3000-series row removes the matching earlier reaction.
                if {key: value for key, value in entries[index].items() if key != "date"} == entry:
                    del entries[index]
                    break
        return {guid: entries for guid, entries in folded.items() if entries}

    def cursor(self, args, date="m.date", rowid="m.ROWID"):
        if "before" not in args:
            return "", []
        before = args["before"]
        value = parse_time(before["date"], self.now, relative=False)
        return " AND (%s < ? OR (%s = ? AND %s < ?))" % (date, date, rowid), [value, value, before["id"]]

    def window(self, args, column):
        """since/until bounds on a date column."""
        sql, values = "", []
        for key, operator in (("since", ">="), ("until", "<")):
            if key in args:
                sql += " AND %s %s ?" % (column, operator)
                values.append(parse_time(args[key], self.now))
        if len(values) == 2 and values[1] <= values[0]:
            raise ValueError("until must be after since")
        return sql, values

    @staticmethod
    def fit(views):
        """Keep leading views within the size budget (always at least one); report whether any were dropped."""
        size = 0
        for index, view in enumerate(views):
            size += len(json.dumps(view, ensure_ascii=False))
            if index and size > BUDGET:
                return views[:index], True
        return views, False

    def page(self, kind, matches, total, more, whole_history=False):
        """Build items newest-first within the size budget, then return them oldest-first."""
        rows = self.rows([message_id for message_id, _ in matches])
        reactions = self.tapbacks([rows[message_id]["guid"] for message_id, _ in matches if message_id in rows],
                                  min((date for _, date in matches), default=0))
        items, size, truncated = [], 0, None
        for message_id, date in matches:
            if message_id not in rows:
                continue
            item = self.item(rows[message_id])
            if item["guid"] in reactions:
                item["tapbacks"] = reactions[item["guid"]]
            length = len(json.dumps(item, ensure_ascii=False))
            if items and size + length > BUDGET:
                truncated = "bytes"
                break
            size += length
            items.append((item, date))
        if truncated is None and more:
            truncated = "count"
        result = {"kind": kind, "items": [item for item, _ in reversed(items)], "total": total}
        if truncated and items:
            result["truncated"] = truncated
            result["nextBefore"] = {"date": iso(items[-1][1], exact=True), "id": items[-1][0]["id"]}
            if whole_history:
                result["notice"] = ("These are the newest messages across every chat. Pass a chatGuid to read one conversation, "
                                    "or pass nextBefore as before for older messages.")
            elif truncated == "bytes":
                result["notice"] = ("Older items were withheld to fit the size budget; a bigger limit will not help. "
                                    "Pass nextBefore as before for the next-older page.")
            else:
                result["notice"] = "Older items exist. Pass nextBefore as before for the next-older page."
        handles = [handle for item, _ in items for handle in [item.get("handle")] + item.get("mentions", [])
                   + [tapback.get("handle") for tapback in item.get("tapbacks", [])]]
        result["people"] = self.people(handles)
        return self.freshness(result)

    def freshness(self, result, received=False, sync=None, history=True):
        """Warnings that change how results read: the Mac stopped receiving, or (for history reads) is still catching up from iCloud."""
        if received is False:
            received = (self.db.execute("SELECT date FROM message WHERE is_from_me = 0 ORDER BY date DESC LIMIT 1").fetchone() or [None])[0]
        received = apple_ns(received)
        if received is None or self.now - received > DAY:
            result["receivingNotice"] = RECEIVING % ("any time" if received is None else "%d hours" % ((self.now - received) // (3600 * NS)))
        if history and (icloud_sync(self.home) if sync is None else sync).get("syncing"):
            result["syncNotice"] = SYNCING
        return result

    def status(self, _args):
        one = lambda sql, params=(): (self.db.execute(sql, params).fetchone() or [None])[0]
        count = one("SELECT count(*) FROM message")
        latest = one("SELECT date FROM message ORDER BY date DESC, ROWID DESC LIMIT 1")
        received = one("SELECT date FROM message WHERE is_from_me = 0 ORDER BY date DESC LIMIT 1")
        by_service = {}
        for service in ("iMessage", "SMS", "RCS"):
            try:  # Newest-first scan: the planner otherwise picks a slower service index.
                value = one("SELECT date FROM message INDEXED BY message_idx_date WHERE service = ? ORDER BY date DESC LIMIT 1", (service,))
            except sqlite3.OperationalError:
                value = one("SELECT max(date) FROM message WHERE service = ?", (service,))
            if value:
                by_service[service] = iso(value)
        zone = os.path.realpath("/etc/localtime").partition("zoneinfo/")[2] or None
        contacts = self.contacts
        result = {"readable": True, "readOnly": True, "protocolVersion": PROTOCOL, "operations": sorted(OPERATIONS),
                  "macTime": iso(self.now), "timeZone": zone, "messages": count, "chats": len(self.chats()),
                  "latestMessage": iso(latest), "latestReceived": iso(received), "latestByService": by_service,
                  "receivedLast24h": one("SELECT count(*) FROM message WHERE date >= ? AND is_from_me = 0", (self.now - DAY,)),
                  "contacts": {"readable": contacts.readable, "count": len(contacts.people)}}
        sync = icloud_sync(self.home)
        if sync:
            result["iCloudSync"] = sync
        self.freshness(result, received, sync)
        if not contacts.readable:
            result["contactsNotice"] = "The Mac's Contacts aren't readable over SSH, so handles appear without names."
        return result

    def activity(self, args):
        since = parse_time(args["since"], self.now)
        until = parse_time(args["until"], self.now) if "until" in args else None
        if until is not None and until <= since:
            raise ValueError("until must be after since")
        limit = args.get("limit", LIMITS["activity"][0])
        # Like the inbox, count messages only: tapbacks and group events don't make a chat active.
        events = " AND COALESCE(m.item_type, 0) = 0" if "item_type" in self.columns("message") else ""
        sql = ("SELECT cm.chat_id, count(*) AS n, max(cm.message_date) AS latest, sum(m.is_from_me) AS sent"
               " FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id WHERE cm.message_date >= ?"
               " AND " + self.not_tapback() + events)
        params = [since]
        if until is not None:
            sql += " AND cm.message_date < ?"
            params.append(until)
        chats = self.chats()
        active =[row for row in self.db.execute(sql + " GROUP BY cm.chat_id ORDER BY latest DESC", params) if row["chat_id"] in chats]
        shown = [chats[row["chat_id"]] for row in active[:limit]]
        previews = self.latest_messages(shown, until)
        views = []
        for row, chat in zip(active, shown):
            view = self.chat_view(chat, row["latest"])
            view.update({"count": row["n"], "received": row["n"] - (row["sent"] or 0), "sent": row["sent"] or 0})
            if chat["id"] in previews:
                view["lastMessage"] = previews[chat["id"]]
            views.append(view)
        views, dropped = self.fit(views)
        result = {"kind": "activity", "since": iso(since), "until": iso(until if until is not None else self.now),
                  "chats": views, "total": len(active)}
        if dropped:
            result["truncated"] = "bytes"
            result["notice"] = "More chats were active than fit the size budget; a bigger limit will not help. Narrow the window."
        elif len(active) > limit:
            result["truncated"] = "count"
            result["notice"] = "More chats were active than were returned. Raise limit or narrow the window."
        if not active:
            latest = (self.db.execute("SELECT date FROM message ORDER BY date DESC LIMIT 1").fetchone() or [None])[0]
            result["latestMessageOnMac"] = iso(latest)
            result["notice"] = ("No chat had messages in this window. If the user expects one, compare latestMessageOnMac with "
                                "the window and call IMessageStatus to check whether the Mac is still receiving.")
        result["people"] = self.people(h for view in views for h in view["handles"] + [view.get("lastMessage", {}).get("handle")])
        return self.freshness(result, history=False)  # New arrivals are live even while older history syncs.

    def items(self, args):
        limit = args.get("limit", LIMITS["items"][0])
        tapback = self.not_tapback()
        if "chatGuid" in args:
            # chat_message_join(chat_id, message_date, message_id) serves one conversation newest-first.
            bounds, values = self.window(args, "cm.message_date")
            cursor, after = self.cursor(args, "cm.message_date", "cm.message_id")
            source = (" FROM chat_message_join cm JOIN message m ON m.ROWID = cm.message_id WHERE cm.chat_id = ? AND "
                      + tapback + bounds)
            values = [self.chat(args["chatGuid"])["id"]] + values
            select, order = "SELECT cm.message_id AS id, cm.message_date AS date", " ORDER BY cm.message_date DESC, cm.message_id DESC"
        else:
            bounds, values = self.window(args, "m.date")
            cursor, after = self.cursor(args)
            source = " FROM message m WHERE " + tapback + bounds
            select, order = "SELECT m.ROWID AS id, m.date AS date", " ORDER BY m.date DESC, m.ROWID DESC"
        # total counts the whole selection; the cursor only picks the page.
        total = self.db.execute("SELECT count(*)" + source, values).fetchone()[0]
        rows = self.db.execute(select + source + cursor + order + " LIMIT ?", values + after + [limit + 1]).fetchall()
        return self.page("items", [(row["id"], row["date"]) for row in rows[:limit]], total, len(rows) > limit,
                         "chatGuid" not in args)

    def text_search(self, args):
        query = args["query"].strip()
        needle = query.casefold()
        limit = args.get("limit", LIMITS["text_search"][0])
        columns = self.columns("message")
        where = [self.not_tapback()]
        if "date_retracted" in columns:
            where.append("(m.date_retracted IS NULL OR m.date_retracted = 0)")
        if "item_type" in columns:
            where.append("COALESCE(m.item_type, 0) = 0")
        values = []
        if query.isascii():
            # SQLite folds ASCII case only, so this narrows candidates in place (archived bodies included);
            # the decoded-text check below makes the final, exact decision.
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            archived = "instr(lower(CAST(m.attributedBody AS TEXT)), ?) > 0" if "attributedBody" in columns else "0"
            where.append("(m.text LIKE ? ESCAPE '\\' OR ((m.text IS NULL OR m.text = '') AND %s))" % archived)
            values += ["%" + escaped + "%"] + ([query.lower()] if "attributedBody" in columns else [])
        bounds, window = self.window(args, "m.date")
        if bounds:
            where.append(bounds[5:])
            values += window
        source = "message m"
        if "chatGuid" in args:
            source += " JOIN chat_message_join cm ON cm.message_id = m.ROWID"
            where.append("cm.chat_id = ?")
            values.append(self.chat(args["chatGuid"])["id"])
        body = "CASE WHEN m.text IS NULL OR m.text = '' THEN m.attributedBody END" if "attributedBody" in columns else "NULL"
        cutoff = None
        if "before" in args:
            cutoff = (parse_time(args["before"]["date"], self.now, relative=False), args["before"]["id"])
        matches, total = [], 0
        for row in self.db.execute("SELECT m.ROWID AS id, m.date AS date, m.text AS text, %s AS body FROM %s WHERE %s"
                                   " ORDER BY m.date DESC, m.ROWID DESC" % (body, source, " AND ".join(where)), values):
            text, _ = decode_body(row["text"], row["body"])
            if text is None or needle not in text.casefold():
                continue
            total += 1  # Every match counts; the cursor only picks the page.
            if len(matches) <= limit and (cutoff is None or (row["date"], row["id"]) < cutoff):
                matches.append((row["id"], row["date"]))
        return self.page("search", matches[:limit], total, len(matches) > limit)

    def find_chats(self, args):
        limit = args.get("limit", LIMITS["find_chats"][0])
        chats = sorted(self.chats().values(), key=lambda chat: (chat["latest"] or 0, chat["id"]), reverse=True)
        if "handle" in args:
            keys = handle_keys(args["handle"])
            if keys and keys[0].startswith("~"):  # A sender name matches any sender containing it.
                needle = keys[0][1:]
                matches = lambda values: any(key.startswith("~") and needle in key for value in values for key in handle_keys(value))
            else:  # Numbers match on digits, and also match sender names that contain them ("650024" -> "AT-650024").
                wanted = set(keys)
                digits = keys[0] if keys and "@" not in keys[0] else None
                matches = lambda values: any(wanted.intersection(handle_keys(value)) or any(
                    digits and key.startswith("~") and digits in key for key in handle_keys(value)) for value in values)
            chats = [chat for chat in chats if matches(chat["handles"] + [chat["identifier"] or ""])]
        if "displayName" in args:
            needle = args["displayName"].strip().casefold()
            chats = [chat for chat in chats if chat["name"] and needle in chat["name"].casefold()]
        shown = chats[:limit]
        previews = self.latest_messages(shown)
        views = []
        for chat in shown:
            view = self.chat_view(chat)
            if chat["id"] in previews:
                view["lastMessage"] = previews[chat["id"]]
            views.append(view)
        views, dropped = self.fit(views)
        result = {"kind": "find-chats", "chats": views, "total": len(chats)}
        if dropped:
            result["truncated"] = "bytes"
            result["notice"] = ("More chats matched than fit the size budget; a bigger limit will not help. "
                                "Narrow with handle or displayName.")
        elif len(chats) > limit:
            result["truncated"] = "count"
            result["notice"] = "More chats matched than were returned. Raise limit, or narrow with handle or displayName."
        if not chats and "handle" in args:
            result["notice"] = ("No chat includes that handle. handle takes a phone number, email, short code or SMS sender "
                                "name; to find a person by name, call FindContacts and pass one of their numbers or emails.")
        result["people"] = self.people(h for view in views for h in view["handles"] + [view.get("lastMessage", {}).get("handle")])
        return self.freshness(result, history=False)

    def attachment(self, args):
        """One attachment's bytes, located only through its message, and only inside the Messages folder."""
        row = self.db.execute(
            "SELECT a.filename, a.transfer_name, a.mime_type, a.total_bytes FROM message m"
            " JOIN message_attachment_join ma ON ma.message_id = m.ROWID JOIN attachment a ON a.ROWID = ma.attachment_id"
            " WHERE m.guid = ? AND a.guid = ?", (args["messageGuid"], args["attachmentGuid"])).fetchone()
        if not row:
            return {"error": "attachment_not_found", "message": "That message has no attachment with that attachmentGuid. "
                    "Copy both guids from a ChatItems or SearchIMessages item."}
        stored = row["filename"] or ""
        path = Path(str(self.home) + stored[1:] if stored.startswith("~/") else stored).resolve()
        if self.home.resolve() / "Library/Messages" not in path.parents or not path.is_file():
            return {"error": "attachment_unavailable", "message": "The attachment isn't downloaded to the Mac (it may be kept "
                    "only in iCloud). Tell the user rather than retrying."}
        if path.stat().st_size > MAX_ATTACHMENT:
            return {"error": "attachment_too_large", "message": "The attachment is over 50 MB. Tell the user rather than retrying."}
        name = os.path.basename(row["transfer_name"] or path.name)
        mime = row["mime_type"] or mimetypes.guess_type(name)[0] or "application/octet-stream"
        if mime in CONVERT or path.suffix.lower() in (".heic", ".heif", ".tif", ".tiff"):
            with tempfile.TemporaryDirectory() as temp:
                converted = Path(temp) / "converted.jpg"
                subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", str(path), "--out", str(converted)], check=True,
                               timeout=60, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                data = converted.read_bytes()
            name, mime = os.path.splitext(name)[0] + ".jpg", "image/jpeg"
        else:
            data = path.read_bytes()
        return {"kind": "fetch-attachment", "filename": name, "mime": mime, "sizeBytes": len(data),
                "bytesBase64": base64.b64encode(data).decode()}

    def contacts_lookup(self, args):
        contacts = self.contacts
        if not contacts.readable:
            return {"error": "contacts_unavailable",
                    "message": "The Mac's Contacts database isn't readable by the SSH user, so names can't be looked up."}
        limit = args.get("limit", LIMITS["contacts"][0])
        matches = sorted(contacts.find(args["query"]), key=lambda person: person["name"].casefold())
        result = {"kind": "find-contacts", "region": contacts.region, "contacts": [contacts.view(p) for p in matches[:limit]],
                  "total": len(matches)}
        if len(matches) > limit:
            result["truncated"] = "count"
            result["notice"] = "More people matched than were returned. Use a fuller name."
        return result


def legacy(operation, args, database):
    db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    deadline = time.monotonic() + 10
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        limit = args.get("limit", 20)
        before = args.get("before_id", 2**63 - 1)
        if operation == "chats":
            query = args.get("query", "").lower()
            rows = db.execute("""SELECT c.ROWID AS id,c.guid,c.display_name,c.chat_identifier,c.service_name,
                (SELECT group_concat(h.id, char(10)) FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID) AS participants
                FROM chat c WHERE c.ROWID < ? AND (? = '' OR instr(lower(coalesce(c.display_name,'') || ' ' || coalesce(c.chat_identifier,'')), ?) > 0
                OR EXISTS(SELECT 1 FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID AND instr(lower(h.id), ?) > 0))
                ORDER BY c.ROWID DESC LIMIT ?""", (before, query, query, query, limit + 1)).fetchall()
            items = []
            for row in rows[:limit]:
                item = dict(row)
                item["participants"] = (item["participants"] or "").splitlines()
                items.append(item)
            return {"chats": items, "next_before_id": items[-1]["id"] if len(rows) > limit else None, "order": "chat_id_desc"}
        columns = {row["name"] for row in db.execute("PRAGMA table_info(message)")}
        optional = ["attributedBody", "associated_message_type", "associated_message_guid", "date_edited", "date_retracted", "cache_has_attachments", "item_type"]
        extras = ",".join("m." + key if key in columns else "NULL AS " + key for key in optional)
        chat_id = args.get("chat_id")
        scan_limit = 500 if operation == "search" else limit + 1
        rows = db.execute("""SELECT m.ROWID AS id,m.guid,m.text,m.date,m.is_from_me,h.id AS sender,""" + extras + """
                FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
                WHERE m.ROWID < ? AND (? IS NULL OR EXISTS(SELECT 1 FROM chat_message_join cm WHERE cm.message_id=m.ROWID AND cm.chat_id=?))
                ORDER BY m.ROWID DESC LIMIT ?""", (before, chat_id, chat_id, scan_limit)).fetchall()
        items = []
        scanned = 0
        last_id = None
        for row in rows:
            if operation == "history" and len(items) == limit:
                break
            scanned += 1
            last_id = row["id"]
            text, fallback = decode_body(row["text"], row["attributedBody"])
            retracted = bool(row["date_retracted"])
            if retracted:
                text = None
            if operation == "search" and (text is None or args["query"].casefold() not in text.casefold()):
                continue
            reaction = row["associated_message_type"] or 0
            kind = "unsent" if retracted else "reaction" if 2000 <= reaction < 4000 else "group-event" if row["item_type"] else "message"
            items.append({"id": row["id"], "guid": row["guid"], "date": timestamp(row["date"]),
                          "from_me": bool(row["is_from_me"]), "sender": row["sender"], "kind": kind,
                          "text": text[:MAX_TEXT] if text is not None else None, "body_fallback": fallback,
                          "body_unavailable": text is None, "text_truncated": text is not None and len(text) > MAX_TEXT,
                          "has_attachments": bool(row["cache_has_attachments"]), "edited_at": timestamp(row["date_edited"]),
                          "reaction_type": reaction if kind == "reaction" else None,
                          "reaction_target_guid": row["associated_message_guid"] if kind == "reaction" else None,
                          "chat_ids": [r[0] for r in db.execute("SELECT chat_id FROM chat_message_join WHERE message_id=?", (row["id"],))]})
            if operation == "search" and len(items) == limit:
                break
        more = last_id is not None and db.execute("""SELECT 1 FROM message m WHERE m.ROWID < ? AND
            (? IS NULL OR EXISTS(SELECT 1 FROM chat_message_join cm WHERE cm.message_id=m.ROWID AND cm.chat_id=?)) LIMIT 1""", (last_id, chat_id, chat_id)).fetchone() is not None
        return {"messages": items, "next_before_id": last_id if more else None,
                "scanned": scanned, "complete": not more, "order": "message_id_desc"}
    finally:
        db.close()


SEND_DISABLED = {"error": "sending_disabled", "message": "Sending requires administrator opt-in on this SSH connection and Messages Automation permission on the Mac."}


def automation_permission():
    """Apple's public consent API. Routine probes must never trigger a permission prompt."""
    import ctypes
    class AEDesc(ctypes.Structure):
        # AEDataModel.h uses #pragma pack(push, 2), including on arm64.
        _pack_ = 2
        _fields_ = [("descriptorType", ctypes.c_uint32), ("dataHandle", ctypes.c_void_p)]
    ae = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
    ae.AECreateDesc.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_long, ctypes.POINTER(AEDesc)]
    ae.AECreateDesc.restype = ctypes.c_int32
    ae.AEDisposeDesc.argtypes = [ctypes.POINTER(AEDesc)]
    ae.AEDisposeDesc.restype = ctypes.c_int32
    ae.AEDeterminePermissionToAutomateTarget.argtypes = [ctypes.POINTER(AEDesc), ctypes.c_uint32, ctypes.c_uint32, ctypes.c_ubyte]
    ae.AEDeterminePermissionToAutomateTarget.restype = ctypes.c_int32
    target = AEDesc()
    bundle = b"com.apple.MobileSMS"
    created = ae.AECreateDesc(int.from_bytes(b"bund", "big"), bundle, len(bundle), ctypes.byref(target))
    if created:
        return created
    try:
        wildcard = int.from_bytes(b"****", "big")
        return ae.AEDeterminePermissionToAutomateTarget(ctypes.byref(target), wildcard, wildcard, False)
    finally:
        ae.AEDisposeDesc(ctypes.byref(target))


def check_automation():
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--automation-preflight"],
                                capture_output=True, text=True, timeout=5, check=False)
        code = int(result.stdout.strip()) if result.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return {"error": "automation_preflight_timeout", "automation": "unknown",
                "message": "macOS did not answer a non-prompting permission check. No consent prompt or send was requested."}
    except (OSError, ValueError):
        code = None
    if code == 0:
        return {"automation": "granted"}
    if code in {-1743, -1744}:
        return {"error": "automation_denied" if code == -1743 else "automation_consent_required",
                "automation": "denied" if code == -1743 else "not_granted",
                "message": "Messages Automation is not granted. Use the administrator's explicit consent setup while at the Mac; routine status checks do not request permission."}
    return {"error": "messages_not_running" if code == -600 else "automation_preflight_failed", "automation": "unknown"}


# User-controlled values are argv, never AppleScript source. Only an existing, unique chat is eligible.
# Business chat database GUIDs may use 'any' while scripting exposes another service prefix.
MESSAGES_SCRIPT = '''on run argv
    set operationName to item 1 of argv
    set requestedGuid to item 2 of argv
    with timeout of 10 seconds
        tell application "Messages"
            if requestedGuid is "" then
                set accountCount to count of accounts
                return "ready"
            end if
            set matchedChats to every chat whose id is requestedGuid
            if (count of matchedChats) is 0 and requestedGuid contains ";-;urn:biz:" then
                set markerOffset to offset of ";-;urn:biz:" in requestedGuid
                set businessSuffix to text markerOffset thru -1 of requestedGuid
                set matchedChats to every chat whose id ends with businessSuffix
            end if
            if (count of matchedChats) is not 1 then error "Chat unavailable or ambiguous" number -1728
            if operationName is "send" then
                send (item 3 of argv) to item 1 of matchedChats
                return "submitted"
            end if
            return "ready"
        end tell
    end timeout
end run'''


def native_messages(operation, args):
    command = ["/usr/bin/osascript", "-e", MESSAGES_SCRIPT, operation, args.get("chatGuid", ""), args.get("text", "")]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=18, check=False)
    except subprocess.TimeoutExpired:
        return {"error": "automation_timeout", "automation": "unknown"}
    except OSError:
        return {"error": "automation_unavailable", "automation": "unknown"}
    if result.returncode == 0 and result.stdout.strip() == ("submitted" if operation == "send" else "ready"):
        return {"automation": "granted", "status": "submitted" if operation == "send" else "ready"}
    # Never expose raw osascript stderr: it can contain message text.
    if "(-1743)" in result.stderr:
        return {"error": "automation_denied", "automation": "denied"}
    if "(-1712)" in result.stderr:
        return {"error": "automation_timeout", "automation": "unknown"}
    if "(-1728)" in result.stderr:
        return {"error": "chat_not_scriptable", "automation": "granted"}
    return {"error": "automation_failed", "automation": "unknown"}


def send_message(home, args):
    """Reserve each request durably before contacting Messages; never replay an uncertain send."""
    directory = home / ".local/share/openteam-imessage"
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    path = directory / "send-receipts.sqlite3"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(descriptor)
    path.chmod(0o600)
    digest = hashlib.sha256(json.dumps([args["chatGuid"], args["text"]], ensure_ascii=False).encode()).hexdigest()
    request_id = args["requestId"]
    uncertain = {"requestId": request_id, "chatGuid": args["chatGuid"], "transport": "ssh",
                 "status": "unknown", "error": "send_outcome_unknown",
                 "message": "This request was reserved or attempted. Check ChatItems and Messages before considering another send. Do not retry with a new requestId."}
    db = sqlite3.connect(path, timeout=5)
    try:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT digest,result FROM receipts WHERE id=?", (request_id,)).fetchone()
        if previous:
            db.rollback()
            if previous[0] != digest:
                return {"error": "request_id_conflict", "message": "This requestId already belongs to a different message."}
            return {**json.loads(previous[1]), "replayed": True}
        permission = check_automation()
        if "error" in permission:
            db.rollback()
            return {"transport": "ssh", "sendEnabled": True, **permission}
        db.execute("INSERT INTO receipts VALUES (?,?,?)", (request_id, digest, json.dumps(uncertain)))
        db.commit()
        outcome = native_messages("send", args)
        if "error" in outcome:
            receipt = {**uncertain, "cause": outcome["error"], "automation": outcome["automation"]}
        else:
            receipt = {"requestId": request_id, "chatGuid": args["chatGuid"], "transport": "ssh",
                       "status": "submitted", "deliveryConfirmed": False,
                       "message": "Messages accepted the send command. Delivery is not confirmed."}
        db.execute("UPDATE receipts SET result=? WHERE id=?", (json.dumps(receipt), request_id))
        db.commit()
        return receipt
    finally:
        db.close()


def execute(request, database=None, home=None, allow_send=False):
    operation, args = validate(request)
    home = Path(home or Path.home()).expanduser()
    if operation == "send" and not allow_send:
        return dict(SEND_DISABLED)
    if operation == "send_status" and not allow_send:
        return {"transport": "ssh", "sendEnabled": False, "automation": "not_checked", **SEND_DISABLED}
    database = Path(database or home / "Library/Messages/chat.db").expanduser().resolve()
    if operation in LEGACY:
        return legacy(operation, args, database)
    messages = Messages(database, home)
    try:
        if operation in {"send", "send_status"}:
            if "chatGuid" in args:
                messages.chat(args["chatGuid"])
            if operation == "send":
                return send_message(home, args)
            permission = check_automation()
            if "error" in permission:
                return {"transport": "ssh", "hostname": socket.gethostname(), "sendEnabled": True, **permission}
            return {"transport": "ssh", "hostname": socket.gethostname(), "sendEnabled": True,
                    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    **native_messages("status", args)}
        handler = {"contacts": messages.contacts_lookup}.get(operation) or getattr(messages, operation)
        result = handler(args)
        if operation == "status":
            result.update(readOnly=not allow_send, sendEnabled=allow_send, transport="ssh")
            if not allow_send:
                result["operations"] = [name for name in result["operations"] if name not in {"send", "send_status"}]
        return result
    except LookupError as error:
        return {"error": "unknown_chat", "message": str(error)}
    except subprocess.SubprocessError:
        return {"error": "attachment_unavailable", "message": "The Mac couldn't convert this image. Tell the user rather than retrying."}
    finally:
        messages.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, help="Local fixture override; never accepted from the remote request")
    parser.add_argument("--home", type=Path, help="Local fixture override for Contacts and locale; never accepted remotely")
    parser.add_argument("--allow-send", action="store_true", help="Explicit local permission to submit sends through Messages")
    parser.add_argument("--automation-preflight", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--authorize-messages", action="store_true", help="Explicitly request macOS consent; be at the Mac to click Allow")
    options = parser.parse_args()
    if options.automation_preflight:
        print(automation_permission())
        return 0
    if options.authorize_messages:
        if not options.allow_send:
            parser.error("--authorize-messages requires --allow-send")
        print("Be at the Mac or in Screen Sharing. Click Allow on the SSH → Messages consent prompt. Waiting up to 150 seconds; no message will be sent.", file=sys.stderr, flush=True)
        try:
            script = MESSAGES_SCRIPT.replace("with timeout of 10 seconds", "with timeout of 120 seconds")
            result = subprocess.run(["/usr/bin/osascript", "-e", script, "status", "", ""],
                                    capture_output=True, text=True, timeout=150, check=False)
            print(json.dumps({"automation": "granted" if result.returncode == 0 and result.stdout.strip() == "ready" else "unknown",
                              "exitCode": result.returncode}))
            return result.returncode
        except subprocess.TimeoutExpired:
            print(json.dumps({"error": "automation_consent_timeout", "message": "macOS consent did not finish within 150 seconds. Do not repeat unattended."}))
            return 1
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("Request exceeds 32 KiB")
        value = execute(json.loads(raw), options.database, options.home, options.allow_send)
        print(json.dumps(value, ensure_ascii=False))
    except (ValueError, TypeError, UnicodeError) as error:
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else ""
        print(json.dumps({"error": "invalid_request", "message": message or "Use a documented read-only operation and its arguments"}))
        return 1
    except (sqlite3.Error, OSError):
        print(json.dumps({"error": "messages_unavailable", "message": "Check the Mac SSH user's Messages database, Full Disk Access, and schema compatibility"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
