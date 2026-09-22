#!/usr/bin/env python3
"""Export verified native/system QA evidence without modifying screenshot pixels."""
import argparse
import hashlib
import html
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--bundle", type=Path, action="append", required=True)
parser.add_argument("--earlier-bundle", type=Path, action="append", default=[])
parser.add_argument("--log", type=Path, action="append", default=[])
parser.add_argument("--backend-state", type=Path, required=True)
parser.add_argument("--glass-review", type=Path, required=True)
parser.add_argument("--reference-review", type=Path, required=True)
parser.add_argument("--dark-review", type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
(out / "captures").mkdir(parents=True, exist_ok=True)
(out / "evidence").mkdir(exist_ok=True)
manifest = {"runs": [], "captures": [], "logs": [], "limitations": [
    "The API, PostgreSQL, workers, scheduler and desktop are real production code in disposable environments. Model responses are deterministic; no live provider account was used.",
    "The broad native suite uses production request schemas and simulated failures. OAuth providers, advanced plugin authoring and physical-device behavior are not fully accepted.",
    "Native APNs delivery remains unimplemented. Keep the React Native client during migration acceptance.",
]}
def cases(bundle):
    tree = json.loads(subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", str(bundle)]))
    result = {}
    def visit(node):
        if node.get("nodeType") == "Test Case":
            result[node["nodeIdentifier"]] = node["result"]
        for child in node.get("children", []):
            visit(child)
    for node in tree["testNodes"]:
        visit(node)
    return result

latest_cases = {}
latest_source = {}
for bundle in args.earlier_bundle + args.bundle:
    outcomes = cases(bundle)
    latest_cases.update(outcomes)
    latest_source.update({key: bundle.resolve() for key in outcomes})
assert latest_cases and all(result == "Passed" for result in latest_cases.values()), latest_cases
all_passed_cases = set(latest_cases)
for bundle in args.earlier_bundle + args.bundle:
    earlier = bundle in args.earlier_bundle
    outcomes = cases(bundle)
    summary = json.loads(subprocess.check_output([
        "xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)]))
    assert summary["skippedTests"] == 0 and summary["passedTests"] > 0, summary
    failures = [key for key, value in outcomes.items() if value != "Passed"]
    if earlier:
        assert all(latest_cases.get(key) == "Passed" for key in failures), f"Unresolved earlier failures: {failures}"
    else:
        assert summary["failedTests"] == 0, summary
    all_passed_cases.update(key for key, value in outcomes.items() if value == "Passed")
    summary_path = Path("evidence") / (bundle.stem + "-summary.json")
    (out / summary_path).write_text(json.dumps(summary, indent=2))
    manifest["runs"].append({"bundle": str(bundle.resolve()), "passed": summary["passedTests"], "failed": summary["failedTests"], "resolvedInLaterBundles": failures if earlier else [], "summary": str(summary_path)})
    with tempfile.TemporaryDirectory(prefix="swift-system-review-") as temp:
        subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle), "--output-path", temp], check=True, stdout=subprocess.DEVNULL)
        for group in json.load(open(Path(temp) / "manifest.json")):
            test_id = group["testIdentifier"]
            if outcomes.get(test_id) != "Passed" or latest_source.get(test_id) != bundle.resolve():
                continue
            for attachment in group["attachments"]:
                name = attachment["suggestedHumanReadableName"].split("_0_")[0]
                if not name.startswith(("parity-", "native-", "live-", "grok-native-", "dark-native-")):
                    continue
                source = Path(temp) / attachment["exportedFileName"]
                destination = Path("captures") / (bundle.stem + "-" + name + source.suffix)
                shutil.copyfile(source, out / destination)
                manifest["captures"].append({"name": name, "path": str(destination), "test": group["testIdentifier"], "bundle": str(bundle.resolve()), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
for source in args.log:
    destination = Path("evidence") / source.name
    shutil.copyfile(source, out / destination)
    manifest["logs"].append({"name": source.stem, "path": str(destination), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
state = json.loads(args.backend_state.read_text())
completed = [r for r in state["executions"] if r["kind"] == "scheduled" and r["status"] == "completed"]
assert completed, "Need an actual completed scheduled execution"
manifest["scheduledExecutions"] = completed
manifest["uniquePassedCases"] = sorted(all_passed_cases)
shutil.copyfile(args.backend_state, out / "evidence/backend-state.json")
shutil.copytree(args.glass_review, out / "glass", dirs_exist_ok=True)
shutil.copytree(args.reference_review, out / "references", dirs_exist_ok=True)
shutil.copytree(args.dark_review, out / "dark-references", dirs_exist_ok=True)
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
esc = html.escape
passed = sum(run["passed"] for run in manifest["runs"])
parts = ['''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam Swift · System QA</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color-scheme:dark;background:#151618;color:#f1f3f5}body{max-width:1280px;margin:auto;padding:40px 24px}h1{font-size:38px;letter-spacing:-1px}h2{margin-top:52px}p,li{line-height:1.6;color:#c2c8d1}a{color:#a9cdff}nav{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}nav a{padding:12px 16px;background:#242b35;border-radius:12px;text-decoration:none}.evidence{background:#202a25;border:1px solid #3a624a;border-radius:16px;padding:20px 24px}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px}figure{margin:0}img{display:block;width:100%;border-radius:16px}figcaption{padding:12px 0;line-height:1.4}small{display:block;color:#9aa5b4;overflow-wrap:anywhere;margin-top:6px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:14px;border-bottom:1px solid #38414c;vertical-align:top}th{color:#9cb8d8}details{margin-top:18px}summary{cursor:pointer}code{overflow-wrap:anywhere}@media(max-width:850px){.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:550px){.gallery{grid-template-columns:1fr}body{padding:24px 16px}h1{font-size:29px}}
</style><h1>Swift native · System QA</h1><p>Message delivery, scheduled work, real desktop control, and native failure recovery. Screenshots below come directly from successful simulator test runs.</p><nav><a href="dark-references/index.html">Ten new dark-reference comparisons</a><a href="glass/index.html">Liquid Glass and five-photo comparisons</a><a href="references/index.html">All 21 supplied-reference comparisons</a><a href="manifest.json">Evidence manifest</a></nav>''']
parts.append(f'<div class="evidence"><strong>{len(all_passed_cases)} covered native UI checks · {passed} passing executions · {len(manifest["captures"])} original captures</strong><p>The real scheduled check created an every-five-minute routine in Swift, closed the app, waited for the actual timer, observed a completed worker execution, and reopened the app to its result. The model response was deterministic.</p><p>The earlier broad run is retained with its original failure count. Every failed case included from that run must pass in a later supplied bundle; its failed captures are excluded.</p></div>')
parts.append('''<h2>Issues found and corrected</h2><table><tr><th>Area</th><th>Fix and evidence</th></tr>
<tr><td>Real server identifiers</td><td>Preserve UUID hyphens in URL path segments. Production routing had rejected encoded identifiers, preventing sends and other ID-based operations.</td></tr>
<tr><td>Held and inline replies</td><td>Plain messages carrying production <code>type: text</code> metadata now support hold and swipe gestures. Real-server receipts verify the reply stays in its conversation.</td></tr>
<tr><td>Computer inputs</td><td>Swift queues rapid gestures; the desktop shares one readiness check to keep overlapping inputs ordered. Real Chromium receipts verify typing, clicks and control recovery.</td></tr>
<tr><td>Connection and control loss</td><td>Cached screens are labeled, remote inputs stop on connection loss, and older frame requests cannot overwrite a newer control lease. Failed typing retains its text.</td></tr>
<tr><td>Routine retries</td><td>Run-now reuses its request ID after a lost response. History errors are separate from run errors, so an accepted execution remains visible and a retry does not create another run.</td></tr></table>
<h2>What the checks cover</h2><table><tr><th>Layer</th><th>Coverage</th></tr>
<tr><td>Swift + production API/worker/database</td><td>Create bot, offline send, lost acknowledgment, one durable message, worker reply, real five-minute scheduled trigger with app closed, completed execution, relaunch, held inline reply and swipe.</td></tr>
<tr><td>Real desktop</td><td>Native typing and pointer inputs, stale-screen and lease recovery. Production desktop tests also cover multilingual text, concurrent desktops, takeover interruption, resumed agent input, concurrent screenshots, multiple VNC viewers and reconnects.</td></tr>
<tr><td>Native failure injection</td><td>Sign-in, invalid/unreachable server, rate limits, expired sessions, retained drafts, failed sign-out, profiles, groups, memory, routines, plugin installation/configuration, sources, private skills, forms, authenticated files, approvals and thread delivery.</td></tr>
<tr><td>Production integration</td><td>48 checks of durable delivery, worker restart, interval/weekday/DST/event routines, duplicate events, overlaps, pauses, subscriptions, registered-machine reconnects, handoff completion, and automation-to-parent delivery.</td></tr>
<tr><td>Shared contracts and core</td><td>278 RN/client checks and 25 Swift core checks. These are contract/regression checks, not 303 independent live workflows.</td></tr></table>
<p>Grokbot’s <a href="https://docs.x.ai/grok-bot/mobile">mobile documentation</a> describes shared desktop control and routines continuing with the phone closed. Those behaviors guide these checks. The ten new dark screenshots guide the fullscreen computer, its loading and keyboard states, group search, profile and voice controls. Native errors remain recoverable. The recording screenshot uses a labeled synthetic AAC file because the QA Mac has no microphone input; a separate real-recorder check verifies its unavailable-input error. Our desktop robot remains the artwork and motion source.</p>''')
groups = [
    ("Live desktop and backend", ("live-",)),
    ("Current supplied-reference checks", ("grok-native-", "dark-native-")),
    ("Native forms and recovery", ("parity-",)),
    ("Compact chat and navigation", ("native-",)),
]
for title, prefixes in groups:
    captures = [c for c in manifest["captures"] if c["name"].startswith(prefixes)]
    if not captures:
        continue
    parts.append(f'<h2>{title}</h2><div class="gallery">')
    for capture in captures:
        label = re.sub(r"^(live-backend-|live-computer-|grok-native-|dark-native-|parity-|native-)", "", capture["name"]).replace("-", " ")
        parts.append(f'<figure><a href="{capture["path"]}"><img loading="lazy" src="{capture["path"]}" alt="{esc(label)}"></a><figcaption>{esc(label)}<small>{esc(capture["test"])}</small></figcaption></figure>')
    parts.append('</div>')
parts.append('<h2>Acceptance still open</h2><ul>' + ''.join(f'<li>{esc(note)}</li>' for note in manifest['limitations']) + '</ul>')
parts.append('<details><summary>Raw test summaries and logs</summary><ul>')
for run in manifest["runs"]:
    resolved = f'; {run["failed"]} earlier failures, all passed in later bundles' if run['failed'] else '; no failures'
    parts.append(f'<li><a href="{run["summary"]}">{esc(Path(run["bundle"]).name)}</a>: {run["passed"]} passed{resolved}</li>')
for log in manifest["logs"]:
    parts.append(f'<li><a href="{log["path"]}">{esc(log["name"])}</a></li>')
parts.append('<li><a href="evidence/backend-state.json">Disposable backend receipts and scheduled timestamps</a></li></ul></details></html>')
(out / "index.html").write_text(''.join(parts))
print(f"Exported {passed} passed native executions and {len(manifest['captures'])} original screenshots to {out}")
