#!/usr/bin/env python3
"""Export real XCTest captures, normalize source screenshots, and build a local review.

Needs Pillow; no pixels are retouched. Reference/source paths and crops are recorded.
"""
import argparse
import hashlib
import html
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('result_bundle', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--additional', type=Path, action='append', default=[])
parser.add_argument('--references', type=Path, default=Path('output/mobile-every-screenshot-0915/manifest.json'))
parser.add_argument('--online', type=Path, default=Path('output/swift-grokbot-visual-0916/references-online'))
parser.add_argument('--gesture-video', type=Path)
parser.add_argument('--gesture-time', type=float)
parser.add_argument('--gesture-result', type=Path)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
raw = out / 'captures'
raw.mkdir(exist_ok=True)
summary = json.loads(subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(args.result_bundle)]))
(out / 'test-summary.json').write_text(json.dumps(summary, indent=2))
exported = set()
capture_bundles={}
extra_results=[]
for bundle in [args.result_bundle]+args.additional:
    result=json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',str(bundle)]))
    assert result['failedTests']==0 and result['skippedTests']==0,result
    if bundle!=args.result_bundle: extra_results.append({'bundle':str(bundle.resolve()),'passed':result['passedTests'],'failed':result['failedTests']})
    with tempfile.TemporaryDirectory(prefix='grokbot-xctest-') as tmp:
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(bundle), '--output-path', tmp], check=True, stdout=subprocess.DEVNULL)
        for group in json.load(open(Path(tmp) / 'manifest.json')):
            for item in group['attachments']:
                name = item['suggestedHumanReadableName'].split('_0_')[0]
                if name.startswith('grok-native-'):
                    filename = name + '.png'
                    shutil.copyfile(Path(tmp) / item['exportedFileName'], raw / filename)
                    exported.add(filename)
                    capture_bundles[filename]=str(bundle.resolve())

names = {1:'long-keyboard',2:'long-chat',3:'long-chat',4:'long-keyboard',5:'long-chat',6:'thinking',7:'short-draft',8:'thinking-keyboard',9:'settings',10:'search',11:'create-menu',12:'settings',13:'create-bot',14:'message-actions',15:'reply-after-swipe',16:'home',17:'home-menu',18:'settings',19:'search',20:'create-menu',21:'long-chat'}
gesture = None
if args.gesture_video is not None:
    if args.gesture_time is None: parser.error('--gesture-video requires --gesture-time')
    video = args.gesture_video.resolve()
    frame = raw / 'grok-native-reply-mid-swipe.png'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(args.gesture_time),'-i',str(video),'-frames:v','1',str(frame)],check=True)
    exported.add(frame.name)
    names[15]='reply-mid-swipe'
    gesture={'sourceVideo':str(video),'timestampSeconds':args.gesture_time,'sourceVideoSHA256':hashlib.sha256(video.read_bytes()).hexdigest(),'sourceImage':str(frame.relative_to(out))}
if gesture and args.gesture_result:
    result=json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',str(args.gesture_result)]))
    assert result['failedTests']==0 and result['skippedTests']==0,result
    gesture['resultBundle']=str(args.gesture_result.resolve())
    gesture['tests']={'passed':result['passedTests'],'failed':result['failedTests']}
notes = {
    1:'The system keyboard follows the installed iOS version. History scroll offset and backdrop blur remain separate visual checks.',
    2:'Same history fixture. Scroll offset and header overlap must be reviewed, not counted as a pixel-identical match.',
    3:'Earlier OpenTeam screenshot, retained for provenance; this is not a Grokbot target.',
    6:'Our OpenTeam desktop robot and thinking animation, ported to native Swift. The Grokbot character is intentionally not the target. Stop remains available while a run is active.',
    7:'The most directly comparable static state: matching text, theme and screen dimensions. System status indicators differ.',
    8:'Keyboard layout, dictation and prediction belong to iOS and can differ by OS version and user settings.',
    9:'Account/server data and supported settings are real OpenTeam fields; Grok subscription, quota and email rows are not fabricated.',
    10:'Results use the same bot names. Native system keyboard and account-specific descriptions can differ.',
    11:'Native iOS Menu. Source is a partial screen crop; the Swift image is cropped to the same region.',
    12:'Earlier OpenTeam account crop, not a Grokbot target. Swift shows the connected account.',
    13:'Empty create form, matching default shape and color. Controls create a real bot on the isolated fixture.',
    14:'Native sheet with reactions and working Reply, Thread, Unread and Copy actions. Message scroll offset is a separate difference.',
    15:'STATE GAP: reference shows a drag in progress; this capture proves the completed native swipe opens reply. It is not a mid-drag pixel comparison.',
    16:'Same nine conversation names and previews. Account initials remain those of the connected fixture account.',
    17:'Actual native context menu, including system lift and blur. Available actions follow OpenTeam capabilities.',
    21:'Only the Grokbot portion of the supplied composite is used. Header crop is explicitly recorded.',
}
if gesture:
    notes[15]=f'Actual simulator video frame at {args.gesture_time:.3f}s during the tested reply drag. The reference and native frame show the same message in progress; scroll/drag displacement and glyph differences remain inspectable. Source video and timestamp are recorded in the manifest.'
