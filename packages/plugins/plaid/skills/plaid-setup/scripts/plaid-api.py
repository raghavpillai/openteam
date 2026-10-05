#!/usr/bin/env python3
"""Read selected Plaid endpoints omitted or incompletely surfaced by the pinned CLI."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

ENDPOINTS = {
    "recurring": "/transactions/recurring/get",
    "item": "/item/get",
    "holdings": "/investments/holdings/get",
    "liabilities": "/liabilities/get",
    "investment-transactions": "/investments/transactions/get",
}


def config_path():
    # Go os.UserConfigDir on macOS ignores XDG_CONFIG_HOME, as does the native CLI.
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/plaid-cli/config.json"
    explicit = os.environ.get("XDG_CONFIG_HOME")
    if explicit:
        return Path(explicit) / "plaid-cli/config.json"
    home = Path.home() / ".config/plaid-cli"
    candidate = home
    while not candidate.is_dir() and candidate != candidate.parent:
        candidate = candidate.parent
    if sys.platform == "linux" and Path("/workspace").is_dir() and not os.access(candidate, os.W_OK | os.X_OK):
        return Path("/workspace/.config/plaid-cli/config.json")
    return home / "config.json"


def credentials(config):
    if not isinstance(config, dict):
        raise ValueError("CLI config must be an object")
    environment = os.environ.get("PLAID_ENV") or config.get("env", "sandbox")
    if environment not in ("production", "sandbox"):
        raise ValueError("Environment must be production or sandbox")
    profiles = config.get("environments", {})
    if not isinstance(profiles, dict) or not isinstance(profiles.get(environment, {}), dict):
        raise ValueError("CLI environment config is invalid")
    profile = profiles.get(environment, {})
    client = os.environ.get("PLAID_CLIENT_ID") or config.get("client_id")
    secret = os.environ.get("PLAID_SECRET") or profile.get("secret")
    if not isinstance(client, str) or not isinstance(secret, str) or not client or not secret:
        raise ValueError("Configure credentials on this computer before querying")
    return environment, client, secret, profile


def select(config, args):
    environment, client, secret, profile = credentials(config)
    items = profile.get("items", [])
    if not isinstance(items, list) or any(not isinstance(i, dict) or not isinstance(i.get("item_id"), str) or not i.get("item_id") for i in items):
        raise ValueError("CLI Item config is invalid")
    if args.item:
        items = [i for i in items if args.item in (i.get("item_id"), i.get("alias"))]
        if len(items) != 1:
            raise ValueError("Select an exact existing Item ID or unique alias")
    elif not args.all and len(items) != 1:
        raise ValueError("Use --item or --all when there are multiple connections")
    if not items:
        raise ValueError("No connections in the selected environment")
    if os.environ.get("PLAID_ACCESS_TOKEN"):
        raise ValueError("Unset PLAID_ACCESS_TOKEN to query the selected saved Items")
    return environment, client, secret, items


def redact(value, secrets):
    if isinstance(value, dict):
        return {k: redact(v, secrets) for k, v in value.items()
                if k.lower() not in ("access_token", "secret", "client_id")}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
    return value


def request_raw(environment, endpoint, client, secret, extra):
    payload = {"client_id": client, "secret": secret, **extra}
    request = urllib.request.Request(
        "https://" + environment + ".plaid.com" + endpoint,
        json.dumps(payload).encode(), {"Content-Type": "application/json"}, method="POST",
    )
    status = 200
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            data = json.load(error)
        except (ValueError, OSError):
            return {"error": {"code": "INVALID_API_RESPONSE", "http_status": status}}
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"error": {"code": "NETWORK_ERROR", "message": "Plaid request failed; no automatic retry"}}
    except ValueError:
        return {"error": {"code": "INVALID_API_RESPONSE"}}
    if not isinstance(data, dict):
        return {"error": {"code": "INVALID_API_RESPONSE"}}
    if status >= 400 or data.get("error_code"):
        return {"error": {"code": data.get("error_code", "HTTP_ERROR"),
                          "type": data.get("error_type"), "message": data.get("error_message"),
                          "request_id": data.get("request_id"), "http_status": status}}
    return data


def query(environment, command, client, secret, item, dates):
    token = item.get("access_token")
    if not isinstance(token, str) or not token:
        return {"error": {"code": "MISSING_ACCESS_TOKEN", "message": "Selected Item has no token"}}
    result = request_raw(environment, ENDPOINTS[command], client, secret,
                         {"access_token": token, **dates})
    return redact(result, [client, secret, token])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=ENDPOINTS)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--item")
    group.add_argument("--all", action="store_true")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    args = parser.parse_args(argv)
    dates = {}
    if args.command == "investment-transactions":
        from datetime import date
        try:
            start = date.fromisoformat(args.start_date or "")
            end = date.fromisoformat(args.end_date or "")
            if start > end:
                raise ValueError()
        except ValueError:
            parser.error("Investment transactions require a valid start/end date range")
        dates = {"start_date": start.isoformat(), "end_date": end.isoformat()}
    elif args.start_date or args.end_date:
        parser.error("Date flags apply only to investment-transactions")
    try:
        config = json.loads(config_path().read_text())
        environment, client, secret, items = select(config, args)
    except (OSError, ValueError, TypeError) as error:
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else "CLI config unavailable or invalid"
        print(json.dumps({"error": {"code": "CONFIG_ERROR", "message": message}}))
        return 2
    results = []
    for item in items:
        data = query(environment, args.command, client, secret, item, dates)
        results.append({"item_id": item["item_id"], "institution_id": item.get("institution_id"), "data": data})
    print(json.dumps({"items": results} if args.all else results[0]["data"]))
    return 1 if any("error" in r["data"] for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
