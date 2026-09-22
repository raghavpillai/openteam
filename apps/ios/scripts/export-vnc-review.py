"""Show original reference photos beside unedited native captures; no raster compositing."""
from pathlib import Path
import hashlib, html, json
root = Path(__file__).resolve().parents[3] / 'output/swift-vnc-qa-0916'
found = {}
for folder in ['native-evidence', 'followup-evidence', 'foreground-evidence']:
    for case in json.loads((root / folder / 'manifest.json').read_text()):
        for item in case['attachments']:
            name = item['suggestedHumanReadableName'].split('_0_')[0]
            if item['exportedFileName'].endswith('.png'):
                found[name] = folder + '/' + item['exportedFileName']
refs = []
rows = []
notes = {
    'keyboard-open': 'Aspect ratio matches. The native desktop starts about 22 points lower.',
    'keyboard-closed': 'Native desktop is about 10 points lower; bottom buttons are larger and higher. Actual desktop contents differ.',
    'starting': 'Real native loading state, captured with a delayed status response. Loading text is about 41 points lower.',
}
for state in ['keyboard-open', 'keyboard-closed', 'starting']:
    ref = 'reference/' + state + '.jpg'
    refs.append({'file': ref, 'sha256': hashlib.sha256((root / ref).read_bytes()).hexdigest()})
    native = found['vnc-' + state]
    title = state.replace('-', ' ').title()
    rows.append(f'<section><h2>{title}</h2><p>{notes[state]}</p><div class="pair"><figure><figcaption>Grok Bot reference</figcaption><a href="{ref}"><img src="{ref}" alt="Reference {state}"></a></figure><figure><figcaption>Actual Swift app</figcaption><a href="{native}"><img src="{native}" alt="Native {state}"></a></figure></div></section>')
extra = []
for name in ['clipboard-retry','touch-drag-and-zoom','disconnected','lease-returned','trackpad-movement','two-finger-right-click']:
    if 'vnc-' + name in found:
        path = found['vnc-' + name]
        extra.append(f'<figure><figcaption>{html.escape(name.replace("-", " "))}</figcaption><a href="{path}"><img loading="lazy" src="{path}" alt="{name}"></a></figure>')
(root / 'reference-manifest.json').write_text(json.dumps(refs, indent=2))
(root / 'review.html').write_text('''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native desktop / VNC QA</title><style>body{font:16px system-ui;background:#111;color:#eee;margin:28px}main{max-width:1000px;margin:auto}p{max-width:850px;line-height:1.5}a{color:#77baff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}figure{margin:0}figcaption{padding:10px 0;color:#aaa}img{width:100%;height:auto;border-radius:12px;border:1px solid #333}section{margin:36px 0}.extra{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}@media(max-width:600px){body{margin:12px}.pair{gap:10px}.extra{grid-template-columns:1fr 1fr}}</style><main><h1>Native desktop / VNC validation</h1><p>Live authenticated API and actual Linux desktop. Startup, typing/retry, direct drag/zoom and foreground lease recovery pass. Trackpad movement, two-finger right-click and the rapid tap/double-tap/hold sequence fail. Two-finger scrolling is also absent in the native code. Swift currently polls screenshots about once per second.</p><p><a href="../../apps/ios/docs/VNC-QA-0916.md">Full findings and test boundaries</a> · <a href="vnc-transport-verified.json">VNC transport observations</a> · <a href="backend-input-checks.json">Actual API input checks</a></p>''' + ''.join(rows) + '<h2>Additional evidence</h2><div class="extra">' + ''.join(extra) + '</div></main>')
print(root / 'review.html')
