import {expect,test} from "bun:test";
import {Effect} from "effect";
import {createHash} from "node:crypto";
import {spoolFile,type StagedFile} from "@openteam/plugin-sdk/file-spool";
import {connectorTransferResponse} from "../src/connector-transfer-http";

test("the private connector route streams files above the former 64 MiB JSON limit and cleans its staging",async()=>{
 const chunk=new Uint8Array(1024*1024).fill(83), count=70, size=chunk.length*count;
 const hash=createHash("sha256");for(let i=0;i<count;i++)hash.update(chunk);const sha256=hash.digest("hex");
 const body=()=>{let left=count;return new ReadableStream<Uint8Array>({pull(c){if(left-- > 0)c.enqueue(chunk);else c.close();}});};
 let uploadPath="",downloadPath="";
 const service={execute:(call:any,transfer:{upload?:StagedFile})=>Effect.tryPromise(async()=>{
  if(call.arguments.tool==="upload_file"){
   expect(transfer.upload).toMatchObject({sizeBytes:size,sha256});uploadPath=transfer.upload!.path;
   return {id:"fixture",name:"large.bin",mimeType:"application/octet-stream",sizeBytes:size};
  }
  const file=await spoolFile(body());downloadPath=file.path;
  return {file,id:"fixture",name:"large.bin",mimeType:"application/octet-stream",sizeBytes:size};
 })};
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){expect(request.headers.get("authorization")).toBe("Bearer fixture");return connectorTransferResponse(request,service as never);}});
 const headers=(tool:string)=>({authorization:"Bearer fixture","x-openteam-transfer":Buffer.from(JSON.stringify({runId:"run",botId:"bot",conversationId:"conversation",channelId:"channel",deliveryId:null,callId:tool,tool:"ExecuteConnectorTransfer",arguments:{tool,sizeBytes:size,sha256}})).toString("base64url")});
 try {
  const uploaded=await fetch(server.url,{method:"POST",headers:headers("upload_file"),body:body()});
  expect(uploaded.ok).toBe(true);expect(await uploaded.json()).toMatchObject({sizeBytes:size});
  expect(await Bun.file(uploadPath).exists()).toBe(false);
  const download=await fetch(server.url,{method:"POST",headers:headers("download_file")});
  const received=await spoolFile(download.body!);try{expect(received).toMatchObject({sizeBytes:size,sha256});}finally{await received.cleanup();}
  for(let i=0;i<100 && await Bun.file(downloadPath).exists();i++)await Bun.sleep(10);
  expect(await Bun.file(downloadPath).exists()).toBe(false);
 }finally{server.stop(true);}
},30_000);
