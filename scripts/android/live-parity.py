#!/usr/bin/env python3
"""Run deterministic Android live-server parity checks.

Contract mode is the default and never opens a network connection. Live mode
uses credentials supplied through the environment for the duration of one
process and never writes or prints them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import Request, urlopen


API_PREFIX = "/api/v0"
PARITY_CONTENT = "OpenTeam parity harness message"
PARITY_ATTACHMENT = b"OpenTeam parity attachment\n"
SENSITIVE_KEY = re.compile(
    r"(authorization|credential|password|passwd|secret|token|cookie|api.?key)",
    re.IGNORECASE,
)


class HarnessFailure(RuntimeError):
    def __init__(self, check: str, detail: str):
        super().__init__(f"{check}: {detail}")
        self.check = check
        self.detail = detail


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HarnessFailure("response", f"invalid JSON response ({error})") from error


def redacted(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redacted(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redacted(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", value, flags=re.IGNORECASE)
    return value


def response_detail(response: Response) -> str:
    try:
        payload = redacted(response.json())
        if isinstance(payload, Mapping) and isinstance(payload.get("error"), Mapping):
            error = payload["error"]
            return str(error.get("message") or error.get("code") or payload)
        return str(payload)
    except HarnessFailure:
        text = response.body.decode("utf-8", errors="replace").strip()
        return text[:240] or "empty response body"


def require_status(check: str, response: Response, expected: set[int]) -> Response:
    if response.status not in expected:
        raise HarnessFailure(
            check,
            f"expected HTTP {sorted(expected)}, got {response.status}: {response_detail(response)}",
        )
    return response


def require_object(check: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HarnessFailure(check, f"expected JSON object, got {type(payload).__name__}")
    return payload


def require_list(check: str, payload: Any, key: str) -> list[Any]:
    value = payload.get(key) if isinstance(payload, Mapping) else None
    if not isinstance(value, list):
        raise HarnessFailure(check, f"expected JSON array field {key!r}")
    return value


def path_for(*parts: str) -> str:
    return "/".join([API_PREFIX.rstrip("/"), *(quote(part, safe="") for part in parts)])


class Client:
    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        raise NotImplementedError


class HttpClient(Client):
    def __init__(self, server: str, token: str | None):
        self.server = server.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        request_headers = {"Accept": "application/json"}
        if self.token:
            request_headers["Authorization"] = f"Bearer {self.token}"
        request_headers.update(headers or {})
        encoded_body: bytes | None = None
        if body is not None:
            if isinstance(body, bytes):
                encoded_body = body
            else:
                encoded_body = json.dumps(body, separators=(",", ":")).encode("utf-8")
                request_headers.setdefault("Content-Type", "application/json")
        request = Request(
            self.server + path,
            data=encoded_body,
            headers=request_headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=35) as response:
                return Response(
                    response.status,
                    {key.lower(): value for key, value in response.headers.items()},
                    response.read(),
                )
        except HTTPError as error:
            return Response(
                error.code,
                {key.lower(): value for key, value in error.headers.items()},
                error.read(),
            )
        except (URLError, TimeoutError, OSError) as error:
            raise HarnessFailure(f"{method} {path}", f"network failure: {error}") from error


class ContractClient(Client):
    """A deterministic server-shaped transport for credential-free checks."""

    def __init__(self):
        self.asset_id = "a" * 64
        self.message_id = "message-parity"
        self.client_id = ""
        self.calls: list[tuple[str, str]] = []

    @staticmethod
    def _json(payload: Any, status: int = 200, headers: Mapping[str, str] | None = None) -> Response:
        return Response(
            status,
            headers or {"content-type": "application/json"},
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        )

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        self.calls.append((method, path))
        split = urlsplit(path)
        route = split.path.replace(API_PREFIX, "/api", 1)
        query = parse_qs(split.query)
        payload = body if isinstance(body, Mapping) else {}

        if method == "GET" and route == "/api/auth/config":
            return self._json({"mode": "required"})
        if method == "POST" and route == "/api/auth/login":
            if payload.get("username") != "contract-user" or not payload.get("password"):
                return self._json({"error": {"code": "invalid_login", "message": "invalid fixture"}}, 401)
            return self._json(
                {"user": {"id": "contract-user", "name": "Contract User"}},
                headers={"content-type": "application/json", "set-auth-token": "contract-token"},
            )
        if method == "GET" and route == "/api/client-bootstrap":
            return self._json(
                {
                    "channels": [
                        {
                            "id": "contract-channel",
                            "name": "Contract channel",
                            "kind": "group",
                            "hiddenFromSidebar": False,
                        }
                    ],
                    "bots": [],
                }
            )
        if method == "GET" and route.endswith("/history"):
            return self._json(
                {
                    "channelId": "contract-channel",
                    "messages": [
                        {
                            "id": "message-history",
                            "clientId": None,
                            "sequence": "1",
                            "channelId": "contract-channel",
                            "sender": "bot",
                            "content": "history",
                            "createdAt": "2026-01-01T00:00:00Z",
                            "metadata": {},
                        }
                    ],
                    "beforeSequence": None,
                    "hasMore": False,
                }
            )
        if method == "GET" and route == "/api/events/poll":
            after = query.get("after", ["0"])[0]
            events = (
                [
                    {
                        "sequence": "2",
                        "topic": "message.created",
                        "entityId": self.message_id,
                        "payload": {"clientId": self.client_id},
                    }
                ]
                if after == "0"
                else []
            )
            return self._json({"events": events})
        if method == "GET" and route == "/api/events":
            return Response(
                200,
                {"content-type": "text/event-stream"},
                b'event: product\ndata: {"sequence":"2","topic":"message.created"}\n\n',
            )
        if method == "POST" and route.endswith("/messages"):
            self.client_id = str(payload.get("clientId", ""))
            return self._json(
                {
                    "message": {
                        "id": self.message_id,
                        "clientId": self.client_id,
                        "sequence": "2",
                        "channelId": "contract-channel",
                        "sender": "user",
                        "content": payload.get("content", ""),
                        "createdAt": "2026-01-01T00:00:00Z",
                        "metadata": {},
                    }
                },
                status=202,
            )
        if method == "GET" and "/message-deliveries/" in route:
            return self._json(
                {
                    "clientId": route.rsplit("/", 1)[-1],
                    "status": "accepted",
                    "message": {
                        "id": self.message_id,
                        "sequence": "2",
                        "channelId": "contract-channel",
                        "sender": "user",
                        "content": PARITY_CONTENT,
                        "createdAt": "2026-01-01T00:00:00Z",
                    },
                }
            )
        if method == "POST" and route == "/api/assets":
            return self._json(
                {
                    "assetId": self.asset_id,
                    "fileName": "openteam-parity.txt",
                    "mimeType": "text/plain",
                    "byteSize": len(PARITY_ATTACHMENT),
                    "kind": "file",
                },
                status=201,
            )
        if method == "GET" and route == f"/api/assets/{self.asset_id}":
            return Response(200, {"content-type": "text/plain"}, PARITY_ATTACHMENT)
        if method == "GET" and route == "/api/plugin-oauth/callback":
            return Response(400, {"content-type": "text/html"}, b"<main>stale</main>")

        return self._json(
            {"error": {"code": "contract_route_missing", "message": f"{method} {route}"}},
            status=500,
        )


def json_request(client: Client, check: str, method: str, path: str, body: Any = None) -> dict[str, Any]:
    response = require_status(check, client.request(method, path, body), set(range(200, 300)))
    return require_object(check, response.json())


def run_harness(client: Client, *, live: bool, server: str) -> list[str]:
    results: list[str] = []

    config = json_request(client, "auth config", "GET", f"{API_PREFIX}/auth/config")
    mode = config.get("mode")
    if mode not in {"required", "disabled"}:
        raise HarnessFailure("auth config", f"unexpected auth mode {mode!r}")
    results.append(f"PASS auth config ({mode})")

    if live and mode == "required":
        username = os.environ.get("OPENTEAM_PARITY_USERNAME", "")
        credential = os.environ.get("OPENTEAM_PARITY_CREDENTIAL", "")
        login = require_status(
            "authenticated login",
            client.request(
                "POST",
                f"{API_PREFIX}/auth/login",
                {"username": username, "password": credential, "rememberMe": True},
            ),
            {200},
        )
        token = next((value for key, value in login.headers.items() if key.lower() == "set-auth-token"), "")
        if not token:
            raise HarnessFailure("authenticated login", "response did not include set-auth-token")
        if isinstance(client, HttpClient):
            client.token = token
        results.append("PASS authenticated login")
    elif not live:
        login = require_status(
            "contract login",
            client.request(
                "POST",
                f"{API_PREFIX}/auth/login",
                {"username": "contract-user", "password": "contract-password", "rememberMe": True},
            ),
            {200},
        )
        if not login.headers.get("set-auth-token"):
            raise HarnessFailure("contract login", "contract response omitted set-auth-token")
        results.append("PASS contract login")

    bootstrap = json_request(client, "client bootstrap", "GET", f"{API_PREFIX}/client-bootstrap")
    channels = require_list("client bootstrap", bootstrap, "channels")
    if not channels:
        raise HarnessFailure("client bootstrap", "server returned no channels")
    requested_channel = os.environ.get("OPENTEAM_PARITY_CHANNEL_ID", "")
    candidates = [item for item in channels if isinstance(item, Mapping) and item.get("id")]
    channel = next((item for item in candidates if item.get("id") == requested_channel), None) if requested_channel else None
    channel = channel or sorted(candidates, key=lambda item: str(item["id"]))[0]
    channel_id = str(channel["id"])
    results.append(f"PASS client bootstrap (channel {channel_id})")

    history_path = f"{path_for('channels', channel_id, 'history')}?limit=60"
    history = json_request(client, "history pagination", "GET", history_path)
    messages = require_list("history pagination", history, "messages")
    before = [
        str(item.get("sequence"))
        for item in messages
        if isinstance(item, Mapping) and str(item.get("sequence", "")).isdigit()
    ]
    results.append(f"PASS history pagination ({len(messages)} messages)")

    client_id = os.environ.get("OPENTEAM_PARITY_CLIENT_ID")
    if not client_id:
        digest = hashlib.sha256(f"{server}|{channel_id}".encode("utf-8")).hexdigest()[:24]
        client_id = f"openteam-parity-{digest}"
    attachment_response = require_status(
        "attachment upload",
        client.request(
            "POST",
            f"{API_PREFIX}/assets",
            PARITY_ATTACHMENT,
            headers={"Content-Type": "text/plain", "X-File-Name": "openteam-parity.txt"},
        ),
        {201},
    )
    attachment = require_object("attachment upload", attachment_response.json())
    asset_id = str(attachment.get("assetId", ""))
    if not re.fullmatch(r"[a-f0-9]{64}", asset_id):
        raise HarnessFailure("attachment upload", "response did not contain a valid assetId")
    results.append("PASS attachment upload")

    downloaded = require_status(
        "attachment download",
        client.request("GET", f"{API_PREFIX}/assets/{asset_id}"),
        {200},
    )
    if downloaded.body != PARITY_ATTACHMENT:
        raise HarnessFailure("attachment download", "downloaded bytes did not match upload bytes")
    results.append("PASS attachment download")

    send = require_status(
        "message send",
        client.request(
            "POST",
            path_for("channels", channel_id, "messages"),
            {
                "content": PARITY_CONTENT,
                "clientId": client_id,
                "attachments": [
                    {
                        "assetId": asset_id,
                        "fileName": "openteam-parity.txt",
                        "mimeType": "text/plain",
                        "byteSize": len(PARITY_ATTACHMENT),
                        "kind": "file",
                    }
                ],
            },
        ),
        {200, 202},
    )
    sent = require_object("message send", send.json())
    message = sent.get("message", sent)
    if not isinstance(message, Mapping) or not message.get("id"):
        raise HarnessFailure("message send", "response did not contain a message id")
    results.append("PASS message send")

    event_cursor = "0"
    event_poll = json_request(
        client,
        "long-poll sync",
        "GET",
        f"{API_PREFIX}/events/poll?{urlencode({'after': event_cursor, 'waitMs': '0'})}",
    )
    events = require_list("long-poll sync", event_poll, "events")
    sequences = [
        str(event.get("sequence"))
        for event in events
        if isinstance(event, Mapping) and str(event.get("sequence", "")).isdigit()
    ]
    next_cursor = max(sequences, key=lambda value: (len(value), value)) if sequences else event_cursor
    reconnect = json_request(
        client,
        "reconnect sync",
        "GET",
        f"{API_PREFIX}/events/poll?{urlencode({'after': next_cursor, 'waitMs': '0'})}",
    )
    repeated = [
        str(event.get("sequence"))
        for event in require_list("reconnect sync", reconnect, "events")
        if isinstance(event, Mapping) and str(event.get("sequence", "")).isdigit()
    ]
    if any((len(value), value) <= (len(next_cursor), next_cursor) for value in repeated):
        raise HarnessFailure("reconnect sync", f"server replayed an event at or before cursor {next_cursor}")
    results.append(f"PASS long-poll/reconnect sync ({len(events)} events from cursor {event_cursor})")

    delivery_path = path_for("channels", channel_id, "message-deliveries", client_id)
    delivery = json_request(client, "delivery reconciliation", "GET", delivery_path)
    status = str(delivery.get("status", "")).lower()
    if status not in {"accepted", "pending", "processing", "rejected", "failed", "unknown_durability", "not_found"}:
        raise HarnessFailure("delivery reconciliation", f"unexpected delivery status {status!r}")
    if status == "not_found":
        raise HarnessFailure("delivery reconciliation", "sent clientId was not found by delivery lookup")
    results.append(f"PASS delivery reconciliation ({status})")

    callback_url = os.environ.get("OPENTEAM_PARITY_OAUTH_CALLBACK_URL", "").strip()
    if live and callback_url:
        callback = urlsplit(callback_url)
        server_origin = urlsplit(server)
        if (
            callback.scheme != server_origin.scheme
            or callback.netloc != server_origin.netloc
            or callback.path.rstrip("/") != f"{API_PREFIX}/plugin-oauth/callback"
            or not callback.query
        ):
            raise HarnessFailure(
                "OAuth callback",
                "OPENTEAM_PARITY_OAUTH_CALLBACK_URL must target the configured server callback path",
            )
        oauth = require_status(
            "OAuth callback",
            client.request("GET", callback.path + "?" + callback.query),
            {200, 400},
        )
        results.append(f"PASS OAuth callback ({oauth.status})")
    else:
        oauth_path = (
            f"{API_PREFIX}/plugin-oauth/callback?"
            + urlencode({"connectionId": "parity-invalid", "code": "parity-code", "state": "parity-state"})
        )
        oauth = require_status("OAuth callback contract", client.request("GET", oauth_path), {400})
        if b"stale" not in oauth.body.lower() and b"failed" not in oauth.body.lower():
            raise HarnessFailure("OAuth callback contract", "invalid synthetic callback was not rejected as stale/failed")
        results.append("PASS OAuth callback rejection")

    if isinstance(client, ContractClient):
        expected_routes = {
            ("GET", "/api/v0/auth/config"),
            ("POST", "/api/v0/auth/login"),
            ("GET", "/api/v0/client-bootstrap"),
            ("GET", "/api/v0/events/poll?after=0&waitMs=0"),
            ("GET", "/api/v0/plugin-oauth/callback?connectionId=parity-invalid&code=parity-code&state=parity-state"),
        }
        actual = set(client.calls)
        if not expected_routes.issubset(actual):
            missing = sorted(expected_routes - actual)
            raise HarnessFailure("contract route coverage", f"missing calls: {missing}")
        results.append(f"PASS contract route coverage ({len(client.calls)} requests)")

    return results


def live_configuration() -> tuple[str, str, str]:
    server = os.environ.get("OPENTEAM_PARITY_SERVER", "").strip().rstrip("/")
    username = os.environ.get("OPENTEAM_PARITY_USERNAME", "")
    credential = os.environ.get("OPENTEAM_PARITY_CREDENTIAL", "")
    if not server or not username or not credential:
        raise HarnessFailure(
            "live configuration",
            "set OPENTEAM_PARITY_SERVER, OPENTEAM_PARITY_USERNAME, and OPENTEAM_PARITY_CREDENTIAL",
        )
    parsed = urlsplit(server)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HarnessFailure("live configuration", "server must be an HTTP(S) origin without credentials, query, or fragment")
    return server, username, credential


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("contract", "live"),
        default=os.environ.get("OPENTEAM_PARITY_MODE", "contract"),
        help="contract performs no network I/O; live uses environment-provided credentials",
    )
    parser.add_argument("--contract", action="store_true", help="alias for --mode contract")
    args = parser.parse_args()
    if args.contract:
        args.mode = "contract"

    try:
        if args.mode == "contract":
            server = "https://contract.invalid.example"
            results = run_harness(ContractClient(), live=False, server=server)
        else:
            server, _, _ = live_configuration()
            client = HttpClient(server, None)
            results = run_harness(client, live=True, server=server)
    except HarnessFailure as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1

    print(f"OpenTeam live parity harness: {args.mode}")
    for result in results:
        print(result)
    print(f"PASS all checks ({len(results)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
