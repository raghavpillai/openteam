#!/usr/bin/env python3
"""Display seven original reference photos beside unmodified XCTest captures."""
import argparse
import hashlib
import html
import json
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--reference-dir", required=True, type=Path)
parser.add_argument("--bundle", required=True, type=Path)
args = parser.parse_args()
out = args.output.resolve()
evidence = out / ("evidence-" + args.bundle.stem)
if not (evidence / "manifest.json").exists():
    subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(args.bundle), "--output-path", str(evidence)], check=True)
summary = json.loads(subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(args.bundle), "--format", "json"]))
(out / "test-summary.json").write_text(json.dumps(summary, indent=2))
found = {}
for case in json.loads((evidence / "manifest.json").read_text()):
    for item in case["attachments"]:
        name = item["suggestedHumanReadableName"].split("_0_")[0]
        if name.startswith("seven-native-"):
            found[int(name.rsplit("-", 1)[1])] = {"path": evidence.name + "/" + item["exportedFileName"], "test": case["testIdentifier"]}
assert set(found) == set(range(1, 8)), f"Missing captures: {set(range(1,8)) - set(found)}"
(out / "reference").mkdir(exist_ok=True)
notes_path = out / "observations.json"
notes = json.loads(notes_path.read_text()) if notes_path.exists() else {}
titles = ["Attachment menu and keyboard", "Voice recording", "Multiline draft", "Scrolled chat", "Latest chat", "Settings sheet", "New conversation menu"]
manifest = {"bundle": str(args.bundle.resolve()), "comparison": "Original files unchanged; displayed at equal width. No image registration, repainting, recoloring, or status-bar replacement.", "pairs": []}
parts = []
for n, title in enumerate(titles, 1):
    source = args.reference_dir / f"{n}-Photo-{n}.jpg"
    ref = f"reference/{n:02}.jpg"
    shutil.copyfile(source, out / ref)
    native = found[n]
    native["sha256"] = hashlib.sha256((out / native["path"]).read_bytes()).hexdigest()
    row = {"number": n, "title": title, "reference": {"path": ref, "source": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}, "native": native, "observations": notes.get(str(n), [])}
    manifest["pairs"].append(row)
    bullets = "".join(f"<li>{html.escape(note)}</li>" for note in row["observations"])
    parts.append(f'<section id="screen-{n}"><h2>{n}. {html.escape(title)}</h2><ul>{bullets}</ul><div class="pair"><figure><figcaption>Grok Bot · supplied photo</figcaption><a href="{ref}"><img loading="lazy" src="{ref}" alt="Reference {n}"></a></figure><figure><figcaption>OpenTeam · actual Swift capture</figcaption><a href="{native["path"]}"><img loading="lazy" src="{native["path"]}" alt="Native {n}"></a></figure></div></section>')
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
counts = f'{summary["passedTests"]} passed, {summary["failedTests"]} failed, {summary["skippedTests"]} skipped'
(out / "review.html").write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seven-screen native comparison</title><style>
body{font:16px system-ui;background:#111;color:#eee;margin:28px}main{max-width:1000px;margin:auto}p,li{line-height:1.55}a{color:#91c5ff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}figcaption{padding:10px 0;color:#bbb}img{display:block;width:100%;height:auto}section{margin:48px 0}nav{display:flex;gap:16px;flex-wrap:wrap}.notice{background:#25231b;padding:18px;border-radius:12px}@media(max-width:600px){body{margin:12px}.pair{gap:8px}}
</style><main><h1>Seven-screen native comparison</h1><p class="notice">Not a 1:1 match. These are fresh native simulator captures with inert reference conversation content. Native Liquid Glass is retained. Our robot artwork intentionally differs. Recording uses synthetic audio; this pass does not establish physical microphone, live-server or APNs acceptance.</p><p>Original photos and simulator images are unchanged and displayed at equal width. Pixel colors describe the rendered result, not the material’s transparency percentage. Menu/keyboard appearance can also vary by iOS version and device settings.</p><p>Capture and interaction checks: ''' + counts + '''. Passing checks do not mean visual parity.</p><p><a href="../../apps/mobile-swift/docs/SEVEN-SCREEN-VALIDATION-0916.md">Detailed findings</a> · <a href="manifest.json">Image provenance</a> · <a href="test-summary.json">Test result</a> · <a href="measurements.json">Measurements</a></p><nav>''' + ''.join(f'<a href="#screen-{n}">{n}. {html.escape(title)}</a>' for n, title in enumerate(titles, 1)) + '</nav>' + ''.join(parts) + '</main></html>')
print(out / "review.html")