rows=[]
normalized=out/'normalized'; normalized.mkdir(exist_ok=True)
def normalize(source, crop, dest):
    image=Image.open(source).convert('RGB')
    if crop: image=image.crop(crop)
    image.resize((440, round(image.height*440/image.width)), Image.Resampling.LANCZOS).save(dest)
    return list(image.size)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
for ref in json.load(open(args.references)):
    idx=ref['id']; duplicate=ref.get('duplicateOf'); source=Path(ref['reference'])
    stem=f'{idx:02}'
    refpath=normalized/(stem+'-reference.png')
    refsize=normalize(source,ref.get('referenceCrop'),refpath)
    capture=raw/('grok-native-'+names[idx]+'.png')
    current=normalized/(stem+'-swift.png')
    available=capture.name in exported
    crop=ref.get('currentCrop') if idx in (3,11,12,20,21) else None
    if available: normalize(capture,crop,current)
    old=Path(ref['current']); oldpath=normalized/(stem+'-prior-rn.png')
    if old.exists(): normalize(old,ref.get('currentCrop'),oldpath)
    note=notes.get(idx,notes.get(duplicate,''))
    if duplicate: note=f'Repeated supplied reference (case {duplicate}). '+note
    rows.append({'id':idx,'title':ref['title'],'kind':ref['kind'],'duplicateOf':duplicate,'referenceSource':str(source),'referenceSHA256':digest(source),'referenceCrop':ref.get('referenceCrop'),'referenceImage':str(refpath.relative_to(out)),'swiftImage':str(current.relative_to(out)) if available else None,'swiftSource':str(capture.relative_to(out)) if available else None,'swiftResultBundle':capture_bundles.get(capture.name),'swiftSHA256':digest(capture) if available else None,'swiftCrop':crop,'priorRNImage':str(oldpath.relative_to(out)) if old.exists() else None,'note':note})
manifest={'sourceResultBundle':str(args.result_bundle.resolve()),'gestureFrame':gesture,'additionalTestRuns':extra_results,'normalization':'Resize to 440 points wide; crop only where specified. No retouching, color correction, registration or status-bar replacement.','tests':{'passed':summary.get('passedTests'),'failed':summary.get('failedTests'),'skipped':summary.get('skippedTests')},'cases':rows}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))

# Quantitative measurement of the most comparable same-content scene. Select exact-color
# bubble pixels; row/column extents avoid counting anti-aliased rims as solid fill.
def bubble_boxes(path, value):
    image=Image.open(path).convert('RGB'); w,h=image.size
    pixels=image.load(); active=[]
    for y in range(int(h*.45),int(h*.91)):
        xs=[x for x in range(w) if pixels[x,y]==(value,value,value)]
        if len(xs)>w*.12: active.append((y,min(xs),max(xs)))
    groups=[]
    for item in active:
        if not groups or item[0]>groups[-1][-1][0]+1: groups.append([])
        groups[-1].append(item)
    return [[round(min(i[1] for i in g)*440/w,2),round(g[0][0]*440/w,2),round((max(i[2] for i in g)+1)*440/w,2),round((g[-1][0]+1)*440/w,2)] for g in groups if len(g)>h*.015]
static=next(r for r in rows if r['id']==7)
measurements={}
if static['swiftSource']:
    for key,path in [('reference',Path(static['referenceSource'])),('swift',out/static['swiftSource'])]:
        im=Image.open(path).convert('RGB')
        measurements[key]={'userBubblePoints':bubble_boxes(path,92),'assistantBubblePoints':bubble_boxes(path,32),'backgroundRGB':im.getpixel((int(im.width*.5),int(im.height*.3))),'headerInteriorRGB':im.getpixel((int(im.width*145/440),int(im.height*76/956))),'composerInteriorRGB':im.getpixel((int(im.width*210/440),int(im.height*915/956)))}
(out/'measurements.json').write_text(json.dumps(measurements,indent=2))

