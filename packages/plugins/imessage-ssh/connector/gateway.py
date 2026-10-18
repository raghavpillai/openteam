#!/usr/bin/env python3
"""Authenticated stateless MCP endpoint. Keeps SSH credentials on the gateway host."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading

from reader import LIMITS, LEGACY, SEND_DISABLED, validate

VERSION = "3.0.0"
MAX_RESPONSE = 72_000_000  # A 50 MB attachment, base64-encoded, plus its JSON envelope.
PROTOCOLS = ("2025-03-26", "2025-06-18", "2025-11-25")
TIME = ("an ISO-8601 time with an offset (2026-10-14T18:00:00-04:00) or a duration before now: "
        "15m, 2h, 3d or 1w")
CHAT_GUID = {"type": "string", "minLength": 1, "maxLength": 512,
             "description": "A chat's chatGuid, copied from IMessageActivity, FindIMessageChats or an earlier item."}
BEFORE = {"type": "object", "properties": {"date": {"type": "string"}, "id": {"type": "integer", "minimum": 1}},
          "required": ["date", "id"], "additionalProperties": False,
          "description": "Copy a truncated result's nextBefore ({date, id}) verbatim to get the next-older page."}
PEOPLE = "`people` maps handles that match a Contacts entry to that person's name; call people by that name."


def limit(operation):
    default, maximum = LIMITS[operation]
    return {"type": "integer", "minimum": 1, "maximum": maximum, "default": default, "description": "Max results to return."}


def tool(name, description, properties, required=()):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}


TOOLS = [
    tool("IMessageStatus",
         "Check the connection to the user's Mac and how current its Messages history is: when the newest message, the "
         "newest received message and the newest of each service (iMessage, SMS, RCS) reached the Mac, how many arrived in "
         "the last 24 hours, the Mac's time zone, whether Messages in iCloud is still downloading, and whether Contacts "
         "names are available. Call it whenever an expected message seems missing. `receivingNotice` means the Mac itself "
         "may have stopped receiving, and `syncNotice` that it is still downloading older messages from iCloud while new ones "
         "arrive normally. Other tools add these fields when they apply.", {}),
    tool("IMessageActivity",
         "List the chats that had messages in a time window, most recently active first, with message counts (tapbacks "
         "and group events don't count), "
         "participants, and each chat's latest message. This is the inbox view: use it for what's new or who texted, and "
         "to check whether something just arrived, such as a verification code, before searching. Banks and services send "
         "from changing short codes, so check here instead of reopening a thread you saw before. " + PEOPLE,
         {"since": {"type": "string", "minLength": 1, "description": "Start of the window (inclusive): " + TIME + "."},
          "until": {"type": "string", "minLength": 1, "description": "End of the window (exclusive), same formats. Omit to run up to now."},
          "limit": limit("activity")}, ["since"]),
    tool("ChatItems",
         "Read messages, newest last. Pass chatGuid to read one conversation; omit it to read the newest messages across "
         "every chat, the quickest way to see exactly what just arrived. Returns the newest page; when `truncated` is set, "
         "pass `nextBefore` as `before` for the next-older page. Each item has `text` (absent for attachments-only, unsent "
         "and undecodable items), `isFromMe`, `handle` (the other person; on a group message, the sender), `service` "
         "(iMessage, SMS or RCS), `kind` (message, unsent or group-event), `chatGuid`, `tapbacks` (reactions to it, newest "
         "last), `mentions` (handles @-mentioned in a group) and `attachments` (open one with FetchIMessageAttachment). "
         "`textLossy` marks text recovered from a rich body. To read a particular day or period, pass since and until "
         "instead of paging. " + PEOPLE,
         {"chatGuid": CHAT_GUID,
          "since": {"type": "string", "minLength": 1, "description": "Only messages at or after this time: " + TIME + "."},
          "until": {"type": "string", "minLength": 1, "description": "Only messages before this time, same formats."},
          "limit": limit("items"), "before": BEFORE}),
    tool("SearchIMessages",
         "Search message text across the whole history, or one chat with chatGuid, case-insensitively. Returns the newest "
         "matches, ordered newest last, with the same item fields as ChatItems; `total` counts every match. It matches "
         "message text only, not names, numbers or attachments: to find someone's messages, use FindContacts and "
         "FindIMessageChats. Tapbacks, group events and unsent messages are skipped. When `truncated` is set, pass `nextBefore` as `before` "
         "for older matches. To check whether a code or alert just arrived, use IMessageActivity or ChatItems without "
         "chatGuid first. " + PEOPLE,
         {"query": {"type": "string", "minLength": 1, "maxLength": 256, "description": "Text to find inside messages."},
          "chatGuid": CHAT_GUID,
          "since": {"type": "string", "minLength": 1, "description": "Only messages at or after this time: " + TIME + "."},
          "until": {"type": "string", "minLength": 1, "description": "Only messages before this time, same formats."},
          "limit": limit("text_search"), "before": BEFORE}, ["query"]),
    tool("FindIMessageChats",
         "Find conversations, most recently active first, with each chat's `chatGuid` (what ChatItems and SearchIMessages "
         "take), service, participants, latest activity and latest message. Filter by `handle` or `displayName`, or omit "
         "both to list recent chats. A one-to-one chat has no name: to find a person by name, call FindContacts first and "
         "pass one of their numbers or emails as `handle`. " + PEOPLE,
         {"handle": {"type": "string", "minLength": 1, "maxLength": 256,
                     "description": "A participant's phone number in any format, email, short code, or SMS sender name. Numbers match on their digits; sender names match case-insensitively, including part of a name."},
          "displayName": {"type": "string", "minLength": 1, "maxLength": 256,
                          "description": "Part of a group chat's name, case-insensitive."},
          "limit": limit("find_chats")}),
    tool("FetchIMessageAttachment",
         "Fetch one attachment from a message, using the message's `guid` and the attachment's `guid` from a ChatItems or "
         "SearchIMessages item. The file is saved on your computer and the result gives its `path`: open it with Read to look "
         "at it (images display inline; HEIC photos arrive as JPEG) or attach it with SendToUser. Fails for attachments over "
         "50 MB or not downloaded to the Mac (kept only in iCloud); tell the user rather than retrying.",
         {"messageGuid": {"type": "string", "minLength": 1, "maxLength": 512, "description": "The message's guid."},
          "attachmentGuid": {"type": "string", "minLength": 1, "maxLength": 512,
                             "description": "The attachment's guid, from the message's attachments list."}},
         ["messageGuid", "attachmentGuid"]),
    tool("FindContacts",
         "Look up people in the Mac's Contacts by name, or by a phone number or email to see who a handle is. Returns each "
         "match's `name`, `phones` in E.164 (pass one as FindIMessageChats `handle`), `emails`, and `unresolvedPhones` for "
         "numbers saved in a form that couldn't be normalized. `total` counts every match.",
         {"query": {"type": "string", "minLength": 1, "maxLength": 256,
                    "description": "A name or the start of name parts (\"Alex\", \"Alex Ch\"), a phone number or its last digits, or an email."},
          "limit": limit("contacts")}, ["query"]),
]
SEND_TOOLS = [
    tool("IMessageSendStatus", "Check SSH Messages Automation without sending. Optionally check that an existing chat, including a business conversation, can be resolved. A readable database alone does not establish send readiness.",
         {"chatGuid": CHAT_GUID}),
    tool("SendIMessageSSH", "Submit a user-authorized text reply to an existing Messages conversation over SSH. Copy its exact chatGuid, including any business urn:biz identifier. Requires explicit SSH sending setup and macOS Automation permission. Supply a new UUID requestId for each intended message; reuse that same ID when checking an uncertain attempt. Never retry an uncertain send with a new ID. Submitted does not mean delivered. No attachments, reactions or new conversations.",
         {"chatGuid": CHAT_GUID, "text": {"type": "string", "minLength": 1, "maxLength": 4000},
          "requestId": {"type": "string", "pattern": "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"}},
         ["chatGuid", "text", "requestId"]),
]
SEND_TOOLS[1]["annotations"].update(readOnlyHint=False, openWorldHint=True)
OPERATIONS = {"IMessageStatus": "status", "IMessageActivity": "activity", "ChatItems": "items",
              "IMessageSendStatus": "send_status", "SendIMessageSSH": "send",
              "SearchIMessages": "text_search", "FindIMessageChats": "find_chats", "FindContacts": "contacts",
              "FetchIMessageAttachment": "attachment",
              # Unlisted: the connect check of connectors packaged before these tools.
              "imessage_status": "status"}
OUTDATED = {"error": "helper_outdated", "message":
            "The Mac's Messages helper predates this tool. Reconnect the iMessage integration, or restart the OpenTeam "
            "host's Messages bridge, so it reinstalls the helper."}


class Gateway:
    def __init__(self, config):
        self.config = config
        if type(config.get("allow_send", False)) is not bool:
            raise ValueError("allow_send must be a boolean")
        target = config.get("ssh_target", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*", target):
            raise ValueError("ssh_target must be user@hostname or user@IPv4")
        for key in ("identity_file", "known_hosts_file", "token_file"):
            path = Path(config[key]).expanduser().resolve(strict=True)
            if not path.is_file():
                raise ValueError(key + " must be a file")
            if key != "known_hosts_file" and path.stat().st_mode & 0o077:
                raise ValueError(key + " must only be accessible to its owner")
            config[key] = str(path)
        self.token = Path(config["token_file"]).read_text().strip()
        if len(self.token) < 32 or any(c.isspace() for c in self.token) or not self.token.isascii():
            raise ValueError("Use a random ASCII token of at least 32 characters")
        port = config.get("ssh_port", 22)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Invalid SSH port")
        # The authorized key on the Mac forces reader.py; requests cannot select a command.
        self.command = ["ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
                        "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "ForwardAgent=no",
                        "-o", "ClearAllForwardings=yes", "-o", "UserKnownHostsFile=" + config["known_hosts_file"],
                        "-i", config["identity_file"], "-p", str(port), target, "openteam-imessage-reader"]
        self.slots = threading.BoundedSemaphore(4)

    def listed_tools(self):
        return TOOLS + (SEND_TOOLS if self.config.get("allow_send", False) else [])

    def execute(self, operation, arguments):
        request = {"operation": operation, "arguments": arguments}
        validate(request)
        if operation in {"send", "send_status"} and not self.config.get("allow_send", False):
            return dict(SEND_DISABLED)
        if not self.slots.acquire(blocking=False):
            return {"error": "busy", "message": "The iMessage gateway is busy; try again later"}
        try:
            # File-backed output prevents a bad remote endpoint from filling gateway memory.
            with tempfile.TemporaryFile() as output:
                # Attachments carry file bytes (up to 50 MB, base64-encoded) and may need an image conversion first.
                large = operation == "attachment"
                try:
                    result = subprocess.run(self.command, input=json.dumps(request, ensure_ascii=False).encode(), stdout=output,
                                            stderr=subprocess.DEVNULL, timeout=90 if large else 25, check=False)
                except (subprocess.TimeoutExpired, OSError):
                    if operation == "send":
                        return {"error": "send_outcome_unknown", "requestId": arguments["requestId"],
                                "message": "SSH did not return a send receipt. Reuse this requestId; never retry with a new ID. Check ChatItems and Messages."}
                    return {"error": "ssh_unavailable", "message": "Mac SSH did not complete. Check connectivity, host key, credentials, and the installed helper"}
                output.seek(0)
                cap = MAX_RESPONSE if large else 2_000_000
                raw = output.read(cap + 1)
                if len(raw) > cap:
                    return {"error": "response_too_large"}
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    value = None
                if not isinstance(value, dict):
                    return {"error": "ssh_unavailable", "message": "SSH returned no valid helper result; check the dedicated key and forced command"}
                if result.returncode and "error" not in value:
                    return {"error": "ssh_failed"}
                # A protocol 1 helper rejects newer operations with its generic message.
                if (operation not in LEGACY and operation != "status" and value.get("error") == "invalid_request"
                        and value.get("message") == "Use a documented read-only operation and its arguments"):
                    return dict(OUTDATED)
                return value
        finally:
            self.slots.release()

    def rpc(self, request):
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        if "id" not in request:
            return None
        response = {"jsonrpc": "2.0", "id": request["id"]}
        method = request["method"]
        params = request.get("params", {})
        if not isinstance(params, dict):
            return {**response, "error": {"code": -32602, "message": "Invalid params"}}
        if method == "initialize":
            requested = params.get("protocolVersion")
            result = {"protocolVersion": requested if requested in PROTOCOLS else PROTOCOLS[-1],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "openteam-imessage-ssh", "version": VERSION}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.listed_tools()}
        elif method == "tools/call":
            name = params.get("name")
            if not isinstance(name, str) or name not in OPERATIONS:
                return {**response, "error": {"code": -32602, "message": "Unknown read-only tool"}}
            try:
                value = self.execute(OPERATIONS[name], params.get("arguments", {}))
            except ValueError as error:
                # Validation messages are fixed text about the arguments, never Mac data.
                value = {"error": "invalid_arguments", "message": str(error)}
            except TypeError:
                value = {"error": "invalid_arguments", "message": "Use the tool's declared input schema"}
            result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": "error" in value}
        else:
            return {**response, "error": {"code": -32601, "message": "Method not found"}}
        return {**response, "result": result}


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenTeam-iMessage/1"

    def log_message(self, *_args):
        pass  # Never log message contents, authorization, or query parameters.

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def respond(self, status, value=None):
        data = json.dumps(value, ensure_ascii=False).encode() if value is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/mcp":
            return self.respond(404)
        # This machine-to-machine endpoint does not accept browser-origin requests.
        if self.headers.get("Origin"):
            return self.respond(403)
        supplied = self.headers.get("Authorization", "").encode()
        expected = ("Bearer " + self.server.gateway.token).encode()
        if not hmac.compare_digest(supplied, expected):
            return self.respond(401, {"error": "unauthorized"})
        if self.headers.get("Transfer-Encoding"):
            return self.respond(400)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32768:
                return self.respond(413)
            request = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeError, TimeoutError):
            return self.respond(400)
        gateway = self.server.gateway
        if hasattr(gateway, "for_target"):
            try:
                gateway = gateway.for_target(self.headers.get("X-OpenTeam-SSH-Target", ""))
            except ValueError:
                return self.respond(400, {"error": "invalid_ssh_target"})
        response = gateway.rpc(request)
        self.respond(202 if response is None else 200, response)

    def do_GET(self):
        self.respond(405)

    do_DELETE = do_GET


def make_server(gateway, bind="127.0.0.1", port=8799):
    server = ThreadingHTTPServer((bind, port), Handler)
    server.daemon_threads = True
    server.gateway = gateway
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    gateway = Gateway(json.loads(args.config.read_text()))
    server = make_server(gateway, args.bind, args.port)
    print("iMessage gateway listening on %s:%s/mcp" % server.server_address, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
