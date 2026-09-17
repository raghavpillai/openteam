#!/usr/bin/env python3
"""Compare original reference files with original native palette captures."""
import argparse, hashlib, html, json, shutil, subprocess
from collections import Counter
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--bundle', type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
evidence = out / ('evidence-' + args.bundle.stem)
if not (evidence / 'manifest.json').exists():
    subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(args.bundle), '--output-path', str(evidence)], check=True, stdout=subprocess.DEVNULL)
summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(args.bundle), '--format', 'json']))
(out / 'test-summary.json').write_text(json.dumps(summary, indent=2))
captures = {}
all_captures = []
for test in json.loads((evidence / 'manifest.json').read_text()):
    for a in test['attachments']:
        name = a['suggestedHumanReadableName'].split('_0_')[0]
        if name.startswith('palette-') and a['exportedFileName'].endswith('.png'):
            p = evidence / a['exportedFileName']
            item = dict(name=name, path=str(p.relative_to(out)), test=test['testIdentifier'], timestamp=a['timestamp'], sha256=hashlib.sha256(p.read_bytes()).hexdigest())
            all_captures.append(item)
            if name not in captures or captures[name]['timestamp'] < item['timestamp']:
                captures[name] = item
attachments = Path('/tmp/codex-remote-attachments')
refs = {
 'settings-light':attachments/'01a09d9b-267d-7c02-a0e9-51e5bf272cb2/39A03BAD-F4F1-4F7D-A1F8-0D3B7E59C0E8/1-Photo-1.jpg',
 'settings-dark':attachments/'01a0aa4c-4ed2-7292-aea8-32f38accb962/57935E3D-22A4-4D48-97E8-493BFDC2D278/6-Photo-6.jpg',
 'chat-dark':attachments/'01a0aa4c-4ed2-7292-aea8-32f38accb962/57935E3D-22A4-4D48-97E8-493BFDC2D278/5-Photo-5.jpg',
 'home-light':attachments/'01a0aa4c-4ed2-7292-aea8-32f38accb962/61C50BA6-86A9-48DF-9DE7-597C16ACB9C0/1-Photo-1.jpg',
 'create-light':attachments/'01a09d9b-267d-7c02-a0e9-51e5bf272cb2/1FC4E9B6-C7ED-4FF7-AD90-4B0F7715F0C8/1-Photo-1.jpg',
 'create-dark':attachments/'01a0aa4c-4ed2-7292-aea8-32f38accb962/09B9428E-4482-485E-B0A0-6B438AFB8A75/3-Photo-3.jpg',
}
(out/'reference').mkdir(exist_ok=True)
provenance = {}
for key, p in refs.items():
    target = out/'reference'/f'{key}.jpg'
    shutil.copyfile(p,target)
    provenance[key] = dict(source=str(p), path=str(target.relative_to(out)), sha256=hashlib.sha256(p.read_bytes()).hexdigest())
def sample(path, box):
    im = Image.open(path).convert('RGB')
    pixels = im.crop(tuple(round(v * im.width / 440) for v in box)).get_flattened_data()
    return list(Counter(pixels).most_common(1)[0][0])
checks = []
for key, role, box, expected in [
 ('settings-light','Grouped card',[300,240,315,250],[242]*3),
 ('settings-dark','Grouped card',[300,240,315,250],[32]*3),
 ('chat-dark','Background',[4,400,10,420],[20]*3),
 ('chat-dark','Assistant bubble',[33,540,42,555],[32]*3),
 ('chat-dark','User bubble',[409,404,414,412],[92]*3),
 ('create-light','Disabled primary fill',[100,890,175,905],[132]*3),
 ('create-dark','Disabled primary fill',[100,890,175,905],[154]*3),
 ('chat-dark','Resting composer',[310,888,350,894],[51]*3),
]:
    ref = sample(refs[key], box)
    native = sample(out/captures['palette-'+key]['path'],box)
    checks.append(dict(screen=key,role=role,boxAt440PointWidth=box,reference=ref,native=native,expected=expected,match=ref==native==expected))
# Every collected light/dark round trip must retain the same solid card color.
for item in all_captures:
    if item['name'].startswith(('palette-settings-', 'palette-account-')):
        expected = [32]*3 if item['name'].endswith('dark') else [242]*3
        value = sample(out/item['path'], [300,240,315,250])
        assert value == expected, (item['name'], value, expected)
assert all(c['match'] for c in checks), checks
(out/'measurements.json').write_text(json.dumps(checks,indent=2))
(out/'manifest.json').write_text(json.dumps(dict(bundle=str(args.bundle.resolve()),captures=all_captures,references=provenance,normalization='Original images unchanged; displayed at equal 440-point width. Samples use nearest integer source coordinates, without resizing or color correction.'),indent=2))
def figure(label,path):
    return f'<figure><figcaption>{html.escape(label)}</figcaption><a href="{path}"><img loading="lazy" src="{path}" alt="{html.escape(label)}"></a></figure>'
sections=[]
for key in ['settings-light','settings-dark','chat-dark','home-light','create-light','create-dark']:
    sections.append(f'<section><h2>{key.replace("-"," ").title()}</h2><div class="pair">'+figure('Grok Bot reference',provenance[key]['path'])+figure('OpenTeam native',captures['palette-'+key]['path'])+'</div></section>')
for screen in ['account','chat','message-actions','reply','document']:
    sections.append(f'<section><h2>{screen.replace("-"," ").title()} · both themes</h2><div class="pair">'+''.join(figure('OpenTeam '+mode,captures[f'palette-{screen}-{mode}']['path']) for mode in ['light','dark'])+'</div></section>')
rows=''.join(f'<tr><td>{c["screen"]}</td><td>{c["role"]}</td><td>{c["reference"]}</td><td>{c["native"]}</td></tr>' for c in checks)
(out/'review.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam color validation</title><style>body{background:#111;color:#eee;font:16px system-ui;margin:24px}main{max-width:920px;margin:auto}p{line-height:1.55}a{color:#8fbfff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}figcaption{padding:12px 0;color:#aaa}img{width:100%;height:auto}section{margin-top:40px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:10px;border-bottom:1px solid #444;font-size:14px}nav{margin:20px 0}@media(max-width:600px){body{margin:12px}.pair{gap:8px}}</style><main><h1>Light and dark color validation</h1><p>One shared palette now covers settings, native forms and lists, chat, action colors and offline documents. Dark cards use neutral #202020. Launch retains the requested pure black/white background and existing robot artwork.</p><p>These are original screenshots, displayed at equal width. Solid-color samples can match exactly; Liquid Glass, system menus, keyboards, antialiased text and JPEG compression prevent a universal pixel-for-pixel claim. Existing layout and feature gaps are tracked in the earlier QA reports.</p><p>Palette interaction checks: '''+f'{summary["passedTests"]} passed, {summary["failedTests"]} failed, {summary["skippedTests"]} skipped.'+'''</p><nav><a href="manifest.json">Image provenance</a> · <a href="measurements.json">Pixel samples</a> · <a href="test-summary.json">Test results</a> · <a href="../../apps/mobile-swift/docs/COLOR-VALIDATION-0916.md">Changes and scope</a></nav><table><thead><tr><th>Screen</th><th>Surface</th><th>Reference RGB</th><th>Native RGB</th></tr></thead><tbody>'''+rows+'</tbody></table>'+''.join(sections)+'</main></html>')
print(json.dumps(checks,indent=2))
print(out/'review.html')