esc=html.escape
parts=[]
for r in rows:
    swift=f'<img src="{r["swiftImage"]}" alt="Actual Swift capture">' if r['swiftImage'] else '<p>Not captured in this run.</p>'
    prior=f'<details><summary>Earlier React Native capture (historical)</summary><img class="prior" src="{r["priorRNImage"]}"></details>' if r['priorRNImage'] else ''
    parts.append(f'''<article id="case-{r['id']}" data-kind="{esc(r['kind'])}"><h2>{r['id']:02} · {esc(r['title'])}</h2><p>{esc(r['note'])}</p><button class="overlay-toggle" onclick="this.closest('article').classList.toggle('overlaying')">Side by side / Overlay</button><input class="overlay-range" aria-label="Swift overlay opacity" type="range" min="0" max="1" step="0.01" value="0.5" oninput="this.closest('article').style.setProperty('--overlay-opacity',this.value)"><div class="pair"><figure><figcaption>{esc(r['kind'])}</figcaption><img src="{r['referenceImage']}" alt="Supplied reference"></figure><figure><figcaption>Swift native · current run</figcaption>{swift}</figure></div>{prior}</article>''')
online=''
if args.online.exists():
    dest=out/'online'; shutil.copytree(args.online,dest,dirs_exist_ok=True)
    online='<section><h2>Official online references</h2><p>Supporting App Store captures. These are not substituted for actual native test output. <a href="https://apps.apple.com/us/app/grok-bot/id6794501026">App Store source</a> · <a href="https://x.ai/news/introducing-grok-bot">xAI announcement</a></p><div class="gallery">'+''.join(f'<img src="online/{p.name}" alt="Official Grok Bot App Store image">' for p in sorted(dest.glob('*.webp')))+'</div></section>'
nav=''.join(f'<a href="#case-{r["id"]}">{r["id"]:02}</a>' for r in rows)
page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grokbot → Swift native visual review</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color:#e8e8e8;background:#151515}body{margin:0 auto;max-width:1180px;padding:32px 24px}h1{font-size:32px;letter-spacing:-1px}h2{font-size:22px;margin:0 0 12px}p{color:#b6b6b6;max-width:920px;line-height:1.55}a{color:#9dc9ff}nav{position:sticky;top:0;background:#151515ed;padding:14px 0;display:flex;flex-wrap:wrap;gap:14px;z-index:2}.meta{padding:18px 22px;background:#242424;border-radius:16px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}figure{margin:0;max-width:440px}figcaption{font-weight:600;font-size:14px;color:#ccc;margin:10px 0}img{max-width:100%;display:block;border-radius:8px}article,section{margin-top:64px;scroll-margin-top:65px}.overlay-toggle{background:#292929;color:#ddd;border:1px solid #444;padding:8px 12px;border-radius:8px;margin:0 0 12px;cursor:pointer}.overlay-range{display:none;margin-left:12px}.overlaying .overlay-range{display:inline-block}.overlaying .pair{position:relative;display:block;max-width:440px}.overlaying .pair figure:nth-child(2){position:absolute;inset:0;opacity:var(--overlay-opacity,.5)}.overlaying figcaption{display:none}.prior{width:320px;margin-top:18px}summary{cursor:pointer;margin-top:20px;color:#9dc9ff}.gallery{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}pre{overflow:auto;font-size:13px;line-height:1.5;padding:20px;background:#222;border-radius:12px}@media(max-width:650px){body{padding:20px 12px}.pair{gap:10px}.gallery{grid-template-columns:repeat(2,1fr)}h1{font-size:26px}}
</style><h1>Grokbot → Swift native</h1><p>Direct comparison of all 21 supplied references with current simulator output. OpenTeam account identity and real capabilities are preserved. Our OpenTeam desktop robot replaces the Grokbot character by request; compare the surrounding UI here. <a href="../index.html">Return to review</a>. Native iOS owns keyboards, glass and menus.</p>'''
page+=f'<div class="meta">Current visual tests: <strong>{summary.get("passedTests",0)} passed · {summary.get("failedTests",0)} failed · {summary.get("skippedTests",0)} skipped</strong><p>This is a visual review, not a pixel-perfect sign-off. Differences and unmatched states are labeled below. Originals, hashes and crops: <a href="manifest.json">manifest</a> · <a href="test-summary.json">test results</a> · <a href="measurements.json">measurements</a>.</p></div><nav>{nav}</nav>'
page+=''.join(parts)+online+'<section><h2>Static chat measurements</h2><p>Exact-color fill bounds in 440-point coordinates. Bounds exclude antialiased rims. Compression and system UI make a whole-screen pixel error misleading.</p><pre>'+esc(json.dumps(measurements,indent=2))+'</pre></section></html>'
(out/'index.html').write_text(page)
print(f'Exported {len(exported)} actual captures and {len(rows)} reference cases to {out}/index.html')
