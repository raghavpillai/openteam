#!/usr/bin/env python3
"""Build a review from successful XCTest output; preserve the original screenshot bytes."""
import argparse, hashlib, html, json, re, shutil, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('bundle',type=Path);p.add_argument('output',type=Path);p.add_argument('--compact',type=Path);p.add_argument('--additional',type=Path,action='append',default=[]);p.add_argument('--core-log',type=Path);p.add_argument('--reference-log',type=Path);a=p.parse_args()
out=a.output.resolve();(out/'captures').mkdir(parents=True,exist_ok=True)
manifest={'captures':{},'testRuns':[],'visualReview':'screens/index.html','notes':['Screenshots are unretouched XCTest attachments.','The 21 supplied references are compared separately. Screens without supplied references use native iOS presentation.','Service fixtures are inert. Request payloads are decoded using the production API schemas. Live service and physical-device acceptance are still required.']}
for bundle in [a.bundle]+a.additional+([a.compact] if a.compact else []):
 summary=json.loads(subprocess.check_output(['xcrun','xcresulttool','get','test-results','summary','--path',str(bundle)]))
 assert summary['failedTests']==0 and summary['skippedTests']==0,summary
 manifest['testRuns'].append({'bundle':str(bundle.resolve()),'passed':summary['passedTests'],'failed':summary['failedTests'],'devices':summary['devicesAndConfigurations']})
 with tempfile.TemporaryDirectory(prefix='native-qa-export-') as temp:
  subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(bundle),'--output-path',temp],check=True,stdout=subprocess.DEVNULL)
  for group in json.load(open(Path(temp)/'manifest.json')):
   for item in group['attachments']:
    name=item['suggestedHumanReadableName'].split('_0_')[0]
    if not name.startswith(('parity-','native-')):continue
    original=Path(temp)/item['exportedFileName'];dest=out/'captures'/f'{name}.png';shutil.copyfile(original,dest)
    manifest['captures'][name]={'path':str(dest.relative_to(out)),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'test':group['testIdentifier'],'bundle':str(bundle.resolve())}
