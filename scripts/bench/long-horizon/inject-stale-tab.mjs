// Operator-only fault injection on the isolated fake-workflow stack. This is
// not an agent tool and does not change its browser/security boundaries.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const id=process.argv[2],root='/tmp/openteam-long-horizon-runs/'+id;
if(!/^[a-zA-Z0-9_-]+$/.test(id??''))throw new Error('Use a single fixture run ID');
const until=Date.now()+600000;let metadata,sub;
while(Date.now()<until){
 if(existsSync(root+'/metadata.json')){
  metadata=JSON.parse(readFileSync(root+'/metadata.json'));
  const q=`select coalesce(json_agg(row_to_json(s)),'[]') from "Subagent" s where "parentBotId"='${metadata.bot.id}'`;
  const rows=JSON.parse(execFileSync('docker',['exec','openteam-support-hill-postgres-1','psql','-U','openteam','-d','openteam','-At','-c',q],{encoding:'utf8'}));
  sub=rows.find(s=>s.status==='waiting'&&s.nextCheckAt);if(sub)break;
 }
 await new Promise(r=>setTimeout(r,1000));
}
if(!sub)throw new Error('No parked fixture task for stale-tab injection');
const response=await fetch('http://127.0.0.1:7462/ops/cases',{method:'POST',body:JSON.stringify({workflow:'appointment',delayMs:0,readonly:true})});
const decoy=await response.json();
const script=`const fs=require('fs'),cp=require('child_process');(async()=>{const id=process.argv[1],source=process.argv[2],dest=process.argv[3];const slot=JSON.parse(fs.readFileSync('/home/box/.sand-window-assignments.json','utf8'))[id];if(!Number.isInteger(slot))throw Error('No own desktop profile');const profile=slot===0?'/home/box/chrome-profile':'/home/box/chrome-profile-'+(slot+1);const commands=cp.execFileSync('ps',['-eo','args'],{encoding:'utf8'}).split('\n');const command=commands.find(s=>s.split(' ').includes('--user-data-dir='+profile)&&s.includes('--remote-debugging-port='));if(!command)throw Error('No own browser');const port=command.match(/--remote-debugging-port=(\d+)/)[1];const {chromium}=require('playwright-core');const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);const page=browser.contexts()[0].pages().find(p=>p.url().includes(source));if(!page)throw Error('Expected case tab missing');const before=page.url();await page.goto(dest);console.log(JSON.stringify({before,after:page.url(),injected:true}));await browser.close();})();`;
const result=JSON.parse(execFileSync('docker',['exec','-u','root','-w','/app/apps/computer','openteam-support-hill-computer-1','node','-e',script,metadata.bot.id,metadata.c.id,'http://host.docker.internal:7462/case/'+decoy.id],{encoding:'utf8',timeout:30000}));
writeFileSync(root+'/stale-tab-evidence.json',JSON.stringify({at:Date.now(),decoyId:decoy.id,...result},null,2));
console.log('Injected unrelated fake case into the parked task tab');
