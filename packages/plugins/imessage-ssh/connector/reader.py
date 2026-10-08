#!/usr/bin/env python3
"""One read-only Messages request on stdin, one JSON result on stdout. Runs on the Mac."""
import argparse
import datetime
import json
import plistlib
from pathlib import Path
import sqlite3
import sys
import time

MAX_REQUEST = 16384
MAX_TEXT = 16000
OPERATIONS = {
    "status": set(),
    "chats": {"query", "limit", "before_id"},
    "history": {"chat_id", "limit", "before_id"},
    "search": {"query", "chat_id", "limit", "before_id"},
}


def validate(request):
    if not isinstance(request, dict) or set(request) - {"operation", "arguments"}:
        raise ValueError("Expected operation and arguments")
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ValueError("Unknown read-only operation")
    args = request.get("arguments", {})
    if not isinstance(args, dict) or set(args) - OPERATIONS[operation]:
        raise ValueError("Unsupported arguments")
    for key in ("limit", "chat_id", "before_id"):
        if key in args and (type(args[key]) is not int or not 1 <= args[key] <= (50 if key == "limit" else 2**63 - 1)):
            raise ValueError("Invalid " + key)
    if operation == "history" and "chat_id" not in args:
        raise ValueError("chat_id is required")
    if "query" in args and (not isinstance(args["query"], str) or not 1 <= len(args["query"].strip()) <= 256):
        raise ValueError("query must contain 1 to 256 characters")
    if operation == "search" and "query" not in args:
        raise ValueError("query is required")
    return operation, args


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


def timestamp(value):
    if not value:
        return None
    nanos = int(value)
    # Current Messages schemas store nanoseconds since 2001; older schemas used seconds.
    seconds = nanos / 1_000_000_000 if abs(nanos) >= 100_000_000_000 else nanos
    return (datetime.datetime(2001, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()


def execute(request, database=None):
    operation, args = validate(request)
    database = Path(database or Path.home() / "Library/Messages/chat.db").expanduser().resolve()
    db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    deadline = time.monotonic() + 10
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        if operation == "status":
            db.execute("SELECT ROWID FROM message LIMIT 1").fetchone()
            return {"readable": True, "read_only": True, "protocol_version": 1, "operations": list(OPERATIONS)}
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, help="Local fixture override; never accepted from the remote request")
    options = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("Request exceeds 16 KiB")
        value = execute(json.loads(raw), options.database)
        print(json.dumps(value, ensure_ascii=False))
    except (ValueError, TypeError, UnicodeError):
        print(json.dumps({"error": "invalid_request", "message": "Use a documented read-only operation and its arguments"}))
        return 1
    except (sqlite3.Error, OSError):
        print(json.dumps({"error": "messages_unavailable", "message": "Check the Mac SSH user's Messages database, Full Disk Access, and schema compatibility"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
