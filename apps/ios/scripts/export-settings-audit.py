#!/usr/bin/env python3
"""Export reference comparisons with open failures preserved, without retouching screenshots."""
import argparse
import hashlib
import html
import json
import shutil
import statistics
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("output", type=Path)
p.add_argument("--reference-dir", type=Path, required=True)
p.add_argument("--bundle", type=Path, action="append", required=True)
p.add_argument("--production-receipt", type=Path)
args = p.parse_args()
out = args.output.resolve()
for folder in ["originals", "pairs", "evidence"]:
    (out / folder).mkdir(parents=True, exist_ok=True)
manifest = {"status": "Audit of current behavior; mismatches and failures remain open", "runs": [], "captures": {}, "pairs": [], "normalization": "Originals copied byte-for-byte. Side-by-sides proportionally resized to 440 pixels wide; no recoloring, registration or status-bar replacement."}
for bundle in args.bundle:
    summary = json.loads(subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)]))
    summary_path = "evidence/" + bundle.stem + "-summary.json"
    (out / summary_path).write_text(json.dumps(summary, indent=2))
    manifest["runs"].append({"bundle": str(bundle.resolve()), "passed": summary["passedTests"], "failed": summary["failedTests"], "skipped": summary["skippedTests"], "summary": summary_path})
    with tempfile.TemporaryDirectory(prefix="settings-audit-") as temp:
        subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle), "--output-path", temp], check=True, stdout=subprocess.DEVNULL)
        for group in json.load(open(Path(temp) / "manifest.json")):
            for item in group["attachments"]:
                name = item["suggestedHumanReadableName"].split("_0_")[0]
                if not name.startswith("settings-audit-"):
                    continue
                source = Path(temp) / item["exportedFileName"]
                dest = ("originals/" if source.suffix == ".png" else "evidence/") + name + source.suffix
                shutil.copyfile(source, out / dest)
                manifest["captures"][name] = {"path": dest, "test": group["testIdentifier"], "bundle": str(bundle.resolve()), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
scenes = [
    ("01-settings-bottom", "Settings and support", "Native has Appearance and App haptics, but the grouping and screen height differ. Global notifications, Privacy Policy, Terms of Service, and the branded version footer are absent. Help is a repository link; feedback opens a share sheet."),
    ("02-catalog-retry", "Catalog with a failed connection", "The native catalog does not show the failed connection or a Retry button. It uses inset grouped rows without plugin logos, featured/team sections, an installed-count control or the filter button."),
    ("03-after-removal", "Uninstall success", "Native returns to the catalog. It does not retain the detail sheet with an Add button or display the reference's removal-success banner. The removal itself is verified against the isolated fixture state."),
    ("04-uninstall-confirmation", "Destructive confirmation", "Native presents a small confirmation popover near the top of the screen, while the reference uses a centered alert with explanatory text and an explicit Cancel button. Dismissing the native popover sends no deletion; a pre-commit failure remains retryable."),
    ("05-uninstall-entry", "Uninstall menu", "There is no native ellipsis menu in this screen. The right capture shows the actual Uninstall plugin row at the bottom of the form, the closest available entry point."),
    ("06-failed-connection", "Connection failure detail", "The native screen exposes a large connection/access form rather than a compact detail sheet with one Retry action. The production page-limit error is also visible: the app requests 100 bot-access rows where the server permits 60."),
    ("07-authorization-return", "Authorization handoff", "Native has no equivalent in-app system authentication prompt. Sign in opens an external browser. The right capture is the app after returning from the inert browser handoff with the fixture connection now ready; the displayed status stays stale. No Google login was performed or fabricated."),
    ("08-catalog-authorize", "Catalog needing authorization", "The native catalog hides authorization state: there is no Authorize button on the row. The user must open the installed plugin and find Sign in. Search, grouping, row sizing and header glass differ."),
    ("09-settings-top", "Account and bot settings", "OpenTeam's self-hosted account/server information replaces the subscription account. Usage and app-update rows are absent. Auto-review, its rules, automatic/manual bot time zone and Bot Computer controls are missing from this screen."),
    ("10-loading", "Catalog loading", "Native shows an inline Loading plugins row within the grouped list rather than a centered spinner below a persistent glass search bar and installed-count button. Retry after a loading failure is exercised separately."),
]
def normalized(path):
    im = Image.open(path).convert("RGB")
    return im.resize((440, round(im.height * 440 / im.width)), Image.Resampling.LANCZOS)
for n, (name, title, note) in enumerate(scenes, 1):
    native = manifest["captures"].get("settings-audit-" + name)
    assert native, f"Missing actual capture {name}"
    ref = args.reference_dir / f"{n}-Photo-{n}.jpg"
    reference_path = f"originals/{n:02}-reference.jpg"
    shutil.copyfile(ref, out / reference_path)
    left, right = normalized(ref), normalized(out / native["path"])
    canvas = Image.new("RGB", (896, max(left.height, right.height)), "#303238")
    canvas.paste(left, (0, 0)); canvas.paste(right, (456, 0))
    pair = f"pairs/{n:02}.png"; canvas.save(out / pair)
    manifest["pairs"].append({"number": n, "title": title, "note": note, "reference": {"path": reference_path, "source": str(ref.resolve()), "sha256": hashlib.sha256(ref.read_bytes()).hexdigest()}, "native": native, "comparison": pair})
catalog = manifest["pairs"][1]
images = [normalized(out / catalog[key]["path"]) for key in ["reference", "native"]]
measurements = []
for name, box in [("Catalog sheet", (15, 310, 22, 340)), ("Back button interior", (55, 160, 61, 174))]:
    values = []
    for image in images:
        samples = [image.getpixel((x, y)) for x in range(box[0], box[2]) for y in range(box[1], box[3])]
        values.append([statistics.median(sample[c] for sample in samples) for c in range(3)])
    measurements.append({"name": name, "boxAt440pxWidth": box, "referenceRGB": values[0], "nativeRGB": values[1]})
manifest["renderedColorSamples"] = measurements
crop = Image.new("RGB", (728, 260), "#454545")
for i, image in enumerate(images):
    crop.paste(image.crop((14, 140, 104, 205)).resize((360, 260), Image.Resampling.LANCZOS), (i * 368, 0))
crop.save(out / "glass-crop.png")
contact = Image.new("RGB", (916, 2520), "#222428")
draw = ImageDraw.Draw(contact)
for i, row in enumerate(manifest["pairs"]):
    image = Image.open(out / row["comparison"]); image.thumbnail((448, 478))
    x, y = (i % 2) * 468, (i // 2) * 504
    draw.text((x + 8, y + 5), f"{i+1:02} {row['title']}", fill="white")
    contact.paste(image, (x, y + 24))
contact.save(out / "contact.png")
if args.production_receipt:
    path = "evidence/uninstall-production.json"
    shutil.copyfile(args.production_receipt, out / path)
    manifest["productionUninstall"] = {"path": path, "sha256": hashlib.sha256(args.production_receipt.read_bytes()).hexdigest()}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
esc = html.escape
parts = ['''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings and plugins · QA comparison</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color-scheme:dark;background:#151618;color:#f3f4f7}body{max-width:1040px;margin:auto;padding:32px 24px}h1{font-size:36px;letter-spacing:-1px}p,li{line-height:1.6;color:#bdc4ce}a{color:#aed1ff}.notice{border-left:4px solid #efb26e;padding:12px 20px;background:#27221d}nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}nav a{padding:8px 12px;background:#292c32;border-radius:8px;text-decoration:none}section{margin-top:48px}.labels{display:grid;grid-template-columns:1fr 1fr;gap:16px;text-align:center;margin:20px 0 10px;font-weight:600}img{width:100%;height:auto;display:block;border-radius:10px}details{margin:18px 0}small{color:#a1abba}summary{cursor:pointer}</style></head><body><h1>Settings and plugins: ten-screen audit</h1>
<p class="notice">These are comparisons of the current app, with open defects and missing screens explicitly labeled. They are not a claim that these screens have been rebuilt or matched. Product behavior was not changed during this audit.</p>
<p>Grokbot reference on the left; an unretouched Swift simulator capture on the right. Fixture names are synthetic and all authorization is inert. Native system glass is retained, but component choice, sheet geometry, backgrounds and layout materially differ. Exact opacity cannot be inferred from flattened screenshots.</p>
<p>Full findings: <code>apps/ios/docs/SETTINGS-PLUGIN-AUDIT-0916.md</code>. <a href="manifest.json">All capture provenance and hashes</a>.</p><nav>''']
for pair in manifest["pairs"]:
    parts.append(f'<a href="#{pair["number"]}">{pair["number"]:02} · {esc(pair["title"])}</a>')
parts.append('</nav><details open><summary>Actual test outcomes — failures retained</summary><ul>')
for run in manifest["runs"]:
    parts.append(f'<li><a href="{run["summary"]}">{esc(Path(run["bundle"]).name)}</a>: {run["passed"]} passed, {run["failed"]} failed, {run["skipped"]} skipped.</li>')
parts.append('</ul></details>')
parts.append('<h2>Glass and surface comparison</h2><p>The reference button is lighter inside, while the native grouped-list sheet is lighter than the reference sheet. These are rendered RGB samples from the labeled catalog capture, not opacity estimates.</p><ul>')
for measurement in measurements:
    parts.append(f'<li>{esc(measurement["name"])}: reference RGB {measurement["referenceRGB"]}; native RGB {measurement["nativeRGB"]}. Sample box {measurement["boxAt440pxWidth"]} after proportional normalization.</li>')
parts.append('</ul><img src="glass-crop.png" alt="Catalog back-button detail: reference left, Swift right"><p><a href="contact.png">All ten comparisons in one contact sheet</a></p>')
if args.production_receipt:
    parts.append('<p><a href="evidence/uninstall-production.json">Production API/database uninstall receipt: successful removal followed by 404 on retry</a></p>')
for pair in manifest["pairs"]:
    parts.append(f'<section id="{pair["number"]}"><h2>{pair["number"]:02} · {esc(pair["title"])}</h2><p>{esc(pair["note"])}</p><div class="labels"><span>Grokbot · supplied reference</span><span>OpenTeam · current Swift app</span></div><a href="{pair["comparison"]}"><img loading="lazy" src="{pair["comparison"]}" alt="{esc(pair["title"])} comparison"></a><p><small><a href="{pair["reference"]["path"]}">Original reference</a> · <a href="{pair["native"]["path"]}">Original native capture</a> · {esc(pair["native"]["test"])}</small></p></section>')
parts.append('<h2>Additional failure evidence and receipts</h2><ul>')
for name, capture in manifest["captures"].items():
    if name.endswith('-receipts') or not any(name == 'settings-audit-' + s[0] for s in scenes):
        parts.append(f'<li><a href="{capture["path"]}">{esc(name.removeprefix("settings-audit-"))}</a></li>')
parts.append('</ul></body></html>')
(out / "index.html").write_text(''.join(parts))
print(f"Exported {len(manifest['pairs'])} comparisons and {len(manifest['captures'])} original artifacts to {out}")
