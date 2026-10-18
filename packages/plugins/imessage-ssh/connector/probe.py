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


def probe(endpoint, token, target=None):
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
            **({"X-OpenTeam-SSH-Target": target} if target else {}),
        })
        with opener.open(request, timeout=35) as response:
            result = json.loads(response.read(2_000_001))
        if "error" in result:
            raise ValueError("MCP request failed")
        return result["result"]

    def call(name, args):
        result = rpc("tools/call", {"name": name, "arguments": args})
        if result.get("isError"):
            raise ValueError("iMessage operation failed; check status and gateway configuration")
        return json.loads(result["content"][0]["text"])

    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "imessage-probe", "version": "2.0.0"}})
    tools = rpc("tools/list")["tools"]
    status = call("IMessageStatus", {})
    if not status.get("readable"):
        raise ValueError("Expected a readable Mac helper")
    activity = call("IMessageActivity", {"since": "7d", "limit": 5})
    newest = call("ChatItems", {"limit": 3})
    summary = {"tools": len(tools), "database_readable": True, "send_enabled": status.get("sendEnabled", False), "contacts_readable": status["contacts"]["readable"],
               "receiving_notice": "receivingNotice" in status, "sync_notice": "syncNotice" in status, "active_chats_7d": activity["total"], "newest_items": len(newest["items"]),
               "pagination_verified": False, "chat_read_verified": False, "search_verified": False,
               "handle_lookup_verified": False, "private_content_printed": False}
    if newest.get("nextBefore"):
        older = call("ChatItems", {"limit": 3, "before": newest["nextBefore"]})
        summary["pagination_verified"] = bool(older["items"]) and not {i["id"] for i in newest["items"]} & {i["id"] for i in older["items"]}
    for chat in activity["chats"]:
        items = call("ChatItems", {"chatGuid": chat["chatGuid"], "limit": 3})["items"]
        summary["chat_read_verified"] = bool(items) and all(i.get("chatGuid") == chat["chatGuid"] for i in items)
        if chat["handles"]:
            found = call("FindIMessageChats", {"handle": chat["handles"][0]})["chats"]
            summary["handle_lookup_verified"] = chat["chatGuid"] in {c["chatGuid"] for c in found}
        candidate = next((i for i in reversed(items) if i["kind"] == "message" and i.get("text", "").strip()), None)
        if candidate:
            found = call("SearchIMessages", {"query": candidate["text"].strip()[:32], "chatGuid": chat["chatGuid"], "limit": 5})
            summary["search_verified"] = candidate["id"] in {i["id"] for i in found["items"]}
            break
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--target", help="The Mac's user@host, when probing the multi-Mac host bridge")
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.endpoint, args.token_file.read_text().strip(), args.target), indent=2))
    except (ValueError, KeyError, OSError):
        print("Live probe failed. Check endpoint, credentials, gateway service and Mac access.", file=sys.stderr)
        sys.exit(1)
