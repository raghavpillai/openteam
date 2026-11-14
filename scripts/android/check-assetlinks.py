#!/usr/bin/env python3
"""Validate an Android Digital Asset Links file before publishing it."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FINGERPRINT = re.compile(r"^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$", re.IGNORECASE)
HOST = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
PLACEHOLDER = re.compile(r"(?:REPLACE_WITH|YOUR_|<[^>]+>|\$\{)")


def validate_host(value: str) -> None:
    host = value.strip().lower().rstrip(".")
    if not HOST.fullmatch(host) or host in {"localhost"} or host.endswith(".local"):
        raise ValueError("host must be a public DNS hostname without a scheme, path, port, or credentials")


def validate(path: Path, package_name: str, template: bool) -> int:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"assetlinks: {error}", file=sys.stderr)
        return 2
    if not isinstance(value, list) or not value:
        print("assetlinks: expected a non-empty JSON array", file=sys.stderr)
        return 2
    for index, statement in enumerate(value):
        if not isinstance(statement, dict):
            print(f"assetlinks[{index}]: expected an object", file=sys.stderr)
            return 2
        relations = statement.get("relation")
        target = statement.get("target")
        if not isinstance(relations, list) or "delegate_permission/common.handle_all_urls" not in relations:
            print(f"assetlinks[{index}]: missing handle_all_urls relation", file=sys.stderr)
            return 2
        if not isinstance(target, dict) or target.get("namespace") != "android_app":
            print(f"assetlinks[{index}]: target namespace must be android_app", file=sys.stderr)
            return 2
        if target.get("package_name") != package_name:
            print(f"assetlinks[{index}]: package_name must be {package_name}", file=sys.stderr)
            return 2
        fingerprints = target.get("sha256_cert_fingerprints")
        if not isinstance(fingerprints, list) or not fingerprints:
            print(f"assetlinks[{index}]: at least one certificate fingerprint is required", file=sys.stderr)
            return 2
        for fingerprint in fingerprints:
            valid_fingerprint = isinstance(fingerprint, str) and bool(FINGERPRINT.fullmatch(fingerprint))
            valid_template = template and isinstance(fingerprint, str) and bool(PLACEHOLDER.search(fingerprint))
            if not (valid_fingerprint or valid_template):
                print(f"assetlinks[{index}]: invalid SHA-256 certificate fingerprint", file=sys.stderr)
                return 2
    print(f"assetlinks: valid ({path})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--package", default="com.openteam.android")
    parser.add_argument("--host")
    parser.add_argument("--template", action="store_true")
    args = parser.parse_args()
    try:
        if args.host:
            validate_host(args.host)
    except ValueError as error:
        print(f"assetlinks: {error}", file=sys.stderr)
        return 2
    return validate(args.path, args.package, args.template)


if __name__ == "__main__":
    raise SystemExit(main())
