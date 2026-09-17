#!/usr/bin/env python3
"""Export XCTest screenshots and build a local comparison report without modifying image pixels."""
from pathlib import Path
import html
import json
import shutil
import subprocess
import sys
import tempfile

if len(sys.argv) != 3:
    raise SystemExit('Usage: export-comparison.py <result.xcresult> <output-directory>')
result, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
captured = set()
with tempfile.TemporaryDirectory(prefix='openteam-xctest-') as directory:
    attachments = Path(directory)
    subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result), '--output-path', str(attachments)], check=True, stdout=subprocess.DEVNULL)
    for group in json.loads((attachments / 'manifest.json').read_text()):
        for item in group['attachments']:
            source = attachments / item['exportedFileName']
            name = item['suggestedHumanReadableName'].split('_0_')[0]
            if name.startswith(('native-', 'reference-')) and source.suffix == '.png':
                shutil.copyfile(source, output / (name + '.png'))
                captured.add(name + '.png')
rows = []
for key, title in [('home-light','Conversations'), ('chat-light','Chat'), ('keyboard-short','Keyboard · one line'), ('keyboard-multiline','Keyboard · multiline'), ('settings-light','Settings')]:
    cells = []
    for kind in ['reference', 'native']:
        path = output / (kind + '-' + key + '.png')
        cells.append(f'<figure><figcaption>{"React Native" if kind == "reference" else "Swift native"}</figcaption><img src="{html.escape(path.name)}" alt="{html.escape(title)} in {kind}" loading="lazy"></figure>' if path.name in captured else f'<figure><figcaption>{kind}</figcaption><p>Not captured in this run.</p></figure>')
    rows.append(f'<section><h2>{html.escape(title)}</h2><div class="pair">{"".join(cells)}</div></section>')
extras=[]
for name in ['native-settings-dark', 'native-chat-dark', 'native-approval', 'native-search', 'native-create-bot', 'native-offline-queued', 'native-offline-recovered']:
    if name + '.png' in captured: extras.append(f'<figure><figcaption>{html.escape(name.replace("native-", "").replace("-", " ").capitalize())}</figcaption><img src="{name}.png" alt="{name}" loading="lazy"></figure>')
summary = json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',str(result)]))
summary['sourceResultBundle'] = str(result)
summary['exportedScreenshots'] = sorted(captured)
(output / 'summary.json').write_text(json.dumps(summary, indent=2))
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam · native iOS comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f3;color:#161615;font:16px system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:42px 22px}h1{font-size:38px;letter-spacing:-1.4px;margin:12px 0}h2{font-size:23px;letter-spacing:-.5px}p{line-height:1.65;color:#555;max-width:800px}.eyebrow{color:#b84524;font-size:13px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.extras{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}figure{margin:0;min-width:0}figcaption{font-size:14px;font-weight:600;margin:10px 0}img{width:100%;height:auto;border:1px solid #ddd;border-radius:16px;background:white}section{padding-top:28px;border-top:1px solid #d9d9d5;margin-top:34px}.badge{display:inline-block;background:#e2eee1;color:#254d29;padding:8px 12px;border-radius:30px;font-size:14px}@media(max-width:600px){main{padding:24px 12px}.pair{gap:10px}.extras{grid-template-columns:1fr 1fr}h1{font-size:30px}}</style><main><div class="eyebrow">OpenTeam / Swift migration / 16 September 2026</div><h1>Same server. Two iOS clients.</h1><p>Unedited simulator screenshots captured by XCTest against the same isolated sample-data server. The Swift app is an initial native migration, with its own bundle ID. These comparisons verify the captured flows; they are not a full feature-parity sign-off.</p>'''
page += f'<span class="badge">{summary["passedTests"]} tests passed · {summary["failedTests"]} failed · {summary["skippedTests"]} skipped</span>'
page += ''.join(rows) + '<section><h2>Additional native checks</h2><div class="extras">' + ''.join(extras) + '</div></section><p>Release gates still open: native APNs, full plugin workspace, advanced rendering, complete computer gestures and signed physical-device validation. See apps/mobile-swift/docs/PARITY.md.</p></main></html>'
(output / 'index.html').write_text(page)
print(output / 'index.html')
