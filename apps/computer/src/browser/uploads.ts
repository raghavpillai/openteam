import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ElementHandle, FileChooser, Page } from 'playwright-core';
import { agentReadStream } from '../agent-file-stream';

const FILE_LIMIT=25*1024*1024;
const TOTAL_LIMIT=50*1024*1024;
const within=(root:string,path:string)=>{const r=relative(root,path);return r==='' || (r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));};
export async function uploadPayloads(paths:unknown, workspace:string, excludedRoots:string[]=[]) {
  if(paths===undefined)return [];
  if(!Array.isArray(paths)||paths.length>10||paths.some(p=>typeof p!=='string'||!isAbsolute(p)))
    throw new Error('Upload paths must be at most ten absolute local file paths');
  const root=await realpath(workspace);
  const staging=await realpath(join(root,'.playwright-mcp')).catch(()=>join(root,'.playwright-mcp'));
  if(!within(root,staging))throw new Error('Upload staging root must remain within workspace');
  const excluded=await Promise.all(excludedRoots.map(p=>realpath(p).catch(()=>p)));
  const result=[];let total=0;
  for(const path of paths as string[]) {
    // Both the requested path and the opened descriptor must stay inside the
    // allowed root. Bytes are read as the agent, never by the browser process.
    if(!within(root,resolve(path))&&!within(resolve(workspace),resolve(path)))throw new Error('Upload path is outside the allowed workspace root');
    const reader=agentReadStream(path,undefined,{allowedRoots:[staging,root],excludedRoots:excluded});
    const chunks:Buffer[]=[];let size=0;
    try {
      for await(const part of reader.stream){const bytes=Buffer.from(part);size+=bytes.length;total+=bytes.length;
        if(size>FILE_LIMIT||total>TOTAL_LIMIT)throw new Error('Upload exceeds file or total byte limit');chunks.push(bytes);}
      await reader.done;
    } finally {reader.cancel();await reader.done.catch(()=>{});}
    result.push({name:basename(path),mimeType:Bun.file(path).type || 'application/octet-stream',buffer:Buffer.concat(chunks)});
  }
  return result;
}

interface Pending { chooser:FileChooser; document:ElementHandle; id:number; }
/** Pending upload ownership is per page/session, never the last chooser globally. */
export class BrowserUploads {
  private pending=new Map<Page,Pending>();
  private serial=0;
  workspace='/workspace';
  excludedRoots:string[]=[];
  async capture<T extends {content:any[];details?:Record<string,unknown>}>(page:Page,action:()=>Promise<T>):Promise<T> {
    if(this.pending.has(page))throw new Error('Respond to the pending file chooser before another click');
    let capturing:Promise<void>|undefined;
    const opened=(chooser:FileChooser)=>{capturing=(async()=>{
      const document=await chooser.element().evaluateHandle(node=>node.ownerDocument!.documentElement);
      this.pending.set(page,{chooser,document:document as ElementHandle,id:++this.serial});
    })();void capturing.catch(()=>{});};
    page.once('filechooser',opened);
    try {
      const result=await action();await capturing;
      if(!this.pending.has(page))return result;
      return {...result,content:[...result.content,{type:'text',text:'File chooser is pending. Use browser_file_upload with absolute workspace paths, or omit paths to cancel. Do not use native chooser clicks for this intercepted chooser.'}],details:{...result.details,pendingFileChooser:true}};
    } finally {page.off('filechooser',opened);}
  }
  async observe(page:Page) {
    const pending=this.pending.get(page);
    if(!pending||page.isClosed())throw new Error('No pending file chooser in this tab');
    const input=pending.chooser.element();
    const state=await input.evaluate((node,documentRoot)=>{
      const el=node as HTMLInputElement;
      if(!el.isConnected||el.ownerDocument.documentElement!==documentRoot||el.type!=='file'||el.disabled)
        throw new Error('File chooser target changed; open it again');
      return {frameUrl:el.ownerDocument.location.href,multiple:el.multiple,selectedFileCount:el.files?.length??0};
    },pending.document);
    return {untrustedObservation:true,kind:'file-chooser',chooserId:pending.id,url:page.url(),...state};
  }
  async assert(page:Page,expected:unknown){if(JSON.stringify(await this.observe(page))!==JSON.stringify(expected))throw new Error('File chooser changed during review');}
  async respond(page:Page,paths:unknown){
    const before=await this.observe(page);const pending=this.pending.get(page)!;
    if(Array.isArray(paths)&&paths.length>1&&!before.multiple)throw new Error('This input accepts only one file');
    const files=await uploadPayloads(paths,this.workspace,this.excludedRoots);
    await this.assert(page,before);
    await pending.chooser.setFiles(files,{timeout:10000});
    this.pending.delete(page);await pending.document.dispose().catch(()=>{});
    return files.length;
  }
  clear(page:Page){const p=this.pending.get(page);this.pending.delete(page);void p?.document.dispose().catch(()=>{});}
}
