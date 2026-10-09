#!/usr/bin/env python3
"""MCP stdio adapter in the OpenTeam computer; SSH credentials stay on the host."""
import json
import os
from pathlib import Path
import sys
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

from bridge import validate_target


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class Client:
    def __init__(self, target, config_path=None):
        self.target = validate_target(target)
        path = Path(config_path or Path.home() / ".config/openteam/imessage-bridge.json")
        if path.stat().st_mode & 0o077:
            raise ValueError("Internal bridge configuration must be private")
        self.config = json.loads(path.read_text())
        self.http = build_opener(ProxyHandler({}), NoRedirect())

    def rpc(self, request):
        req = Request(self.config["endpoint"], data=json.dumps(request).encode(), headers={
            "Authorization": "Bearer " + self.config["token"], "Content-Type": "application/json",
            "X-OpenTeam-SSH-Target": self.target})
        with self.http.open(req, timeout=55) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Bridge response too large")
        return json.loads(raw) if raw else None

    def check(self):
        response = self.rpc({"jsonrpc": "2.0", "id": "connect-check", "method": "tools/call",
                             "params": {"name": "imessage_status", "arguments": {}}})
        result = response.get("result", {})
        if result.get("isError") or "error" in response:
            raise ValueError("SSH or Messages access failed. Verify host SSH access and Mac disk permissions.")
        content = result.get("content", [])
        if not any(json.loads(item["text"]).get("readable") for item in content if item.get("type") == "text"):
            raise ValueError("Mac did not confirm Messages access")


def main():
    try:
        client = Client(os.environ.get("IMESSAGE_SSH_TARGET", ""))
        client.check()  # Marketplace Connect verifies actual Messages access before tools discovery.
    except Exception:
        print("iMessage connection failed: verify user@host, host SSH credentials/known_hosts, Mac disk permissions, "
              "and the deployment's internal Messages bridge (connector/SETUP.md).", file=sys.stderr)
        return 1
    for raw in sys.stdin.buffer:
        request = None
        try:
            if len(raw) > 32768:
                raise ValueError("Request too large")
            request = json.loads(raw)
            response = client.rpc(request)
        except Exception:
            response = {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None,
                        "error": {"code": -32603, "message": "Messages bridge unavailable; reconnect and test SSH access"}}
        if response is not None:
            print(json.dumps(response), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
