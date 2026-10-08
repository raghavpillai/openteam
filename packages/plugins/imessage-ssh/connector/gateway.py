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

from reader import validate

VERSION = "1.0.0"
PROTOCOLS = ("2025-03-26", "2025-06-18", "2025-11-25")
LIMIT = {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}
ID = {"type": "integer", "minimum": 1}
QUERY = {"type": "string", "minLength": 1, "maxLength": 256}


def tool(name, description, properties, required=()):
    return {"name": "imessage_" + name, "description": description,
            "inputSchema": {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}


TOOLS = [
    tool("status", "Check SSH connectivity and read access to the Mac's local Messages database.", {}),
    tool("chats", "Find chats by display name, phone number, or email. Names may be absent; this does not query Contacts. Page with next_before_id.", {"query": QUERY, "limit": LIMIT, "before_id": ID}),
    tool("history", "Read messages in a chat returned by imessage_chats, newest message ID first. Page with next_before_id. Some rich bodies are lossy or unavailable.", {"chat_id": ID, "limit": LIMIT, "before_id": ID}, ["chat_id"]),
    tool("search", "Search decoded message text. Scans at most 500 rows per call. Follow next_before_id even when messages is empty; only complete=true means the end of history.", {"query": QUERY, "chat_id": ID, "limit": LIMIT, "before_id": ID}, ["query"]),
]


class Gateway:
    def __init__(self, config):
        self.config = config
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

    def execute(self, operation, arguments):
        request = {"operation": operation, "arguments": arguments}
        validate(request)
        if not self.slots.acquire(blocking=False):
            return {"error": "busy", "message": "The iMessage gateway is busy; try again later"}
        try:
            # File-backed output prevents a bad remote endpoint from filling gateway memory.
            with tempfile.TemporaryFile() as output:
                try:
                    result = subprocess.run(self.command, input=json.dumps(request).encode(), stdout=output,
                                            stderr=subprocess.DEVNULL, timeout=25, check=False)
                except (subprocess.TimeoutExpired, OSError):
                    return {"error": "ssh_unavailable", "message": "Mac SSH did not complete. Check connectivity, host key, credentials, and the installed helper"}
                output.seek(0)
                raw = output.read(2_000_001)
                if len(raw) > 2_000_000:
                    return {"error": "response_too_large"}
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    value = None
                if not isinstance(value, dict):
                    return {"error": "ssh_unavailable", "message": "SSH returned no valid helper result; check the dedicated key and forced command"}
                if result.returncode and "error" not in value:
                    return {"error": "ssh_failed"}
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
            result = {"tools": TOOLS}
        elif method == "tools/call":
            name = params.get("name")
            if not isinstance(name, str) or name not in {t["name"] for t in TOOLS}:
                return {**response, "error": {"code": -32602, "message": "Unknown read-only tool"}}
            try:
                value = self.execute(name.removeprefix("imessage_"), params.get("arguments", {}))
            except (ValueError, TypeError):
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
        response = self.server.gateway.rpc(request)
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
