#!/usr/bin/env python3
"""Make ten reference comparisons from unmodified XCTest captures and supplied JPEGs."""
import argparse
import hashlib
import html
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("output", type=Path)
p.add_argument("--reference-dir", type=Path, required=True)
p.add_argument("--bundle", type=Path, action="append", required=True)
args = p.parse_args()
out = args.output.resolve()
for folder in ["originals", "pairs", "details", "evidence"]:
    (out / folder).mkdir(parents=True, exist_ok=True)
manifest = {"normalization": "Originals are copied unchanged. Pairs and labeled detail crops scale proportionally to 440 points wide. No recoloring, retouching, status replacement, or image registration.", "runs": [], "pairs": []}
native = {}
for bundle in args.bundle:
    summary = json.loads(subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)]))
    assert summary["failedTests"] == 0 and summary["skippedTests"] == 0, summary
    summary_file = "evidence/" + bundle.stem + "-summary.json"
    (out / summary_file).write_text(json.dumps(summary, indent=2))
    manifest["runs"].append({"bundle": str(bundle.resolve()), "summary": summary_file, "passed": summary["passedTests"]})
    with tempfile.TemporaryDirectory(prefix="dark-review-") as tmp:
        subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle), "--output-path", tmp], check=True, stdout=subprocess.DEVNULL)
        for group in json.load(open(Path(tmp) / "manifest.json")):
            for item in group["attachments"]:
                name = item["suggestedHumanReadableName"].split("_0_")[0]
                if not name.startswith("dark-native-"):
                    continue
                n = int(name.removeprefix("dark-native-"))
                source = Path(tmp) / item["exportedFileName"]
                dest = f"originals/{n:02}-native.png"
                shutil.copyfile(source, out / dest)
                native[n] = {"path": dest, "test": group["testIdentifier"], "bundle": str(bundle.resolve()), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
assert set(native) == set(range(1, 11)), f"Missing captures: {set(range(1, 11)) - set(native)}"
titles = ["Scrolled conversations", "New group and search keyboard", "Create a bot", "Held conversation menu", "Bot profile and character", "Computer screen", "Starting desktop", "Computer keyboard", "Multiline chat composer", "Voice recording"]
notes = [
    "Same dark background and floating native glass. The list uses our desktop robot identities; their silhouettes are intentionally different.",
    "Native bot search, keyboard, selection and Next. Group naming follows selection; retry keeps both the name and selected bots.",
    "Our twelve desktop robot identities and palette remain available. The creation picker has one extra row; the profile fits all twelve in two rows.",
    "The system supplies the lifted preview, dimming, blur and menu transitions. Menu actions reflect the functions available in OpenTeam.",
    "Native profile fields, character selection and instructions. All twelve of our robot identities remain selectable. Save explicitly persists edits.",
    "Black fullscreen canvas and floating glass controls. The remote screen is an inert QA image, not Grokbot’s desktop. Real desktop inputs were verified in a separate production bridge run.",
    "Starting desktop is a real loading branch driven by the screen status response; no screen image or interactive controls are shown before readiness.",
    "The native keyboard resizes the desktop canvas and sends committed text through the same ordered input queue. The remote image remains the QA fixture.",
    "The supplied conversation text is inert fixture content. Header and composer glass sample the content beneath them; no full-width solid bar is drawn.",
    "A labeled synthetic AAC recording supplies the elapsed time and waveform because this Mac has no microphone input. Stop, discard and transcription retry use the actual file/upload path. A separate check verifies the real microphone-unavailable error. Physical microphone capture and speech-recognition quality are not accepted here.",
]
def normalized(path):
    im = Image.open(path).convert("RGB")
    return im.resize((440, round(im.height * 440 / im.width)), Image.Resampling.LANCZOS)
for n in range(1, 11):
    ref = args.reference_dir / f"{n}-Photo-{n}.jpg"
    dest = f"originals/{n:02}-reference.jpg"
    shutil.copyfile(ref, out / dest)
    left, right = normalized(ref), normalized(out / native[n]["path"])
    canvas = Image.new("RGB", (896, max(left.height, right.height)), "#303238")
    canvas.paste(left, (0, 0)); canvas.paste(right, (456, 0))
    pair = f"pairs/{n:02}.png"; canvas.save(out / pair)
    # These are explicitly labeled crops of the normalized screenshots, not separate screen renders.
    regions = {"header": (0, 52, 440, 140)}
    if n in [8, 9]: regions["keyboard-edge"] = (0, 495, 440, 645)
    if n == 10: regions["recording"] = (0, 855, 440, 950)
    details = []
    for name, box in regions.items():
        crop = Image.new("RGB", (896, box[3] - box[1]), "#303238")
        crop.paste(left.crop(box), (0, 0)); crop.paste(right.crop(box), (456, 0))
        file = f"details/{n:02}-{name}.png"; crop.save(out / file)
        details.append({"path": file, "cropInNormalizedPoints": box, "name": name})
    manifest["pairs"].append({"number": n, "title": titles[n-1], "note": notes[n-1], "reference": {"path": dest, "source": str(ref.resolve()), "sha256": hashlib.sha256(ref.read_bytes()).hexdigest()}, "native": native[n], "comparison": pair, "details": details})
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
parts = ['''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam · Ten dark references</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#151618;color:#f0f1f4;color-scheme:dark}body{max-width:1040px;padding:32px 24px;margin:auto}h1{font-size:36px;letter-spacing:-1px}p{line-height:1.6;color:#bdc4ce}a{color:#b1d2ff}nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}nav a{padding:8px 12px;border-radius:10px;background:#2a2c30;text-decoration:none}section{margin-top:54px}h2{font-size:24px}.labels{display:grid;grid-template-columns:1fr 1fr;gap:16px;text-align:center;font-weight:600;margin:20px 0 10px}img{display:block;width:100%;height:auto;border-radius:10px}summary{cursor:pointer;margin:18px 0}small{color:#9ba7b6}.note{padding:16px 20px;background:#22262b;border-radius:14px}@media(max-width:600px){body{padding:22px 12px}h1{font-size:29px}}
</style><h1>Ten dark reference comparisons</h1><p>Grokbot on the left. The current Swift app on the right. Each screenshot is an original simulator capture; the desktop robot artwork remains ours.</p><p class="note">Liquid Glass stays native. Compare matching backdrops: buttons brighten over messages and darken over the black computer canvas. A flattened JPEG shows the resulting color, not a material’s exact opacity. These are visual comparisons, not a claim of pixel-perfect equivalence.</p><nav>''']
for pair in manifest["pairs"]:
    parts.append(f'<a href="#{pair["number"]}">{pair["number"]:02} · {html.escape(pair["title"])}</a>')
parts.append('<a href="manifest.json">Capture provenance</a></nav>')
for pair in manifest["pairs"]:
    n = pair["number"]
    parts.append(f'<section id="{n}"><h2>{n:02} · {html.escape(pair["title"])}</h2><p>{html.escape(pair["note"])}</p><div class="labels"><span>Grokbot · supplied photo</span><span>OpenTeam · native Swift</span></div><a href="{pair["comparison"]}"><img loading="lazy" src="{pair["comparison"]}" alt="{html.escape(pair["title"])} side by side"></a><details><summary>Glass details and original files</summary>')
    for detail in pair["details"]:
        parts.append(f'<p><small>{detail["name"]} crop · {detail["cropInNormalizedPoints"]} points</small></p><img loading="lazy" src="{detail["path"]}" alt="Enlarged glass detail">')
    parts.append(f'<p><a href="{pair["reference"]["path"]}">Original reference</a> · <a href="{pair["native"]["path"]}">Original native capture</a></p></details></section>')
parts.append('</html>')
(out / "index.html").write_text(''.join(parts))
print(out)
