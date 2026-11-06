#!/usr/bin/env python3
"""Validate the Android parity matrix and render a reviewable Markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


REQUIRED_FIELDS = ("id", "area", "iosSchemes", "androidChecks", "status", "owner", "risk", "notes")
STATUSES = {"covered", "scaffolded", "planned", "blocked"}
RISKS = {"low", "medium", "high", "critical"}
BLOCKER_STATUSES = {"pending", "planned", "blocked"}
REQUIRED_BLOCKER_FIELDS = ("id", "status", "owner", "reason", "impact")


def load_matrix(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        matrix = json.load(handle)
    if not isinstance(matrix, dict) or not isinstance(matrix.get("cases"), list):
        raise ValueError("matrix must be an object with a cases array")
    return matrix


def validate(matrix: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    cases = matrix["cases"]
    ids = [case.get("id") for case in cases if isinstance(case, dict)]
    duplicate_ids = sorted(case_id for case_id, count in Counter(ids).items() if count > 1 and case_id)
    errors.extend(f"duplicate case id: {case_id}" for case_id in duplicate_ids)

    blockers = matrix.get("releaseBlockers", [])
    if not isinstance(blockers, list):
        errors.append("releaseBlockers must be a list")
        blockers = []
    blocker_ids = [item.get("id") for item in blockers if isinstance(item, dict)]
    duplicate_blockers = sorted(item_id for item_id, count in Counter(blocker_ids).items() if count > 1 and item_id)
    errors.extend(f"duplicate release blocker id: {item_id}" for item_id in duplicate_blockers)
    for index, blocker in enumerate(blockers):
        prefix = f"releaseBlocker[{index}]"
        if not isinstance(blocker, dict):
            errors.append(f"{prefix} must be an object")
            continue
        for field in REQUIRED_BLOCKER_FIELDS:
            if field not in blocker or blocker[field] in (None, "", []):
                errors.append(f"{prefix} missing {field}")
        if blocker.get("status") not in BLOCKER_STATUSES:
            errors.append(f"{prefix} has unsupported status {blocker.get('status')!r}")

    for field in ("latestValidation", "compileNotes"):
        if field in matrix and not isinstance(matrix[field], dict):
            errors.append(f"{field} must be an object")
    follow_up = matrix.get("followUpEvidence", [])
    if not isinstance(follow_up, list):
        errors.append("followUpEvidence must be a list")

    for index, case in enumerate(cases):
        prefix = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{prefix} must be an object")
            continue
        for field in REQUIRED_FIELDS:
            if field not in case or case[field] in (None, "", []):
                errors.append(f"{prefix} missing {field}")
        if case.get("status") not in STATUSES:
            errors.append(f"{prefix} has unsupported status {case.get('status')!r}")
        if case.get("risk") not in RISKS:
            errors.append(f"{prefix} has unsupported risk {case.get('risk')!r}")
        for field in ("iosSchemes", "androidChecks"):
            if field in case and (not isinstance(case[field], list) or not all(isinstance(item, str) for item in case[field])):
                errors.append(f"{prefix} {field} must be a list of strings")
    return errors


def render(matrix: dict[str, Any]) -> str:
    cases = matrix["cases"]
    counts = Counter(case["status"] for case in cases)
    lines = [
        "# Android parity report",
        "",
        "Generated from `docs/android/parity-matrix.json`. This report tracks the Android validation surface against the named iOS schemes; it does not claim that planned checks have passed.",
        "",
        f"**Cases:** {len(cases)}  **Covered:** {counts['covered']}  **Scaffolded:** {counts['scaffolded']}  **Planned:** {counts['planned']}  **Blocked:** {counts['blocked']}",
        "",
        "| Area | Case | iOS schemes | Android check | Status | Risk | Owner |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for case in cases:
        ios = ", ".join(f"`{item}`" for item in case["iosSchemes"])
        android = ", ".join(f"`{item}`" for item in case["androidChecks"])
        lines.append(
            f"| {case['area']} | `{case['id']}` | {ios} | {android} | {case['status']} | {case['risk']} | {case['owner']} |"
        )
    lines.extend(["", "## Release interpretation", "", "A release candidate must have no `critical` case in `planned` or `blocked` status. Device, live-server, and store-signing checks remain required even when the local JVM and Compose suites pass.", ""])
    validation = matrix.get("latestValidation")
    if isinstance(validation, dict):
        lines.extend(["## Latest validation", "", "| Check | Result |", "| --- | --- |"])
        for key, value in validation.items():
            lines.append(f"| {key} | {value} |")
        lines.append("")
    blockers = matrix.get("releaseBlockers", [])
    if blockers:
        lines.extend(["## Open release blockers", "", "| ID | Status | Owner | Impact |", "| --- | --- | --- | --- |"])
        for blocker in blockers:
            lines.append(f"| `{blocker['id']}` | {blocker['status']} | {blocker['owner']} | {blocker['impact']} |")
        lines.append("")
    compile_notes = matrix.get("compileNotes")
    if isinstance(compile_notes, dict):
        lines.extend(["## Compile gate", "", "| Topic | Note |", "| --- | --- |"])
        for key, value in compile_notes.items():
            lines.append(f"| {key} | {value} |")
        lines.append("")
    follow_up = matrix.get("followUpEvidence", [])
    if follow_up:
        lines.extend(["## Follow-up task evidence", "", "| Task | Status | Evidence | Remaining |", "| --- | --- | --- | --- |"])
        for item in follow_up:
            lines.append(f"| `{item['task']}` | {item['status']} | {item['evidence']} | {item['remaining']} |")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--matrix", type=Path, default=Path("docs/android/parity-matrix.json"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true", help="validate the matrix and fail on schema errors")
    args = parser.parse_args()

    try:
        matrix = load_matrix(args.matrix)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"parity matrix error: {error}", file=sys.stderr)
        return 2

    errors = validate(matrix)
    if args.check and errors:
        for error in errors:
            print(f"parity matrix error: {error}", file=sys.stderr)
        return 1

    report = render(matrix)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
