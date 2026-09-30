// Run in a disposable computer container; DELAY_PANEL=1 injects slow launcher startup.
import { ScreenBroker } from '../src/screen-broker';
import { run } from '../src/screen/processes';
import { mkdtemp, rm } from 'node:fs/promises';
const home=await mkdtemp('/tmp/first-frame-');
const broker=new ScreenBroker(home);
const ids=['frame-a','frame-b'];
if(process.env.DELAY_PANEL==='1') {
 const original=(broker as any).spawnLongLived.bind(broker);
 (broker as any).spawnLongLived=(command:string,args:string[],...rest:any[])=>command==='xfce4-panel'
   ?original('/bin/sh',['-c','sleep 2; exec "$@"','delayed-panel',command,...args],...rest)
   :original(command,args,...rest);
}
try {
 const results=await Promise.all(ids.map(async id=>{
  const start=Date.now();await broker.ensure(id,'/workspace');
  const env=await broker.commandEnvironment(id,'/workspace');
  const mean=Number((await run('import',['-display',env.DISPLAY!,'-window','root','-format','%[fx:mean]','info:'],{env,captureStdout:true})).toString());
  await run('xdotool',['search','--onlyvisible','--class','xfce4-panel'],{env});
  return {id,elapsedMs:Date.now()-start,mean};
 }));
 console.log(JSON.stringify(results));
 if(results.some(x=>!(x.mean>0)))process.exitCode=1;
} finally {await Promise.all(ids.map(id=>broker.destroy(id)));await rm(home,{recursive:true,force:true});}
