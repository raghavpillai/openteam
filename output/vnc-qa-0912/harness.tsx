import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {BotScreen} from "../../apps/desktop/src/renderer/components/openteam/bot-screen";
import {TooltipProvider} from "../../apps/desktop/src/renderer/components/ui/tooltip";
import {api} from "../../apps/desktop/src/renderer/client/openteam-api";
import "../../apps/desktop/src/renderer/styles.css";
const gateway="http://127.0.0.1:6175";
let mode="direct";
const requests:unknown[]=[];
const adapt=(screen:any)=>({...screen,viewerUrl:mode==="fallback"?"":screen.viewerUrl.replace("100.94.42.50","127.0.0.1")});
api.screenStatus=async()=>adapt(await fetch(gateway+"/screen").then(r=>r.json()));
api.screenFrameUrl=(_id,revision)=>gateway+"/frame?revision="+revision;
const post=async(path:string,body:unknown)=>{const r=await fetch(gateway+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const x=await r.json();if(!r.ok)throw new Error(x.error);return x;};
api.screenTakeover=async(_id,active)=>adapt(await post("/takeover",active));
api.mutateComputerHandoff=async(_id,action)=>(await post("/handoff",action)).result;
api.releaseComputerHandoff=()=>{void post("/handoff","dismiss")};
api.screenAction=async(_id,input)=>{
 requests.push(input);document.querySelector('#requests')!.textContent=JSON.stringify(requests,null,2);
 const response=await fetch(gateway+"/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok)throw new Error(result.error);return adapt(result);
};
function Harness(){
 const [selected,setSelected]=useState("direct"),[enabled,setEnabled]=useState(false),[handoff,setHandoff]=useState<any>(null);
 return <TooltipProvider><main style={{padding:24}}><h1>Production BotScreen component QA</h1><p>Disposable bot only. Uses the actual viewer component and screen broker; app sign-in and navigation are outside this harness.</p><button onClick={()=>{mode=selected==="direct"?"fallback":"direct";setSelected(mode);setEnabled(false)}}>Mode: {selected}. Switch mode</button><button style={{marginLeft:20}} onClick={async()=>{const h=await post("/handoff","start");setHandoff({botId:"2bb9dd4c-1464-4d02-a34f-10eb51b164fc",messageId:h.messageId})}}>Start actual handoff</button><div style={{width:480}}><BotScreen key={selected} bot={{id:"2bb9dd4c-1464-4d02-a34f-10eb51b164fc",name:"VNC QA Sep 12",status:"active"} as any} active enabled={enabled} handoff={handoff} onHandoffFinished={()=>setHandoff(null)} onEnable={()=>setEnabled(true)}/></div><pre id="requests" style={{whiteSpace:"pre-wrap"}}/></main></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
