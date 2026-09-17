#!/usr/bin/env python3
"""Pair the five September 16 references with unretouched XCTest screenshots."""
import argparse
import hashlib
import html
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('result_bundle', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--reference-dir', required=True, type=Path)
parser.add_argument('--additional', action='append', default=[], type=Path)
parser.add_argument('--validation', action='append', default=[], type=Path,
                    help='Record passing device checks without replacing reference-sized captures')
args = parser.parse_args()
out = args.output.resolve()
for name in ['captures', 'references', 'pairs']:
    (out / name).mkdir(parents=True, exist_ok=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

captures = {}
runs = []
for bundle in [args.result_bundle] + args.additional + args.validation:
    summary = json.loads(subprocess.check_output([
        'xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(bundle)]))
    assert summary['failedTests'] == 0 and summary['skippedTests'] == 0, summary
    runs.append({'bundle': str(bundle.resolve()), 'summary': summary})
    if bundle in args.validation:
        continue
    with tempfile.TemporaryDirectory(prefix='floating-review-') as tmp:
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(bundle),
                        '--output-path', tmp], check=True, stdout=subprocess.DEVNULL)
        for group in json.loads((Path(tmp) / 'manifest.json').read_text()):
            for item in group['attachments']:
                name = item['suggestedHumanReadableName'].split('_0_')[0]
                if not name.startswith('grok-native-'):
                    continue
                target = out / 'captures' / (name + '.png')
                shutil.copyfile(Path(tmp) / item['exportedFileName'], target)
                with Image.open(target) as screenshot:
                    assert screenshot.width >= 320 and screenshot.height >= 640, (
                        'Missing or invalid simulator screenshot', target)
                captures[name.removeprefix('grok-native-')] = {
                    'image': str(target.relative_to(out)), 'sha256': digest(target),
                    'resultBundle': str(bundle.resolve()), 'test': group.get('testIdentifier')}

cases = [
    (1, 'Home', 'home', 'Floating account, search and create controls. The connected account and our desktop robots are retained.'),
    (2, 'Search', 'search', 'Native keyboard and search capsule. Results can scroll beneath the floating controls.'),
    (3, 'Conversation hold menu', 'home-menu', 'Native menu lift and blur. Menu contents and height follow supported OpenTeam actions; Grokbot-only actions are not added.'),
    (4, 'Message hold menu', 'message-actions', 'Reactions, Reply, Start a thread, Mark as unread and Copy. The conversation behind the sheet is at a different scroll offset.'),
    (5, 'Home while scrolling', 'home-scrolled', 'Rows remain visible behind the controls. The full-width header backing has been removed. Scroll offset is captured from an actual drag.'),
]
rows = []
articles = []
for number, title, name, note in cases:
    source = args.reference_dir / f'{number}-Photo-{number}.jpg'
    reference = out / 'references' / source.name
    shutil.copyfile(source, reference)
    capture = captures[name]
    row = {'photo': number, 'title': title, 'reference': str(reference.relative_to(out)),
           'referenceSource': str(source.resolve()), 'referenceSHA256': digest(source),
           'swift': capture, 'note': note}
    images = [Image.open(reference).convert('RGB'), Image.open(out / capture['image']).convert('RGB')]
    images = [im.resize((440, round(im.height * 440 / im.width)), Image.Resampling.LANCZOS) for im in images]
    pair = Image.new('RGB', (904, max(im.height for im in images) + 38), '#191919')
    draw = ImageDraw.Draw(pair)
    draw.text((10, 12), f'Photo {number} - supplied reference', fill='white')
    draw.text((474, 12), 'Swift - actual simulator capture', fill='white')
    pair.paste(images[0], (0, 38)); pair.paste(images[1], (464, 38))
    pair.save(out / 'pairs' / f'{number}.png')
    row['pair'] = f'pairs/{number}.png'
    rows.append(row)
    articles.append(f'''<article id="photo-{number}"><h2>{number}. {html.escape(title)}</h2>
<p>{html.escape(note)}</p><button onclick="this.closest('article').classList.toggle('overlay')">Side by side / Overlay</button>
<div class="pair"><figure><figcaption>Photo {number} · reference</figcaption><img src="{row['reference']}" alt="Supplied photo {number}"></figure>
<figure><figcaption>Swift · current capture</figcaption><img src="{capture['image']}" alt="Native {html.escape(title)}"></figure></div>
<a download href="pairs/{number}.png">Download comparison</a></article>''')

extra_names = [('inline-reply-draft', 'Hold → Reply'), ('inline-reply-queued', 'Offline quote'),
    ('inline-reply-queued-reopened', 'Reopened while offline'), ('inline-reply-sent', 'Delivered inline'),
    ('inline-reply-original', 'Quote → original message'), ('reply-after-swipe', 'Swipe → Reply'),
    ('chat-scrolled-light', 'Scrolled chat · light'), ('chat-scrolled-dark', 'Scrolled chat · dark'),
    ('chat-scrolled-keyboard-light', 'Keyboard · light'), ('chat-scrolled-keyboard-dark', 'Keyboard · dark')]
extras = ''.join(f'<figure><figcaption>{html.escape(title)}</figcaption><a href="{captures[name]["image"]}"><img src="{captures[name]["image"]}" alt="{html.escape(title)}" loading="lazy"></a></figure>'
                 for name, title in extra_names if name in captures)
manifest = {'normalization': 'Original screenshots copied unchanged. Download pairs resize to 440 points wide, without cropping, registration, color changes or status-bar replacement.',
            'runs': runs, 'cases': rows, 'captures': captures}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
nav = ''.join(f'<a href="#photo-{i}">Photo {i}</a>' for i in range(1, 6))
passed = sum(r['summary']['passedTests'] for r in runs)
page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replies and floating controls · Swift review</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color:#efefef;background:#191919}body{max-width:1080px;margin:auto;padding:32px 24px}h1{font-size:34px;letter-spacing:-1px}h2{font-size:23px}p{line-height:1.6;color:#bababa;max-width:880px}a{color:#9ac6ff}nav{position:sticky;top:0;z-index:2;background:#191919ee;display:flex;gap:20px;padding:16px 0;flex-wrap:wrap}article{margin:60px 0;scroll-margin-top:70px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:904px}figure{margin:0}figcaption{font-size:14px;font-weight:600;margin:12px 0}img{display:block;width:100%;border-radius:8px}button{border:1px solid #555;background:#303030;color:white;border-radius:8px;padding:9px 12px;cursor:pointer}article>a{display:inline-block;margin-top:14px}.overlay .pair{display:block;position:relative;max-width:440px}.overlay figure:nth-child(2){position:absolute;inset:0;opacity:.5}.overlay figcaption{display:none}.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.verified{background:#252525;padding:18px 22px;border-radius:14px}.verified p{margin:6px 0}@media(max-width:650px){body{padding:20px 12px}h1{font-size:28px}.pair{gap:10px}.gallery{grid-template-columns:1fr 1fr;gap:12px}}
</style><h1>Replies and floating controls</h1>
<p>Five supplied photos beside actual Swift simulator captures. Our OpenTeam desktop robots remain the app's characters.</p>
<div class="verified"><strong>Inline replies + hold to reply + swipe to reply</strong><p>The held reply was checked at the server: it retains the original message ID and stays in the main conversation. The quote can return to the original. Queued replies keep the quote visible through reconnect.</p><p>Full-width header and composer layers are removed. Native glass provides the backdrop and shadow inside individual controls; iOS supplies the soft scroll-edge fade.</p>'''
page += f'<p>{passed} test executions passed across {len(runs)} runs · 0 failures. <a href="manifest.json">Capture provenance and test results</a></p></div>'
page += '<p>These are review comparisons, not a whole-screen pixel-perfect sign-off. Account identity, our robots, supported menu actions, system UI and scroll offsets can differ.</p><nav>' + nav + '<a href="#reply-checks">Reply checks</a></nav>'
page += ''.join(articles) + '<section id="reply-checks"><h2>Replies and scrolled chat</h2><div class="gallery">' + extras + '</div></section></html>'
(out / 'index.html').write_text(page)
print(f'Exported {len(rows)} photo comparisons and {len(captures)} native captures to {out}')
