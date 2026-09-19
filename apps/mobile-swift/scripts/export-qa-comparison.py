#!/usr/bin/env python3
"""Export the supplied September reference sets beside unchanged XCTest captures."""
import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--reference-root", type=Path, required=True)
    parser.add_argument("--allow-incomplete", action="store_true")
    parser.add_argument("--landing-page", type=Path,
                        help="Optional report at the evidence root, so local browsers can access all child reports.")
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "images").mkdir(exist_ok=True)
    bundles = args.bundle_dir.resolve()
    captures = {}
    summaries = {}
    for scheme in ["SevenReference", "SevenReference-Wide", "AttachmentReference",
                   "SettingsPluginAudit", "SettingsPluginAudit-Fixed", "GlassSections", "Palette", "VNCValidation", "VNCValidation-Recheck",
                   "OpenTeamNative", "PhotoSave-FreshPermission"]:
        bundle = bundles / (scheme + ".xcresult")
        summary_file = bundles / (scheme + "-summary.json")
        if not summary_file.exists():
            continue
        summary = json.loads(summary_file.read_text())
        summaries[scheme] = summary
        evidence = bundles / "evidence" / scheme
        if not (evidence / "manifest.json").exists():
            subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path",
                            str(bundle), "--output-path", str(evidence)],
                           check=True, stdout=subprocess.DEVNULL)
        for case in json.loads((evidence / "manifest.json").read_text()):
            for item in case["attachments"]:
                source = evidence / item["exportedFileName"]
                if source.suffix != ".png":
                    continue
                name = item["suggestedHumanReadableName"].split("_0_")[0]
                captures[(scheme, name)] = {
                    "source": str(source), "bundle": str(bundle), "test": case["testIdentifier"],
                    "capture": name, "device": item["deviceName"], "deviceId": item["deviceId"],
                    "timestamp": item["timestamp"], "sha256": sha(source),
                    "suiteResult": summary["result"],
                }

    def native(scheme, capture):
        if scheme == "SettingsPluginAudit" and ("SettingsPluginAudit-Fixed", capture) in captures:
            scheme = "SettingsPluginAudit-Fixed"
        if scheme == "VNCValidation" and ("VNCValidation-Recheck", capture) in captures:
            scheme = "VNCValidation-Recheck"
        item = captures.get((scheme, capture))
        if item is None:
            if not args.allow_incomplete:
                raise ValueError(f"Missing capture: {scheme}/{capture}")
            return None
        item = dict(item)
        item["path"] = f"images/{scheme}-{capture}.png"
        shutil.copyfile(item["source"], out / item["path"])
        assert sha(out / item["path"]) == item["sha256"]
        return item

    groups = [
        ("Chat", "57935E3D-22A4-4D48-97E8-493BFDC2D278", [
            ("Attachment menu", "SevenReference", "seven-native-01", "Matching fixture conversation; attachment action labels and menu material differ. The camera action is omitted on this simulator because camera hardware is unavailable. Keyboard suggestions are OS-generated."),
            ("Recording", "SevenReference", "seven-native-02", "Synthetic recording exercises controls. This is not a physical microphone or haptic test."),
            ("Multiline draft", "SevenReference", "seven-native-03", "Same draft; keyboard, wrapping and visible history depend on logical viewport."),
            ("Scrolled conversation", "SevenReference", "seven-native-04", "Same fixture conversation; scroll offsets are not pixel-registered."),
            ("Latest conversation", "SevenReference", "seven-native-05", "Compare both iPhone widths. Robot artwork differs; these are real native material captures."),
            ("Settings", "SevenReference", "seven-native-06", "Same destination; account contents and available settings differ."),
            ("New conversation menu", "SevenReference", "seven-native-07", "Same menu state; artwork, naming, material and menu geometry differ."),
        ]),
        ("Settings and plugins", "6BB99159-049A-491D-B3E4-49071B685C10", [
            ("Settings bottom", "SettingsPluginAudit", "settings-audit-01-settings-bottom", "Preference and support rows; product branding differs."),
            ("Catalog retry", "SettingsPluginAudit", "settings-audit-02-catalog-retry", "Same failed-connection catalog state using inert plugin data."),
            ("Removed plugin", "SettingsPluginAudit", "settings-audit-03-after-removal", "Same after-removal state. Toast timing can differ."),
            ("Uninstall confirmation", "SettingsPluginAudit", "settings-audit-04-uninstall-confirmation", "Same destructive confirmation state; inspect alert wording and presentation."),
            ("Uninstall menu", "SettingsPluginAudit", "settings-audit-05-uninstall-entry", "Same menu action; native presentation differs."),
            ("Connection failure", "SettingsPluginAudit", "settings-audit-06-failed-connection", "Same failure/retry state using a controlled fixture response."),
            ("OAuth consent / return", "SettingsPluginAudit", "settings-audit-07-authorization-return", "RELATED STATE ONLY: reference is Google's system consent prompt; native capture is the controlled authorization return. Real Google OAuth consent is not validated here."),
            ("Catalog authorization", "SettingsPluginAudit", "settings-audit-08-catalog-authorize", "Same authorization-needed state; catalog contents and labels can differ."),
            ("Settings top", "SettingsPluginAudit", "settings-audit-09-settings-top", "Same destination; fixture account, usage and update availability differ."),
            ("Catalog loading", "SettingsPluginAudit", "settings-audit-10-loading", "Loading state is deliberately held by the fixture. This image alone cannot establish a stuck loader."),
        ]),
        ("Files and photos", "1EB092A9-F9E2-4006-AABD-15FD6862C878", [
            ("ZIP preview", "AttachmentReference", "attachment-zip-preview-dark", "Same unsupported-file state; compare sheet header and explanatory text."),
            ("File messages", "AttachmentReference", "attachment-files-dark", "Inert attachments with similar filenames; server data, sizes and message layout may differ."),
            ("Markdown", "AttachmentReference", "attachment-reference-markdown", "Reference Markdown reproduced in the fixture; inspect headings, code, bullets and wrapping."),
            ("Inline images", "AttachmentReference", "attachment-inline-images", "Related image conversation, with synthetic fixture metadata. History and scroll position differ."),
            ("Photo actions", "AttachmentReference", "attachment-viewer-menu", "Same Forward / Share / Save actions. Compare menu material and geometry; logical viewport also affects caption wrapping."),
            ("Photo viewer", "AttachmentReference", "attachment-viewer", "Same viewer surface and reference-style image fixture. Compare letterboxing, caption wrapping and thumbnail selection at the different device widths."),
            ("Bot details / routines", "AttachmentReference", "attachment-profile", "Same profile area; routine records are fixture data, not the reference bot's exact records."),
        ]),
        ("Desktop", "4A689B08-AEF0-413D-880C-B529E7001213", [
            ("Desktop keyboard", "VNCValidation", "vnc-keyboard-open", "Live isolated Linux desktop with an instrumentation page. Compare viewport/controls only; desktop content differs."),
            ("Desktop overview", "VNCValidation", "vnc-keyboard-closed", "Live desktop. Letterboxing preserves the remote aspect ratio; image contents differ."),
            ("Starting desktop", "VNCValidation", "vnc-starting", "Same starting state; this does not prove latency or frame rate."),
        ]),
        ("Glass and sections", "633C7BA8-F901-43BB-BAA6-7D94B97E1D7B", [
            ("No sections", "GlassSections", "glass-home-without-sections", "Same unsectioned home behavior with different conversation records. The Unassigned heading should be absent."),
            ("Completed widget", "OpenTeamNative", "parity-user-form-completed-dark", "RELATED STATE ONLY: a different completed form fixture, not the exact Choose a route widget. Functional form checks do not prove 1:1 visual parity."),
            ("Glass over history", "GlassSections", "glass-dark-scrolled", "RELATED CONTENT: different conversation and scroll offset. Useful for material behavior, not pixel equality."),
            ("Glass / composer", "GlassSections", "glass-dark-resting", "RELATED CONTENT: native resting chat versus scrolled reference. Backdrop content changes the observed glass shade."),
            ("Profile glass", "AttachmentReference", "attachment-profile", "Same profile area; compare surface style, with different fixture routine data."),
        ]),
    ]
    manifest = {
        "context": json.loads((bundles / "context.json").read_text()),
        "method": "Original JPEGs and native XCTest PNGs are copied byte-for-byte and displayed at equal CSS width. No recoloring, cropping, registration or status-bar replacement. Reference logical device size and iOS settings are unknown.",
        "pairs": [], "gallery": [], "summaries": summaries,
    }
    cards = []
    esc = html.escape
    for group, folder, rows in groups:
        for number, (title, scheme, capture, note) in enumerate(rows, 1):
            source = args.reference_root / folder / f"{number}-Photo-{number}.jpg"
            ref = {"path": f"images/{folder}-{number}.jpg", "source": str(source), "sha256": sha(source)}
            shutil.copyfile(source, out / ref["path"])
            current = native(scheme, capture)
            wide = native("SevenReference-Wide", capture) if scheme == "SevenReference" else None
            row = {"group": group, "number": number, "title": title, "reference": ref, "native": current, "wide": wide, "note": note}
            manifest["pairs"].append(row)
            image_path = current["path"] if current else ""
            wide_path = wide["path"] if wide else ""
            device = "iPhone 16 Pro Max" if current and current["deviceId"] == manifest["context"]["functionalSimulator"] else "iPhone 16"
            right = f'<img class="native" loading="lazy" src="{image_path}" data-compact="{image_path}" data-wide="{wide_path}" data-device="{device}" alt="Native capture: {esc(title)}">' if current else '<p>Capture pending</p>'
            cards.append(f'''<section class="card" data-group="{esc(group)}"><h2>{esc(group)} · {number}. {esc(title)}</h2><p>{esc(note)}</p>
<div class="pair"><figure><figcaption>Grok Bot · supplied photo</figcaption><img loading="lazy" src="{ref['path']}" alt="Reference: {esc(title)}"></figure><figure><figcaption>OpenTeam · <span class="device">{device}</span>{' / wider capture available' if wide else ''}</figcaption>{right}</figure></div>
<div class="overlay" hidden><img loading="lazy" src="{ref['path']}" alt="Reference overlay base">{right}</div>
<details><summary>Capture provenance</summary><pre>{esc(json.dumps({k:v for k,v in row.items() if k in ['native','wide']}, indent=2))}</pre></details></section>''')
    gallery = []
    for name in ["home-light", "settings-light", "chat-light", "message-actions-light", "reply-light", "keyboard-sign-in-light", "keyboard-search-light", "keyboard-create-light", "keyboard-profile-light"]:
        item = native("Palette", "palette-" + name)
        if item:
            manifest["gallery"].append(item)
            gallery.append(f'<figure><figcaption>{esc(name)}</figcaption><img loading="lazy" src="{item["path"]}" alt="{esc(name)}"></figure>')
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    controls = ''.join(f'<button type="button" data-filter="{esc(g)}">{esc(g)}</button>' for g,_,_ in groups)
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam · fresh QA comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font:16px/1.5 system-ui}main{max-width:940px;margin:auto;padding:24px}h1{font-size:30px}h2{font-size:21px}a{color:#9ac9ff}.notice{background:#29251d;border-left:3px solid #e7ba65;padding:18px}.controls{position:sticky;top:0;z-index:3;background:#171717f5;padding:12px;border:1px solid #444;border-radius:10px;display:flex;gap:8px;flex-wrap:wrap}button,select{font:inherit;background:#292929;color:#fff;border:1px solid #666;border-radius:6px;padding:7px}button[aria-pressed=true]{background:#244563}label{display:flex;gap:8px;align-items:center}.card{margin:36px 0 60px}.card p{color:#ccc}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0}figcaption{padding:10px 0;font-size:14px;color:#bbb}img{display:block;width:100%;height:auto;cursor:zoom-in}.overlay{position:relative;width:50%;margin:18px auto}.overlay .native{position:absolute;left:0;top:0;opacity:var(--mix,.5)}pre{white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere}details{margin-top:12px}#gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.quiet{color:#aaa;font-size:14px}@media(max-width:600px){main{padding:12px}.pair{gap:8px}.overlay{width:100%}#gallery{grid-template-columns:repeat(2,1fr)}}[hidden]{display:none!important}
</style><main><h1>Fresh iPhone QA · side by side</h1><p>September 18, 2026 · baseline e9402bf / TestFlight 25 · iOS 26.5 simulators · plugin follow-up includes the local polling fix</p><p class="notice"><strong>Visual parity is not signed off.</strong> All 32 supplied reference images are included. Some are paired with related states or different fixture content, explicitly labeled below. The original phone's logical size and OS settings are unknown. Compare the two fresh native phone widths before attributing text density or wrapping to implementation.</p><p>Files are untouched and shown at equal width. Overlay is top-aligned and unregistered; it is a visual aid, not a pixel-difference score. Screenshot-test passes establish captured interaction states, not visual equality. Light-mode images have no supplied light-mode reference.</p><p><a href="manifest.json">Capture provenance and test results</a> · <a href="../qa-summary.md">QA findings</a></p><div class="controls"><button type="button" data-filter="all" aria-pressed="true">All 32</button>''' + controls + '''<label>Chat capture <select id="device"><option value="compact">iPhone 16</option><option value="wide">iPhone 16 Pro Max</option></select></label><label><input id="overlay" type="checkbox">Unregistered overlay</label><label>Opacity<input id="mix" type="range" min="0" max="100" value="50"></label></div>''' + ''.join(cards) + '''<h2>Additional light-mode checks</h2><p class="quiet">Fresh native captures only. No light-mode Grok Bot reference was supplied.</p><div id="gallery">''' + ''.join(gallery) + '''</div></main><script>
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.card').forEach(c=>c.hidden=b.dataset.filter!=='all'&&c.dataset.group!==b.dataset.filter);document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',x===b));});
document.querySelector('#device').onchange=e=>{document.querySelectorAll('.native').forEach(i=>{i.src=(e.target.value==='wide'&&i.dataset.wide)||i.dataset.compact;});document.querySelectorAll('.card').forEach(c=>{const i=c.querySelector('.native');c.querySelector('.device').textContent=e.target.value==='wide'&&i?.dataset.wide?'iPhone 16 Pro Max':(i?.dataset.device||'iPhone 16');});};
document.querySelector('#overlay').onchange=e=>document.querySelectorAll('.card').forEach(c=>{c.querySelector('.pair').hidden=e.target.checked;c.querySelector('.overlay').hidden=!e.target.checked;});
document.querySelector('#mix').oninput=e=>document.documentElement.style.setProperty('--mix',e.target.value/100);
document.querySelectorAll('img').forEach(i=>i.onclick=()=>window.open(i.src,'_blank','noopener'));
</script></html>'''
    ledger = bundles / "final-ui-manifest.json"
    if (bundles / "auth-comparison" / "review.html").exists():
        page = page.replace(
            '<p><a href="manifest.json">',
            '<p><a href="../auth-comparison/review.html">Eight React Native / Swift sign-in and server/IP comparisons</a></p><p><a href="manifest.json">')
    if ledger.exists():
        result = json.loads(ledger.read_text())
        counts = result["counts"]
        prefix = "Unique UI cases" if result.get("allRunsFinished") else "Completed UI cases so far"
        message = (f"<p><strong>{prefix}: {counts.get('passed', 0)} passed, "
                   f"{counts.get('failed', 0)} failed, {counts.get('skipped', 0)} skipped.</strong> "
                   "Performance budgets and physical-device limits are reported separately. "
                   "Repeat device runs are counted once.</p>")
        page = page.replace('<p><a href="manifest.json">', message + '<p><a href="manifest.json">')
    (out / "review.html").write_text(page)
    if args.landing_page:
        landing = args.landing_page.resolve()
        landing.parent.mkdir(parents=True, exist_ok=True)
        prefix = Path(os.path.relpath(out, landing.parent)).as_posix()
        root_page = re.sub(r'((?:src|data-compact|data-wide)=")(?P<path>images/[^"\n]*)"',
                           lambda m: m[1] + prefix + "/" + m["path"] + '"', page)
        for old, target in [
            ("manifest.json", out / "manifest.json"),
            ("../qa-summary.md", bundles / "qa-summary.md"),
            ("../auth-comparison/review.html", bundles / "auth-comparison/review.html"),
        ]:
            relative = Path(os.path.relpath(target, landing.parent)).as_posix()
            root_page = root_page.replace(f'href="{old}"', f'href="{html.escape(relative, quote=True)}"')
        landing.write_text(root_page)
    print(json.dumps({"review": str(out / "review.html"), "pairs": len(manifest["pairs"]), "ready": sum(bool(x["native"]) for x in manifest["pairs"]), "wide": sum(bool(x["wide"]) for x in manifest["pairs"]), "light": len(gallery)}))


if __name__ == "__main__":
    main()
