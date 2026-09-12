let calls=0;
const textOf=(m:any)=> typeof m?.content==='string'?m.content:JSON.stringify(m?.content??'');
Bun.serve({hostname:'0.0.0.0',port:9000,async fetch(req){
 if(new URL(req.url).pathname==='/browser-fixture')return new Response('<!doctype html><title>QA Browser 0905</title><h1>QA Browser 0905</h1><button>QA fixture button</button><p id=qa-counter>Initial page</p>',{headers:{'content-type':'text/html'}});
 if(new URL(req.url).pathname==='/health')return Response.json({ok:true,calls});
 if(req.method!=='POST')return new Response('Not found',{status:404});
 const body=await req.json() as any;calls++;
 const messages=body.messages??[];const userIndex=messages.findLastIndex((m:any)=>m.role==='user');
 const userText=textOf(messages[userIndex]);const tail=messages.slice(userIndex+1);
 const called=tail.flatMap((m:any)=>m.tool_calls??[]).map((c:any)=>c.function?.name);
 const toolNames=(body.tools??[]).map((t:any)=>t.function?.name);
 let tool:string|undefined,args:unknown;let content='QA completion verified.';
 if(toolNames.includes('SendToUser')&&!called.includes('SendToUser')){
  if(userText.includes('QA_SHELL_0905')&&!called.includes('Shell')){tool='Shell';args={command:"printf 'QA_SHELL_OK_0905\\n'",block_until_ms:5000};}
  else {tool='SendToUser';args={type:'text',content:userText.includes('QA_SHELL_0905')?'QA_SHELL_OK_0905: terminal execution and delivery verified.':'QA_REPLY_0905: message delivery verified.'};}
 }
 if(!body.tools?.length)content='{"facts":[]}';
 if(userText.includes('QA_CANCEL_0905')) await Bun.sleep(5000);
 if(toolNames.includes('browser_navigate')&&userText.includes('QA_BROWSER_0905')) {
  if(!called.includes('browser_navigate')){tool='browser_navigate';args={url:'http://fixture-provider:9000/browser-fixture'};}
  else if(!called.includes('browser_snapshot')){tool='browser_snapshot';args={};}
  else if(!called.includes('browser_cdp')){tool='browser_cdp';args={method:'Runtime.evaluate',params:{expression:"document.getElementById('qa-counter').textContent='QA_BROWSER_OK_0905'; document.title='QA_BROWSER_OK_0905';"}};}
  else if(called.filter((name:any)=>name==='browser_snapshot').length<2){tool='browser_snapshot';args={};}
  else {tool=undefined;content='QA_BROWSER_OK_0905 completed.';}
 }
 if(tool==='SendToUser'&&userText.includes('QA_UI_SEND_0905'))(args as any).content='QA_UI_REPLY_0905: native message round trip verified.';
 if(tool==='SendToUser'&&userText.includes('QA_GROUP_SEND_0905'))(args as any).content='QA_GROUP_REPLY_0905: group delivery verified.';
 if(tool==='SendToUser'&&userText.includes('QA_OFFLINE_SEND_0905'))(args as any).content='QA_OFFLINE_REPLY_0905: queued message recovered.';
 const call={id:'call_'+crypto.randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(args)}};
 const message=tool?{role:'assistant',content:null,tool_calls:[call]}:{role:'assistant',content};
 const id='chatcmpl-'+crypto.randomUUID(),created=Math.floor(Date.now()/1000),model=body.model;
 const finish=tool?'tool_calls':'stop';
 console.log(JSON.stringify({calls,model,stream:body.stream,tool:tool??null,messageCount:messages.length}));
 if(!body.stream)return Response.json({id,object:'chat.completion',created,model,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}});
 const chunk=(delta:any,finish_reason:any=null)=>({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta,finish_reason}]});
 const rows=[chunk({role:'assistant'}),chunk(tool?{tool_calls:[{index:0,...call}]}:{content}),{...chunk({},finish),usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}}];
 return new Response(rows.map(row=>'data: '+JSON.stringify(row)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
