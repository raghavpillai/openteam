#!/usr/bin/env python3
"""Export actual XCTest robot captures with their recorded on-screen crop rectangles."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('result',type=Path);p.add_argument('output',type=Path);p.add_argument('--idle-capture',type=Path);args=p.parse_args()
out=args.output;out.mkdir(parents=True,exist_ok=True);captures=out/(args.result.stem+'-captures')
if not captures.exists():subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(args.result),'--output-path',str(captures)],check=True)
summary=subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',str(args.result),'--format','json']);(out/'robot-tests.json').write_bytes(summary)
attachments=[a for group in json.loads((captures/'manifest.json').read_text()) for a in group.get('attachments',[])]
def attachment(prefix):return next(a for a in attachments if a.get('suggestedHumanReadableName','').startswith(prefix))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
(out/'crops').mkdir(exist_ok=True)
provenance={'resultBundle':str(args.result),'device':'iPhone 16 Pro Max / iOS 26.5','crops':[]}
for name,prefix in [('still','gallery-still'),('thinking','gallery-thinking-1'),('dark','gallery-dark-thinking-1'),('idle','gallery-still')]:
 if name=='idle' and not args.idle_capture:continue
 meta=attachment('frames-'+prefix);rectangles=json.loads((captures/meta['exportedFileName']).read_text())
 record=attachment('our-robot-'+prefix)
 path=args.idle_capture if name=='idle' else captures/record['exportedFileName']
 im=Image.open(path);scale=im.width/440
 for shape,(x,y,w,h) in rectangles.items():
  box=tuple(round(v*scale) for v in (x,y,x+w,y+h));target=out/'crops'/f'{name}-{shape}.png';im.crop(box).save(target)
  provenance['crops'].append({'mode':name,'shape':shape,'source':str(path.relative_to(out)),'sourceSHA256':digest(path),'sourcePixelCrop':box,'nativeViewPoints':[x,y,w,h],'metadata':str((captures/meta['exportedFileName']).relative_to(out)),'output':str(target.relative_to(out))})
provenance['idleCapture']={'source':str(args.idle_capture),'launchArguments':['--bot-motion-lab','--robot-gallery','--bot-state','idle','--robot-sample','2.3'],'note':'Actual simctl screenshot. Uses the same measured gallery frames, unchanged between modes.'} if args.idle_capture else None
(out/'capture-provenance.json').write_text(json.dumps(provenance,indent=2))
for a in attachments:
 name=a.get('suggestedHumanReadableName','').split('_0_')[0]
 if name.startswith('our-robot-'):shutil.copyfile(captures/a['exportedFileName'],captures/(name+'.png'))
scripts=Path(__file__).resolve().parent
root=scripts.parents[2]
for source,target in [('robot-review-template.html','index.html'),('robot-review.js','review.js'),('robot-reference.html','reference.html')]:shutil.copyfile(scripts/source,out/target)
shutil.copyfile(root/'packages/design-tokens/src/robot-avatar.css',out/'reference.css')
shutil.copyfile(scripts.parent/'docs/BOT-MOTION.md',out/'implementation.md')
subprocess.run(['bun','build',str(scripts/'robot-reference.ts'),'--outfile',str(out/'reference.js'),'--target','browser'],check=True)
print(f'Exported {len(provenance["crops"])} unretouched robot crops.')
