#!/usr/bin/env python3
"""Verify the real MCP -> SSH -> Messages path without printing message content."""
import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def probe(endpoint, token):
    url = urlsplit(endpoint)
    if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise ValueError("Use a credential-free HTTP(S) MCP endpoint")
    opener = build_opener(NoRedirects())
    sequence = 0

    def rpc(method, params=None):
        nonlocal sequence
        sequence += 1
        data = {"jsonrpc": "2.0", "id": sequence, "method": method, "params": params or {}}
        request = Request(endpoint, data=json.dumps(data).encode(), headers={
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer " + token,
        })
        with opener.open(request, timeout=35) as response:
            result = json.loads(response.read(2_000_001))
        if "error" in result:
            raise ValueError("MCP request failed")
        return result["result"]

    def call(name, args):
        result = rpc("tools/call", {"name": "imessage_" + name, "arguments": args})
        if result.get("isError"):
            raise ValueError("iMessage operation failed; check status and gateway configuration")
        return json.loads(result["content"][0]["text"])

    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "imessage-probe", "version": "1.0.0"}})
    tools = rpc("tools/list")["tools"]
    status = call("status", {})
    if not status.get("readable") or not status.get("read_only"):
        raise ValueError("Expected a readable, read-only Mac helper")
    chats = call("chats", {"limit": 5})["chats"]
    summary = {"tools": len(tools), "database_readable": True, "chats_returned": len(chats),
               "history_rows": 0, "decoded_bodies": 0, "pagination_verified": False,
               "search_verified": False, "private_content_printed": False}
    for chat in chats:
        history = call("history", {"chat_id": chat["id"], "limit": 3})
        messages = history["messages"]
        summary["history_rows"] = len(messages)
        summary["decoded_bodies"] = sum(bool(m["text"]) for m in messages)
        if history["next_before_id"]:
            second = call("history", {"chat_id": chat["id"], "limit": 2, "before_id": history["next_before_id"]})
            first_ids = {m["id"] for m in messages}
            summary["pagination_verified"] = bool(second["messages"]) and not first_ids.intersection(m["id"] for m in second["messages"])
        candidate = next((m for m in messages if m["kind"] == "message" and m["text"] and m["text"].strip()), None)
        if candidate:
            found = call("search", {"query": candidate["text"].strip()[:32], "chat_id": chat["id"], "limit": 5})
            summary["search_verified"] = candidate["id"] in {m["id"] for m in found["messages"]}
            break
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.endpoint, args.token_file.read_text().strip()), indent=2))
    except (ValueError, KeyError, OSError):
        print("Live probe failed. Check endpoint, credentials, gateway service and Mac access.", file=sys.stderr)
        sys.exit(1)
