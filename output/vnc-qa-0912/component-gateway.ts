// Local, disposable integration-test adapter. Only the QA bot is exposed.
const cors = {"access-control-allow-origin":"http://127.0.0.1:5173","access-control-allow-headers":"content-type","cache-control":"no-store"};
async function probe(action:string, arg?:unknown) {
  const proc=Bun.spawn(["docker","exec","openteam-server-1","bun","/tmp/vnc-qa-server-probe.js",action,...(arg===undefined?[]:[JSON.stringify(arg)])],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  if(await proc.exited) throw new Error(stderr.slice(-1000));
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
let frameTask:Promise<Uint8Array>|null=null;
async function frame(){
  if(frameTask)return frameTask;
  frameTask=(async()=>{await probe("frame");const p=Bun.spawn(["docker","exec","openteam-server-1","cat","/tmp/vnc-qa-frame.png"],{stdout:"pipe",stderr:"inherit"});const bytes=new Uint8Array(await new Response(p.stdout).arrayBuffer());await p.exited;return bytes;})();
  try{return await frameTask;}finally{frameTask=null;}
}
Bun.serve({hostname:"127.0.0.1",port:6175,async fetch(request){
  if(request.method==="OPTIONS")return new Response(null,{headers:cors});
  try{
    const path=new URL(request.url).pathname;
    if(path==="/screen")return Response.json(await probe("raw-screen"),{headers:cors});
    if(path==="/action"&&request.method==="POST")return Response.json(await probe("screen-action",await request.json()),{headers:cors});
    if(path==="/takeover"&&request.method==="POST")return Response.json(await probe("takeover",await request.json()),{headers:cors});
    if(path==="/handoff"&&request.method==="POST")return Response.json(await probe("handoff",await request.json()),{headers:cors});
    if(path==="/frame")return new Response(await frame(),{headers:{...cors,"content-type":"image/png"}});
    return new Response("Not found",{status:404,headers:cors});
  }catch(error){return Response.json({error:String(error)},{status:500,headers:cors});}
}});
console.log("QA component adapter ready on loopback port 6175.");