old=Path('output/mobile-full-qa-0914/onboarding-offline.png').resolve();shutil.copyfile(old,out/'prior-rn-server-error.png')
manifest['priorRN']={'source':str(old),'sha256':hashlib.sha256(old.read_bytes()).hexdigest(),'role':'Historical React Native offline-onboarding capture; functional comparison, not a pixel target.'}
checks=[]
for kind,source in [('Swift core',a.core_log),('RN/client contract',a.reference_log)]:
 if source is None:continue
 log=source.read_text();matches=re.findall(r'Executed (\d+) tests, with 0 failures',log) if kind=='Swift core' else re.findall(r'(\d+) pass',log)
 assert matches and (' 0 fail' in log if kind!='Swift core' else not re.search(r'with [1-9]\d* failures',log)),f'Expected successful {kind} test log'
 dest=out/('core-tests.log' if kind=='Swift core' else 'reference-tests.log');shutil.copyfile(source,dest)
 checks.append({'name':kind,'passed':int(matches[-1]),'path':dest.name,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
manifest['checks']=checks
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
labels={
'welcome':'Native welcome','server':'Server setup','server-invalid':'Invalid server address','server-unreachable':'Unreachable server','server-incompatible':'Incompatible server','sign-in':'Native sign-in','sign-in-error':'Wrong credentials','sign-in-rate-limit':'Rate limit','sign-in-server-error':'Server failure','session-expired':'Expired session; draft retained','welcome-dark-large-text':'Welcome with larger text','signin-dark-large-text':'Sign-in with larger text','account-invalid-server':'Invalid server change; current account retained','create-failure':'Failed creation; name retained','profile-robot-selected':'Our robot selected','profile-saved':'Saved robot profile','group-created':'Created group','sidebar-save-error':'Section save error; edits retained','memory-load-error':'Memory load error and retry','memory':'Saved memory','memory-empty':'After clearing memory','routine-save-error':'Routine save error','routine-conflict':'Routine revision conflict','routine-history':'Routine history','plugins-load-error':'Plugin load error','plugin-install-error':'Install error and retry','plugin-installed':'Installed plugin','plugin-account':'Connection account renamed','source-validation':'Source URL validation','plugin-workspace':'Plugin workspace','private-skill-error':'Skill save error; content retained','private-skill-saved':'Saved private skill','rich-markdown-light':'Tables, math and Mermaid','private-attachment':'Authenticated attachment','native-file-preview':'Native Quick Look and share','user-form-error-dark':'Form failure; entered values retained','user-form-completed-dark':'Accepted form submission','computer-takeover':'Native computer control'}
groups=[('Sign-in and recovery',['welcome','server','sign-in','sign-in-error','server-invalid','server-unreachable','server-incompatible','sign-in-rate-limit','sign-in-server-error','session-expired','welcome-dark-large-text','signin-dark-large-text']),('Accounts, conversations and memory',['account-invalid-server','create-failure','profile-robot-selected','profile-saved','group-created','sidebar-save-error','memory-load-error','memory','memory-empty']),('Routines and plugins',['routine-save-error','routine-conflict','routine-history','plugins-load-error','plugin-install-error','plugin-installed','plugin-account','source-validation','plugin-workspace','private-skill-error','private-skill-saved']),('Content and computer',['rich-markdown-light','private-attachment','native-file-preview','user-form-error-dark','user-form-completed-dark','computer-takeover'])]
esc=html.escape
parts=[]
for title,names in groups:
 cards=[]
 for name in names:
  item=manifest['captures'].get('parity-'+name)
  if not item:continue
  cards.append(f'<figure><a href="{item["path"]}"><img loading="lazy" src="{item["path"]}" alt="{esc(labels.get(name,name))}"></a><figcaption>{esc(labels.get(name,name))}<small>{esc(item["test"].split("/")[-1])}</small></figcaption></figure>')
 parts.append(f'<section id="{title.split()[0].lower()}"><h2>{title}</h2><div class="gallery">'+''.join(cards)+'</div></section>')
compact=[(k,v) for k,v in manifest['captures'].items() if k.startswith('native-')]
if compact:parts.append('<section><h2>Compact iPhone regression checks</h2><div class="gallery">'+''.join(f'<figure><a href="{v["path"]}"><img loading="lazy" src="{v["path"]}"></a><figcaption>{esc(k.removeprefix("native-").replace("-"," "))}</figcaption></figure>' for k,v in compact)+'</div></section>')
count=sum(run['passed'] for run in manifest['testRuns'])
native=manifest['captures'].get('parity-server-unreachable',{})
page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTeam Swift · Functional and visual review</title><style>
:root{color-scheme:dark;font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#151618;color:#f2f2f2}body{max-width:1320px;margin:0 auto;padding:40px 28px}h1{font-size:36px;letter-spacing:-1px;margin:0 0 14px}h2{font-size:25px;margin:0 0 20px}p{line-height:1.6;color:#b9bdc5;max-width:940px}a{color:#add0ff}nav{display:flex;gap:20px;flex-wrap:wrap;padding:18px 0}.evidence{padding:20px 24px;background:#23262b;border:1px solid #3a414b;border-radius:16px}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px;max-width:880px}figure{margin:0;min-width:0}img{display:block;width:100%;border-radius:16px}figcaption{padding:14px 2px;color:#e5e8ed;font-weight:600;line-height:1.4}small{display:block;font-weight:400;color:#9ba2ae;font-size:12px;overflow-wrap:anywhere;padding-top:6px}section{margin-top:64px}details{padding:14px 0}summary{cursor:pointer}.primary{display:inline-block;padding:14px 20px;border-radius:12px;background:#d7e8ff;color:#112742;text-decoration:none;font-weight:600}@media(max-width:800px){.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:24px 16px}h1{font-size:28px}}@media(max-width:480px){.gallery{grid-template-columns:1fr}}
</style><h1>OpenTeam Swift</h1><p>Reference screens, native account flows and tested failure recovery. Our desktop robots remain the source for robot artwork and motion.</p><nav><a class="primary" href="screens/index.html">Open all 21 supplied-reference comparisons</a><a href="http://127.0.0.1:19993/">Desktop robot comparisons</a><a href="manifest.json">Capture provenance and test results</a></nav><nav><a href="#sign-in">Sign-in and recovery</a><a href="#accounts,">Accounts and memory</a><a href="#routines">Routines and plugins</a><a href="#content">Content and computer</a></nav>'''
check_text=''.join(f' · {check["passed"]} {check["name"]} tests passed' for check in checks)
page+=f'<div class="evidence"><strong>{count} successful functional test executions{check_text}</strong><p>{len(manifest["captures"])} unretouched native screenshots. Fixtures check saved server state and error/retry behavior; the latest harness decodes writes with production request schemas.</p><p>Production cutover remains open: APNs delivery needs a server transport and signed device setup. Live OAuth/services, real microphone/camera interruptions and sustained device performance still need acceptance.</p></div>'
page+='<section><h2>Earlier React Native → native iOS</h2><p>The historical RN connection-error state is included for functional comparison. The Swift screen uses native navigation, form fields and inline recovery; no supplied Grokbot reference existed for this flow. The appearance and content differ deliberately.</p><div class="pair"><figure><img src="prior-rn-server-error.png"><figcaption>Earlier React Native · offline onboarding</figcaption></figure>'
if native:page+=f'<figure><img src="{native["path"]}"><figcaption>Swift native · unreachable server</figcaption></figure>'
page+='</div></section>'+''.join(parts)+'</html>'
(out/'index.html').write_text(page)
print(f'Wrote {len(manifest["captures"])} captures and {count} successful simulator tests to {out}/index.html')
