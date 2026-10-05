#!/usr/bin/env python3
"""Create, inspect, and finish Plaid Hosted Link sessions without a local server."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("plaid_api", Path(__file__).with_name("plaid-api.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class LinkError(Exception):
    def __init__(self, code, message=None, **details):
        self.data = {"code": code, **({"message": message} if message else {}), **details}
        super().__init__(code)


def read_json(path, default=None):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        if default is not None:
            return default
        raise
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".plaid-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def session_path(config, session_id):
    if str(uuid.UUID(session_id)) != session_id:
        raise ValueError("Use the session ID returned by create")
    return config.parent / "hosted-link" / (session_id + ".json")


def fingerprint(client):
    return hashlib.sha256(client.encode()).hexdigest()


def user_id(path, env, client):
    users_path = path.parent / "hosted-link/users.json"
    key = fingerprint(client + ":" + env)
    with lock(users_path.with_suffix(".lock")):
        users = read_json(users_path, {})
        if key not in users:
            users[key] = str(uuid.uuid4())
            save_json(users_path, users)
        return users[key]


def check_profile(config, client):
    if any(not isinstance(p, dict) for p in config.get("environments", {}).values()):
        raise ValueError("Invalid CLI environment config")
    if config.get("client_id") and config["client_id"] != client and any(
            p.get("items") for p in config.get("environments", {}).values()):
        raise LinkError("PROFILE_CHANGED", "Existing Items belong to another client ID; use their original setup")


def call(env, client, secret, endpoint, payload):
    result = api.request_raw(env, endpoint, client, secret, payload)
    if "error" in result:
        values = [client, secret] + [payload.get(k, "") for k in ("access_token", "public_token", "link_token")]
        raise LinkError(**api.redact(result["error"], values))
    return result


def create(path, env, client, secret, products, lifetime):
    session_id = str(uuid.uuid4())
    payload = {"client_name": "OpenTeam", "language": "en", "country_codes": ["US"],
               "user": {"client_user_id": user_id(path, env, client)}, "products": products,
               "hosted_link": {"url_lifetime_seconds": lifetime}}
    if "transactions" in products:
        payload["transactions"] = {"days_requested": 180}
    result = call(env, client, secret, "/link/token/create", payload)
    url = result.get("hosted_link_url")
    token = result.get("link_token")
    if not isinstance(url, str) or not url.startswith("https://secure.plaid.com/") or not isinstance(token, str) or not token:
        raise LinkError("INVALID_API_RESPONSE", "Plaid did not return a Hosted Link URL and token")
    state = {"session_id": session_id, "environment": env, "client_fingerprint": fingerprint(client),
             "link_token": token, "url": url, "expiration": result.get("expiration"), "exchanges": {}}
    save_json(session_path(path, session_id), state)
    return {"session_id": session_id, "url": url, "expiration": state["expiration"], "environment": env}


def results(data):
    sessions = data.get("link_sessions", [])
    if not isinstance(sessions, list):
        raise LinkError("INVALID_API_RESPONSE")
    found = {}
    for session in sessions:
        if not isinstance(session, dict):
            raise LinkError("INVALID_API_RESPONSE")
        group = session.get("results") or {}
        if not isinstance(group, dict):
            raise LinkError("INVALID_API_RESPONSE")
        additions = group.get("item_add_results") or []
        # Legacy integrations may still receive on_success instead of results.
        legacy = session.get("on_success")
        if not additions and isinstance(legacy, dict) and legacy.get("public_token"):
            additions = [{**(legacy.get("metadata") or {}), "public_token": legacy["public_token"]}]
        if not isinstance(additions, list):
            raise LinkError("INVALID_API_RESPONSE")
        for addition in additions:
            if not isinstance(addition, dict):
                raise LinkError("INVALID_API_RESPONSE")
            token = addition.get("public_token")
            if isinstance(token, str) and token:
                found[token] = addition
    return sessions, found


def status(state, data):
    sessions, found = results(data)
    if found:
        return "ready", found
    latest = max(sessions, key=lambda s: s.get("started_at") or "", default={})
    if latest.get("finished_at") or latest.get("on_exit"):
        return "exited", found
    expiration = state.get("expiration")
    if expiration and datetime.fromisoformat(expiration.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        return "expired", found
    return "pending", found


def merge_item(path, env, client, secret, item):
    with lock(path.with_suffix(".lock")):
        before = path.read_bytes() if path.exists() else None
        config = read_json(path, {})
        current_env, current_client, _, _ = api.credentials(config)
        check_profile(config, client)
        if current_env != env or current_client != client:
            raise LinkError("PROFILE_CHANGED", "Use the original environment and client ID")
        profiles = config.setdefault("environments", {})
        profile = profiles.setdefault(env, {})
        items = profile.setdefault("items", [])
        if not isinstance(items, list) or any(not isinstance(i, dict) for i in items):
            raise ValueError("CLI Item config is invalid")
        existing = next((i for i in items if i.get("item_id") == item["item_id"]), None)
        if existing:
            if existing.get("access_token") != item["access_token"]:
                raise LinkError("ITEM_CONFLICT", "Existing Item has a different access token")
        else:
            items.append(item)
        config["client_id"] = client
        config["env"] = env
        profile["secret"] = secret
        if (path.read_bytes() if path.exists() else None) != before:
            raise LinkError("CONFIG_CHANGED", "CLI config changed during save; rerun complete")
        save_json(path, config)


def complete(path, state_path, state, found, env, client, secret):
    summaries = []
    exchanges = state["exchanges"]
    for token, metadata in found.items():
        key = hashlib.sha256(token.encode()).hexdigest()
        saved = exchanges.get(key)
        if saved and saved.get("state") == "exchange_started":
            raise LinkError("EXCHANGE_UNCERTAIN", "A previous exchange was interrupted. Do not reconnect or retry the exchange blindly.")
        if not saved:
            # Record intent before an operation that consumes a one-time token.
            exchanges[key] = {"state": "exchange_started"}
            save_json(state_path, state)
            try:
                exchanged = call(env, client, secret, "/item/public_token/exchange", {"public_token": token})
            except LinkError as error:
                if 400 <= error.data.get("http_status", 0) < 500:
                    del exchanges[key]
                    save_json(state_path, state)
                raise
            if any(not isinstance(exchanged.get(k), str) or not exchanged[k] for k in ("item_id", "access_token")):
                raise LinkError("INVALID_API_RESPONSE", "Exchange response incomplete; no automatic retry")
            institution = metadata.get("institution") or {}
            if not isinstance(institution, dict):
                institution = {}
            saved = {"state": "exchanged", "item": {"item_id": exchanged["item_id"],
                     "access_token": exchanged["access_token"], "institution_id": institution.get("institution_id"),
                     "sync_cursor": ""}}
            exchanges[key] = saved
            save_json(state_path, state)
        item = saved["item"]
        merge_item(path, env, client, secret, item)
        summaries.append(verify(env, client, secret, item))
    state["completed_items"] = summaries
    save_json(state_path, state)
    return {"session_id": state["session_id"], "status": "connected", "items": summaries}


def verify(env, client, secret, item):
    data = call(env, client, secret, "/accounts/get", {"access_token": item["access_token"]})
    accounts = data.get("accounts")
    if not isinstance(data.get("item"), dict) or data["item"].get("item_id") != item["item_id"] or not isinstance(accounts, list) or any(not isinstance(a, dict) for a in accounts):
        raise LinkError("INVALID_API_RESPONSE", "Saved Item could not be verified")
    return {"item_id": item["item_id"], "institution_id": item.get("institution_id"),
            "accounts": [{k: a.get(k) for k in ("account_id", "name", "mask", "type", "subtype")} for a in accounts]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("create", help="Create a URL to send to the user")
    start.add_argument("--products", default="transactions")
    start.add_argument("--lifetime", type=int, default=3600, help="URL lifetime in seconds (default 3600)")
    for command in ("status", "complete"):
        sub.add_parser(command).add_argument("--session", required=True)
    args = parser.parse_args(argv)
    if args.command == "create":
        products = list(dict.fromkeys(args.products.split(",")))
        if not products or any(p not in ("transactions", "investments", "liabilities", "auth") for p in products):
            parser.error("Products: transactions, investments, liabilities, auth")
        if not 60 <= args.lifetime <= 86400:
            parser.error("Lifetime must be between 60 and 86400 seconds")
    secrets = []
    try:
        path = api.config_path()
        config = read_json(path, {})
        env, client, secret, _ = api.credentials(config)
        secrets = [client, secret]
        check_profile(config, client)
        if args.command == "create":
            output = create(path, env, client, secret, products, args.lifetime)
        else:
            state_path = session_path(path, args.session)
            with lock(state_path.with_suffix(".lock")):
                state = read_json(state_path)
                if not isinstance(state.get("exchanges"), dict):
                    raise ValueError("Invalid exchange journal")
                secrets += [state.get("link_token", "")]
                if state["environment"] != env or state["client_fingerprint"] != fingerprint(client):
                    raise LinkError("PROFILE_CHANGED", "Use the environment and client ID that created this session")
                if state.get("completed_items"):
                    output = {"session_id": args.session, "status": "completed", "items": state["completed_items"]}
                    if args.command == "complete":
                        items = api.credentials(read_json(path))[3].get("items", [])
                        verified = []
                        for saved in state["exchanges"].values():
                            item = saved["item"]
                            if not any(i.get("item_id") == item["item_id"] and i.get("access_token") == item["access_token"] for i in items):
                                raise LinkError("ITEM_NOT_SAVED", "Item was removed or changed after completion")
                            verified.append(verify(env, client, secret, item))
                        output.update(status="connected", items=verified)
                else:
                    data = call(env, client, secret, "/link/token/get", {"link_token": state["link_token"]})
                    progress, found = status(state, data)
                    secrets += list(found)
                    if args.command == "complete" and found:
                        output = complete(path, state_path, state, found, env, client, secret)
                    else:
                        output = {"session_id": args.session, "status": progress, "ready_items": len(found),
                                  "expiration": state.get("expiration")}
        print(json.dumps(api.redact(output, secrets)))
        return 0
    except LinkError as error:
        print(json.dumps(api.redact({"error": error.data}, secrets)))
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"error": {"code": "LOCAL_STATE_ERROR", "message": "Config/session unavailable or invalid; check setup and session ID"}}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
