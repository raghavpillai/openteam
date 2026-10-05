
import {resolve} from "node:path";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {createServer} from "vite";
const require=createRequire(import.meta.url);
const output=resolve(process.argv[2]??"output/chat-transitions");
await mkdir(output,{recursive:true});
const server=await createServer({root:resolve(import.meta.dir,".."),configFile:resolve(import.meta.dir,"../vite.config.ts"),server:{port:0}});
try{
 await server.listen();
 const child=Bun.spawn([require("electron") as string,resolve(import.meta.dir,"../test/browser/chat-transition-frame-runner.cjs")],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,FRAME_CHECK_DIR:output,FRAME_CHECK_URL:`${server.resolvedUrls!.local[0]}test/browser/chat-transition-frames.html?${process.argv[3]??"dark"}`},stdout:"pipe",stderr:"pipe"});
 const timeout=setTimeout(()=>child.kill(),60000);
 const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
 clearTimeout(timeout);
 if(code)throw new Error(`Frame capture failed: ${stderr}`);
 const results=JSON.parse(await readFile(resolve(output,"results.json"),"utf8"));
 console.log(JSON.stringify({output,error:results.error,frames:results.frames.length,reports:results.reports},null,2));
 if(results.error)throw new Error(results.error);
}finally{await server.close()}
