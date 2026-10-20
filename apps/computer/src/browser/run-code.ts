import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { nodeBinary } from "../node-runtime";

const require = createRequire(import.meta.url);
export const RUN_CODE_TIMEOUT_MS = 30_000;
export const RUN_CODE_MAX_BYTES = 256 * 1024;
export const RUN_CODE_MAX_IMAGES = 4;
const RUN_CODE_IMAGE_BYTES = 20 * 1024 * 1024;
const RUN_CODE_PDF_BYTES = 40 * 1024 * 1024;
// Images, saved PDFs and in-memory uploads travel as base64 lines; the JSON
// result itself is still limited to RUN_CODE_MAX_BYTES by the script process.
const RUN_CODE_MESSAGE_CHARS = 96 * 1024 * 1024;

// Selector engines run in the page's main world, where the snapshot driver
// keeps refs (__sandRefs/__sandRefState). Each frame reads its own store and
// its same-origin ancestors' stores; a ref minted inside a cross-origin frame
// is reached by tagging the frame elements on the path to it. With frames
// true this is the hop engine: it returns the child frame element that leads
// to the ref, so a selector can enter that frame.
const REF_ENGINE = String.raw`(frames => {
 const stores = doc => {
  const views = [];
  let view = doc.defaultView;
  while (view) {
   views.push(view);
   let parent;
   try { parent = view.parent; if (parent === view || !parent.document) break; } catch { break; }
   view = parent;
  }
  return views;
 };
 const lookup = (doc, ref) => {
  for (const view of stores(doc)) {
   let refs, state;
   try { refs = view.__sandRefs; state = view.__sandRefState; } catch { break; }
   if (refs == null || typeof refs.get !== 'function') continue;
   const node = refs.get(ref);
   if (node == null) continue;
   if (node.isConnected === false) return null;
   if (state && state.stableRefs && (!state.refIsCurrent || !state.refIsCurrent(ref, node))) return null;
   return node;
  }
  return null;
 };
 const within = (node, root) => {
  for (let current = node; current; current = current.parentNode || (current.nodeType === 11 ? current.host : null))
   if (current === root) return true;
  return false;
 };
 const documentOf = root => root.nodeType === 9 ? root : root.ownerDocument;
 const tagged = (scope, ref) => {
  for (const element of scope.querySelectorAll('iframe,frame'))
   if (element.__openteamRefFrames && typeof element.__openteamRefFrames.has === 'function' && element.__openteamRefFrames.has(ref)) return element;
  for (const host of scope.querySelectorAll('*')) if (host.shadowRoot) { const found = tagged(host.shadowRoot, ref); if (found) return found; }
  return null;
 };
 const element = (root, ref) => {
  const doc = documentOf(root);
  const node = lookup(doc, ref);
  return node && node.ownerDocument === doc && within(node, root) ? node : null;
 };
 const frame = (root, ref) => {
  const doc = documentOf(root);
  const node = lookup(doc, ref);
  let owner = null;
  if (node) {
   for (let current = node.ownerDocument; current && current !== doc;) {
    const element = current.defaultView && current.defaultView.frameElement;
    if (!element) break;
    if (element.ownerDocument === doc) { owner = element; break; }
    current = element.ownerDocument;
   }
  } else owner = tagged(doc, ref);
  return owner && within(owner, root) ? owner : null;
 };
 const find = frames ? frame : element;
 return { query: (root, ref) => find(root, ref.trim()), queryAll: (root, ref) => { const found = find(root, ref.trim()); return found ? [found] : []; } };
})`;

// A separate process makes CPU loops and unresolved promises cancellable without
// terminating the computer runtime. This is not an OS security sandbox; the
// worker already has Shell authority. Do not pass runtime credentials to it.
const runner = String.raw`
const vm = require('node:vm');
const nodePath = require('node:path');
const {randomUUID} = require('node:crypto');
const {Console} = require('node:console');
const {Writable} = require('node:stream');
const {Blob} = require('node:buffer');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
 let browser, state, started = false;
 const stdio=[]; let logBytes=0;
 const log=entry=>{stdio.push(entry);process.stdout.write(JSON.stringify({stdio:entry})+'\n');};
 const policyErrors=new WeakSet(), workerErrors=new WeakSet();
 const deny=(api,reason)=>{const error=new Error(api+' is blocked in browser_run_code: '+reason);policyErrors.add(error);return error;};
 // Requests to the parent share the progress channel: one stdout line each,
 // answered by an IPC acknowledgement carrying a value or a coded error.
 let messageId=0;
 const replies=new Map();
 process.on('message',message=>{
  const waiting=replies.get(message.ack);
  if(!waiting)return;
  replies.delete(message.ack);
  if(message.error===undefined)return waiting.resolve(message.value);
  const error=new Error(message.error);
  if(message.code==='policy_denied')policyErrors.add(error);
  else if(message.code!=='job_failed')workerErrors.add(error);
  waiting.reject(error);
 });
 const send=message=>{
  const id=++messageId;
  const reply=new Promise((resolve,reject)=>replies.set(id,{resolve,reject}));
  process.stdout.write(JSON.stringify({id,...message})+'\n');
  return reply;
 };
 const ask=body=>send({request:body});
 const deadline=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out')),ms);})]).finally(()=>clearTimeout(timer));};
 // Rewritten ref selectors read as the aria-ref selectors the script wrote.
 const publicMessage=message=>String(message)
  .replace(/locator\('openteam-ref-frame=[^']*'\)\.contentFrame\(\)\./g,'')
  .replace(/openteam-ref-frame=\S+ >> internal:control=enter-frame >> /g,'')
  .replace(/openteam-ref(?:-frame)?=/g,'aria-ref=');
 const within=(root,path)=>{const part=nodePath.relative(root,path);return part==='' || (part!=='..'&&!part.startsWith('..'+nodePath.sep)&&!nodePath.isAbsolute(part));};
 try {
  const {modulePath, endpoint, targets, selected, code, maxBytes, maxImages, imageBytes, pdfBytes, refEngine, workspace, downloads, refPages, chooser} = JSON.parse(input);
  const playwright = require(modulePath);
  browser = await playwright.chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chromium did not provide a default browser context');
  await playwright.selectors.register('openteam-ref',{content:refEngine+'(false)'},{contentScript:false});
  await playwright.selectors.register('openteam-ref-frame',{content:refEngine+'(true)'},{contentScript:false});
  // Playwright names downloads after GUIDs in a folder it deletes when this
  // connection closes. Keep Chrome's own folder and names, as other tools do.
  const downloadSession=await browser.newBrowserCDPSession();
  const saved=new Map();
  const savedDownload=guid=>{let record=saved.get(guid);if(!record){let settle;record={done:new Promise(resolve=>settle=resolve)};record.settle=settle;saved.set(guid,record);}return record;};
  downloadSession.on('Browser.downloadProgress',event=>{
   if(event.state==='inProgress')return;
   const record=savedDownload(event.guid);record.filePath=event.filePath;record.settle();
  });
  await downloadSession.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  const allowed = new Set();
  const ids = new Map(), targetInfoByPage = new Map();
  async function identify(page) {
   if (ids.has(page)) return ids.get(page);
   const cdp = await context.newCDPSession(page);
   try { const {targetInfo} = await cdp.send('Target.getTargetInfo'); ids.set(page,targetInfo.targetId);targetInfoByPage.set(page,targetInfo);return targetInfo.targetId; }
   finally { await cdp.detach(); }
  }
  for (const page of context.pages()) if (targets.includes(await identify(page).catch(()=>null))) allowed.add(page);
  // A page is always available: the selected tab, another leased tab if that
  // one just closed, or a new blank tab.
  let page = [...allowed].find(p => ids.get(p) === selected) || [...allowed].filter(p => !p.isClosed()).at(-1);
  const created = !page;
  if (created) { page = await context.newPage(); allowed.add(page); await identify(page); }
  let front = page;
  const openers = new Map(), previousFront = new Map();
  for(const p of allowed) {
   const opener=[...allowed].find(candidate=>ids.get(candidate)===targetInfoByPage.get(p)?.openerId);
   if(opener)openers.set(p,opener);
  }
  function watch(p) {
   p.on('close', () => {
    if (front === p) front = openers.get(p) && !openers.get(p).isClosed()
      ? openers.get(p) : previousFront.get(p) && !previousFront.get(p).isClosed()
        ? previousFront.get(p) : [...allowed].find(candidate => !candidate.isClosed()) || p;
   });
  }
  for (const p of allowed) watch(p);
  state = async () => {
   const live=[...allowed].filter(p => !p.isClosed());
   return {targets:await Promise.all(live.map(identify)),selected:front.isClosed()?null:await identify(front)};
  };
  const progress = async extra => send({progress:{...await state(),...extra}});
  if (created) await progress({});
  // Merely connecting a second Playwright client must not dismiss dialogs.
  context.on('dialog', dialog => {
   const p=dialog.page();
   // Script listeners get the first chance to handle it. An observer-only
   // listener must not hide a still-pending dialog from the recovery tool.
   const timer=setTimeout(() => {
    if (allowed.has(p) && !handledDialogs.has(dialog))
     void identify(p).then(id => progress({dialog:id})).catch(()=>{});
   },100);
   timer.unref();
  });
  const handledDialogs = new WeakSet();
  const popupTasks = new Set();
  context.on('page', p => {
   const pending=p.opener().then(async opener => {
    if (allowed.has(opener)) {
     allowed.add(p);openers.set(p,opener);watch(p);front=p;
     log({type:'info',text:'A popup opened; subsequent browser calls use the popup tab.'});
     await progress({});
    }
   });
   popupTasks.add(pending);
   void pending.catch(()=>{}).finally(()=>popupTasks.delete(pending));
  });

  // Refs: depth is the number of frames between a page's top document and the
  // document holding the ref, so a rewritten selector enters exactly those.
  const refDepths=new WeakMap();
  // Selectors are built synchronously, so frame depths are read ahead of
  // time, and only for scripts that can name a ref at all.
  const usesRefs=/aria-ref/.test(code);
  const REF_DEPTHS=()=>{
   const state=globalThis.__sandRefState, depths={};
   if(state&&state.byRef)for(const [ref,held] of state.byRef){
    const node=held&&typeof held.deref==='function'?held.deref():undefined;
    if(!node||node.isConnected!==true)continue;
    let depth=0,doc=node.ownerDocument;
    while(doc&&doc!==document){const owner=doc.defaultView&&doc.defaultView.frameElement;if(!owner)break;depth++;doc=owner.ownerDocument;}
    depths[ref]=depth;
   }
   return {token:state&&typeof state.frameToken==='string'?state.frameToken:null,depths};
  };
  const TAG_FRAME=(element,refs)=>{
   if(!element.__openteamRefFrames||typeof element.__openteamRefFrames.add!=='function')
    Object.defineProperty(element,'__openteamRefFrames',{value:new Set(),configurable:true});
   for(const ref of refs)element.__openteamRefFrames.add(ref);
  };
  const mapRefs=async(p,frames)=>{
   const depths=new Map();refDepths.set(p,depths);
   if(p.isClosed()||p.frames().length<2)return;
   const record=(found,offset)=>{for(const [ref,depth] of Object.entries(found.depths))depths.set(ref,offset+depth);};
   const top=await deadline(p.mainFrame().evaluate(REF_DEPTHS),2000).catch(()=>null);
   if(top)record(top,0);
   if(!frames)return;
   // Frames are probed together: one hung frame must not stall the others.
   await Promise.all(p.frames().filter(frame=>frame!==p.mainFrame()&&!frame.isDetached()).map(async frame=>{
    const found=await deadline(frame.evaluate(REF_DEPTHS),2000).catch(()=>null);
    const refs=found&&found.token?Object.keys(found.depths):[];
    if(!refs.length)return;
    const chain=[];
    for(let child=frame;child.parentFrame();child=child.parentFrame())chain.push(child);
    await Promise.all(chain.map(async child=>{
     const owner=await child.frameElement().catch(()=>null);
     if(owner)await deadline(owner.evaluate(TAG_FRAME,refs),2000).catch(()=>{}).finally(()=>owner.dispose().catch(()=>{}));
    }));
    record(found,chain.length);
   }));
  };
  const frameDepth=frame=>{let depth=0;for(let current=frame;current&&current.parentFrame();current=current.parentFrame())depth++;return depth;};
  const enteredFrames=selector=>(String(selector).match(/internal:control=enter-frame/g)||[]).length;
  const baseOf=(kind,target)=>{
   if(kind==='Page')return {page:target,entered:0};
   if(kind==='Frame')return {page:target.page(),entered:frameDepth(target)};
   if(kind==='Locator')return {page:target.page(),entered:frameDepth(target._frame)+enteredFrames(target._selector)};
   if(kind==='FrameLocator')return {page:target._frame.page(),entered:frameDepth(target._frame)+enteredFrames(target._frameSelector)+1};
   return null;
  };
  const splitSelector=selector=>{
   const parts=[];let quote=null,start=0;
   for(let i=0;i<selector.length;i++){
    const c=selector[i];
    if(quote){if(c==='\\')i++;else if(c===quote)quote=null;}
    else if(c==='"'||c==="'")quote=c;
    else if(c==='>'&&selector[i+1]==='>'){parts.push(selector.slice(start,i));start=i+2;i++;}
   }
   parts.push(selector.slice(start));
   return parts;
  };
  // Playwright's own aria-ref engine only knows its own snapshots. Point
  // aria-ref=eN at the refs browser_snapshot, browser_find and
  // page.ariaSnapshot({ mode: 'ai' }) issued instead.
  const rewrite=(selector,base)=>{
   if(typeof selector!=='string'||!/aria-ref\s*=/.test(selector))return selector;
   let entered=base?base.entered:0;
   const depths=base?refDepths.get(base.page):undefined;
   return splitSelector(selector).map(part=>{
    const trimmed=part.trim();
    if(trimmed==='internal:control=enter-frame'){entered++;return part;}
    const match=/^aria-ref\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(trimmed);
    if(!match)return part;
    const ref=(match[1]??match[2]??match[3]).trim();
    const hops=Math.max(0,(depths&&depths.get(ref)||0)-entered);
    entered+=hops;
    return ' '+[...Array(hops).fill('openteam-ref-frame='+ref+' >> internal:control=enter-frame'),'openteam-ref='+ref].join(' >> ')+' ';
   }).join('>>');
  };
  const snapshotOf=async(p,scope)=>{
   const reply=await ask({type:'snapshot',target:await identify(p),...(scope?{scope}:{})});
   if(usesRefs)await deadline(mapRefs(p,reply.frames),3000).catch(()=>{});
   return reply.text;
  };
  const MARK_SCOPE=(element,key)=>{
   let view=element.ownerDocument.defaultView;
   try{while(view.parent!==view){void view.parent.document;view=view.parent;}}catch{return false;}
   const scopes=view.__sandSnapshotScopes&&typeof view.__sandSnapshotScopes.set==='function'?view.__sandSnapshotScopes:(view.__sandSnapshotScopes=new view.Map());
   scopes.set(key,element);
   return true;
  };
  const scopedSnapshot=async(locator,options)=>{
   const scope=randomUUID(), p=locator.page();
   if(!await locator.evaluate(MARK_SCOPE,scope,typeof options.timeout==='number'?{timeout:options.timeout}:undefined))
    throw new Error("locator.ariaSnapshot({ mode: 'ai' }) reads elements in the page and its same-origin frames; use page.ariaSnapshot({ mode: 'ai' }) for this element");
   try{return await snapshotOf(p,scope);}
   finally{await p.mainFrame().evaluate(key=>globalThis.__sandSnapshotScopes&&globalThis.__sandSnapshotScopes.delete(key),scope).catch(()=>{});}
  };

  const UPLOAD_RULE='uploads accept absolute paths under '+workspace+' or in-memory { name, mimeType, buffer }';
  const uploadFiles=async(api,files)=>{
   const list=Array.isArray(files)?files:[files];
   if(!list.length||!list.every(file=>typeof file==='string'))return files;
   for(const file of list)if(!nodePath.isAbsolute(file)||!within(workspace,nodePath.resolve(file)))throw deny(api,UPLOAD_RULE);
   const read=(await ask({type:'files',paths:list})).map(file=>({name:file.name,mimeType:file.mimeType,buffer:Buffer.from(file.buffer,'base64')}));
   return Array.isArray(files)?read:read[0];
  };
  const pageOf=(kind,target)=>kind==='Page'?target:kind==='FileChooser'||kind==='Frame'||kind==='Locator'?target.page():kind==='FrameLocator'?target._frame.page():null;
  const uploaded=async owner=>{if(owner&&allowed.has(owner))await ask({type:'uploaded',target:await identify(owner)}).catch(()=>{});};
  const checkUrl=(api,url)=>{
   let parsed;
   try{parsed=new URL(url);}catch{return;}
   if(parsed.protocol!=='http:'&&parsed.protocol!=='https:'&&parsed.href!=='about:blank')throw deny(api,'only http, https and about:blank URLs can be opened');
  };
  const PAGE_SELECTORS=new Set(['locator','frameLocator','waitForSelector','click','dblclick','tap','hover','focus','fill','type','press','check','uncheck','setChecked','selectOption','setInputFiles','dispatchEvent','textContent','innerText','innerHTML','getAttribute','inputValue','isChecked','isDisabled','isEditable','isEnabled','isHidden','isVisible']);
  const prepareCall=(kind,key,args,api,target)=>{
   if(key==='goto'&&(kind==='Page'||kind==='Frame'))checkUrl(api,args[0]);
   if(['screenshot','pdf','addStyleTag'].includes(key)&&args[0]&&typeof args[0]==='object'&&args[0].path!==undefined)
    throw deny(api+' with a path',key==='addStyleTag'?'file paths are unavailable':"file paths are unavailable; return new Blob([await page."+key+"()], { type: '"+(key==='pdf'?'application/pdf':'image/png')+"' }) instead");
   const selectors=kind==='Page'||kind==='Frame'?(key==='dragAndDrop'?[0,1]:PAGE_SELECTORS.has(key)?[0]:[])
    :(kind==='Locator'||kind==='FrameLocator')&&(key==='locator'||key==='frameLocator')?[0]:kind==='ElementHandle'&&key==='waitForSelector'?[0]:[];
   for(const index of selectors)args[index]=rewrite(args[index],baseOf(kind,target));
  };
  const JAVASCRIPT=new Set(['evaluate','evaluateHandle','$eval','$$eval','evaluateAll','waitForFunction','addScriptTag','addInitScript','setContent','exposeFunction','exposeBinding']);
  const policy=(kind,key)=>{
   if(JAVASCRIPT.has(key))return "in-page JavaScript is unavailable; read the page with locators (innerText, getAttribute, inputValue, allInnerTexts) or page.ariaSnapshot({ mode: 'ai' })";
   if(['$','$$','elementHandle','elementHandles'].includes(key)&&['Page','Frame','Locator','ElementHandle'].includes(kind))return 'element handles are unavailable; use locators';
   if(key==='setViewportSize')return 'the viewport size is fixed';
   if(kind==='Response'&&['body','text','json'].includes(key))return 'response bodies are unavailable; open the URL with page.goto and read the page';
   if(['route','unroute','unrouteAll','routeFromHAR','routeWebSocket'].includes(key)&&(kind==='Page'||kind==='BrowserContext'))return 'request interception is unavailable';
   if(key==='request'&&(kind==='Page'||kind==='BrowserContext'))return 'direct HTTP requests are unavailable; open the URL with page.goto and read the page';
   if(key==='coverage'&&kind==='Page')return 'script coverage returns response bodies, which are unavailable';
   if(kind==='BrowserContext'){
    if(key==='tracing')return 'tracing is unavailable';
    if(['addCookies','clearCookies','setStorageState'].includes(key))return 'cookie and storage writes are unavailable';
    if(['cookies','storageState'].includes(key))return 'browser-wide credential operations are unavailable';
    if(['browser','newCDPSession','close','grantPermissions','clearPermissions'].includes(key))return 'browser-wide operations, new browsers and new contexts are unavailable';
   }
   if(kind==='Download'&&(key==='saveAs'||key==='createReadStream'))return 'downloads stay in '+downloads+'; read the file at await download.path() with Read or Shell';
  };

  const wrapped = new WeakMap(), originals = new WeakMap(), callbacks = new WeakMap();
  function callback(value) {
   if(!callbacks.has(value))callbacks.set(value,(...args)=>value(...args.map(wrap)));
   return callbacks.get(value);
  }
  // Host callbacks (listeners, predicates, locator handlers) only ever see
  // guarded objects, wherever they sit in the arguments.
  function unwrap(value, seen = new WeakMap()) {
   if (typeof value === 'function') return originals.has(value) ? originals.get(value) : callback(value);
   if (!value || typeof value !== 'object') return value;
   if (originals.has(value)) return originals.get(value);
   if (seen.has(value)) return seen.get(value);
   const tag = Object.prototype.toString.call(value);
   if (!Array.isArray(value) && tag !== '[object Object]') return value;
   const copy = Array.isArray(value) ? [] : Object.create(null);
   seen.set(value,copy);
   for (const key of Object.keys(value)) copy[key]=unwrap(value[key],seen);
   return copy;
  }
  const kindOf=value=>{try{return Object.getPrototypeOf(value)?.constructor?.name||'Object';}catch{return 'Object';}};
  function wrap(value) {
   if (!value || !['object','function'].includes(typeof value)) return value;
   if (value instanceof Promise) return value.then(wrap);
   if (Array.isArray(value)) return value.map(wrap);
   if (wrapped.has(value)) return wrapped.get(value);
   // Data, not browser handles: keep their own prototypes so Buffer, Blob and
   // instanceof checks behave normally in the script.
   if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob || value instanceof Date || value instanceof RegExp || value instanceof URL || value instanceof Error) return value;
   // Serialized page/network data is not a Playwright API object. Preserve
   // ordinary field names while keeping guards on actual browser handles.
   const prototype=Object.getPrototypeOf(value);
   if (prototype===Object.prototype || prototype===null) {
    const copy=Object.create(null);wrapped.set(value,copy);
    for(const key of Object.keys(value))copy[key]=wrap(value[key]);
    return copy;
   }
   const proxy = new Proxy(value, {
    get(target, key) {
     if (typeof key !== 'string') {
      // await using would close the shared context through its disposer.
      if (key === Symbol.asyncDispose && kindOf(target) === 'BrowserContext') throw deny('BrowserContext.close','browser-wide operations, new browsers and new contexts are unavailable');
      const member=Reflect.get(target,key,target);
      return typeof member==='function' ? (...args)=>wrap(Reflect.apply(member,target,args.map(value=>unwrap(value)))) : member;
     }
     const kind=kindOf(target), api=kind+'.'+key;
     if (key.startsWith('_') || ['constructor','prototype','__proto__'].includes(key)) throw deny(api,'internal browser properties are unavailable');
     if(key==='opener' && allowed.has(target))return async()=>wrap(openers.get(target) || await target.opener());
     if (kind === 'BrowserContext' && key === 'pages') return () => [...allowed].filter(p => !p.isClosed()).map(wrap);
     if (kind === 'BrowserContext' && key === 'newPage') return async () => { const p=await target.newPage();allowed.add(p);watch(p);await progress({});return wrap(p); };
     const reason=policy(kind,key);
     if (reason) throw deny(api,reason);
     if (key === 'ariaSnapshot' && (allowed.has(target) || kind === 'Locator')) return async (options={}) => {
      const {mode,...rest}=unwrap(options)||{};
      if (mode !== 'ai') return kind === 'Locator' ? target.ariaSnapshot(rest) : target.locator('body').ariaSnapshot(rest);
      return kind === 'Locator' ? scopedSnapshot(target,rest) : snapshotOf(target);
     };
     if (key === 'setInputFiles' || (key === 'setFiles' && kind === 'FileChooser')) return async (...args) => {
      prepareCall(kind,key,args,api,target);
      const index=kind==='Page'||kind==='Frame'?1:0;
      const call=args.map(value=>unwrap(value));
      call[index]=await uploadFiles(api,call[index]);
      const result=await Reflect.apply(target[key],target,call);
      await uploaded(pageOf(kind,target));
      return wrap(result);
     };
     if (kind === 'Download' && key === 'path') return async () => {
      const temporary=await target.path();
      const record=savedDownload(nodePath.basename(temporary));
      await deadline(record.done,5000).catch(()=>{});
      if(record.filePath)return record.filePath;
      throw new Error('The browser did not report where it saved '+target.suggestedFilename()+'; look for it in '+downloads);
     };
     const member = Reflect.get(target,key,target);
     if (typeof member !== 'function') return wrap(member);
     return (...args) => {
      prepareCall(kind,key,args,api,target);
      const action = () => Reflect.apply(member,target,args.map(value => unwrap(value)));
      const owner = allowed.has(target) ? target : typeof target.page === 'function' ? target.page() : null;
      const waitForFront = ['click','dblclick','hover'].includes(key) && owner && !args.some(a => a && typeof a === 'object' && a.force === true);
      const result = waitForFront ? (async () => {
       const deadline=Date.now()+(args.find(a=>a && typeof a==='object' && typeof a.timeout==='number')?.timeout || 5000);
       while (front !== owner) {
        if(owner.isClosed())throw new Error('Action target tab is closed');
        if(Date.now()>=deadline)throw new Error('Action target is not the foreground tab; use bringToFront before interacting');
        await new Promise(resolve => setTimeout(resolve,25));
       }
       return action();
      })() : action();
      if (['accept','dismiss'].includes(key) && kind === 'Dialog')
       return Promise.resolve(result).then(value=>{handledDialogs.add(target);return wrap(value)});
      if (key === 'bringToFront' && allowed.has(target)) return Promise.resolve(result).then(async () => { if(front!==target)previousFront.set(target,front);front=target;await progress({}); });
      return wrap(result);
     };
    },
    getPrototypeOf() { return null; },
   });
   wrapped.set(value,proxy); originals.set(proxy,value);return proxy;
  }

  // A file chooser an earlier call opened is held by the parent's connection.
  const fileChooser = chooser ? Object.freeze({
   isMultiple: () => chooser.multiple,
   page: () => wrap([...allowed].find(p => ids.get(p) === chooser.target) || null),
   setFiles: async files => {
    files = unwrap(files);
    const list = Array.isArray(files) ? files : [files];
    let body;
    if (list.length && list.every(file => typeof file === 'string')) {
     for (const file of list) if (!nodePath.isAbsolute(file) || !within(workspace,nodePath.resolve(file))) throw deny('FileChooser.setFiles',UPLOAD_RULE);
     body = {paths: list};
    } else if (list.every(file => file && typeof file === 'object' && file.buffer !== undefined))
     body = {payloads: list.map(file => ({name: String(file.name), mimeType: String(file.mimeType || 'application/octet-stream'), buffer: Buffer.from(file.buffer).toString('base64')}))};
    else throw new TypeError('setFiles accepts absolute paths or { name, mimeType, buffer } objects');
    await ask({type:'chooser',target:chooser.target,...body});
   },
  }) : null;

  const output = type => new Writable({write(chunk,encoding,callback) {
   const text=chunk.toString();logBytes+=Buffer.byteLength(text);
   if(logBytes>maxBytes)throw new Error('browser_run_code output exceeds 256 KB');
   log({type,text:text.replace(/\n$/,'')});callback();
  }});
  const consoleObject=new Console({stdout:output('log'),stderr:output('error'),ignoreErrors:false});
  await page.bringToFront();
  context.setDefaultTimeout(5000);context.setDefaultNavigationTimeout(30000);
  if (usesRefs) await Promise.all([...allowed].filter(p => refPages[ids.get(p)] !== undefined).map(p => deadline(mapRefs(p, refPages[ids.get(p)]),3000).catch(() => {})));
  const sandbox=vm.createContext({page:wrap(page),console:consoleObject,Blob,Buffer,URL,TextEncoder,TextDecoder}, {codeGeneration:{strings:false,wasm:false}});
  started=true;
  const script=new vm.Script('('+code+'\n)',{filename:'browser_run_code.js'}).runInContext(sandbox,{timeout:30000});
  if(typeof script!=='function')throw new TypeError('code must be a function such as async (page) => { ...; return value; }');
  const result=await script(sandbox.page,{fileChooser});
  await Promise.all(popupTasks);

  // Image Blobs come back as images named by their key; a PDF Blob is saved.
  const images=[];let imageTotal=0;
  const sniff=bytes=>bytes.subarray(0,4).toString('hex')==='89504e47'?'image/png':bytes.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':bytes.subarray(0,4).toString('latin1')==='GIF8'?'image/gif':bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP'?'image/webp':bytes.subarray(0,5).toString('latin1')==='%PDF-'?'application/pdf':null;
  const returnBlob=async(key,blob)=>{
   const bytes=Buffer.from(await blob.arrayBuffer());
   const declared=String(blob.type||'').split(';')[0].trim().toLowerCase();
   const type=sniff(bytes);
   if(type==='application/pdf'){
    if(bytes.length>pdfBytes)return 'PDF omitted: '+bytes.length+' bytes is over the '+pdfBytes+' byte limit';
    return ask({type:'pdf',key,data:bytes.toString('base64')});
   }
   if(type){
    if(images.length>=maxImages)return 'image omitted: at most '+maxImages+' images per call';
    if(imageTotal+bytes.length>imageBytes)return 'image omitted: images in one call are limited to '+imageBytes+' bytes';
    images.push({key,mimeType:type,data:bytes.toString('base64')});imageTotal+=bytes.length;
    return '<image '+key+': '+type+', '+bytes.length+' bytes>';
   }
   return 'Blob omitted: '+(declared||'untyped')+' data is not a PNG, JPEG, GIF or WebP image or a PDF';
  };
  let value=result;
  if(value instanceof Blob)value=await returnBlob('result',value);
  else if(value&&typeof value==='object'&&!Array.isArray(value)&&!originals.has(value)&&Object.prototype.toString.call(value)==='[object Object]'){
   const copy={};
   for(const key of Object.keys(value))copy[key]=value[key] instanceof Blob?await returnBlob(key,value[key]):value[key];
   value=copy;
  }
  const encoded=JSON.stringify({result: value === undefined ? null : value,stdio},(key,item)=>item instanceof Blob?'Blob omitted: return Blobs directly or as top-level values':item);
  if(Buffer.byteLength(encoded)>maxBytes)throw new Error('browser_run_code output exceeds 256 KB');
  process.stdout.write(JSON.stringify({payload:JSON.parse(encoded),images,...await state()}));
 } catch(error) {
  const tabs = state ? await state().catch(()=>({})) : {};
  const raw=error && typeof error.message==='string' ? error.message : String(error);
  let message=publicMessage(raw);
  if(/openteam-ref/.test(raw)&&/Timeout \d+ms exceeded/.test(raw))
   message+="\nThe ref may be stale: the page navigated or re-rendered that element. Take a fresh await page.ariaSnapshot({ mode: 'ai' }) and use a ref from it.";
  const code=policyErrors.has(error)?'policy_denied'
   :!started || workerErrors.has(error) || (browser && !browser.isConnected()) || /Target crashed|Page crashed/i.test(raw)?'worker_failed'
   :/Script execution timed out/.test(raw)?'timed_out':'job_failed';
  process.stdout.write(JSON.stringify({payload:{error:{code,message},stdio},images:[],...tabs}));
 }
 finally { if(browser)await browser.close().catch(()=>{}); if(process.connected)process.disconnect(); }
});
`;

export type RunCodeErrorCode = "policy_denied" | "job_failed" | "worker_failed" | "timed_out";
export interface RunCodeState { targets: string[]; selected: string | null; dialog?: string }
export type RunCodeFilePayload = { name: string; mimeType: string; buffer: string };
export type RunCodeRequest =
  | { type: "snapshot"; target: string; scope?: string }
  | { type: "files"; paths: string[] }
  | { type: "chooser"; target: string; paths?: string[]; payloads?: RunCodeFilePayload[] }
  | { type: "uploaded"; target: string }
  | { type: "pdf"; key: string; data: string };
/** Answers a script's requests. A thrown error may carry a policy_denied or
 * job_failed `code`; any other failure is reported as a worker fault. */
export interface RunCodeHost {
  progress?: (state: RunCodeState) => void | Promise<void>;
  request?: (request: RunCodeRequest) => Promise<unknown>;
}
export interface RunCodeInput {
  endpoint: string;
  targets: string[];
  selected: string;
  code: string;
  /** Uploads are limited to absolute paths under this directory. */
  workspace?: string;
  /** Where Chrome saves downloads, for messages. */
  downloads?: string;
  /** Tabs with snapshot refs; true when some refs belong to cross-origin frames. */
  refPages?: Record<string, boolean>;
  /** A file chooser held by the parent connection, offered as the second argument. */
  chooser?: { target: string; multiple: boolean } | null;
}
export interface RunCodeResult {
  payload: { result?: unknown; error?: { code: RunCodeErrorCode; message: string }; stdio: Array<{ type: string; text: string }> };
  images: Array<{ key: string; mimeType: string; data: string }>;
  targets: string[];
  selected: string | null;
}

/** Counts pages in a PDF the browser printed. */
export function pdfPageCount(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  if (pages) return pages;
  return Math.max(0, ...[...text.matchAll(/\/Count\s+(\d+)/g)].map(match => Number(match[1])));
}

export async function runBrowserCode(input: RunCodeInput, signal?: AbortSignal, timeoutMs = RUN_CODE_TIMEOUT_MS, host: RunCodeHost | NonNullable<RunCodeHost["progress"]> = {}): Promise<RunCodeResult> {
  if (typeof input.code !== "string" || !input.code.trim() || input.code.length > 16_384)
    throw new Error("browser_run_code requires code of 1 to 16384 characters");
  signal?.throwIfAborted();
  const handlers: RunCodeHost = typeof host === "function" ? { progress: host } : host;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary(), ["-e", runner], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let output = "", stderr = "", finished = false;
    let latest: RunCodeState = { targets: input.targets, selected: input.selected };
    const streamed: RunCodeResult["payload"]["stdio"] = [];
    // Failures the script could not report itself keep the logs and the last
    // tab state it reported, so the caller can continue from there.
    const failure = (code: RunCodeErrorCode, message: string): RunCodeResult =>
      ({ payload: { error: { code, message }, stdio: streamed }, images: [], targets: latest.targets, selected: latest.selected });
    const finish = (error?: Error, value?: RunCodeResult) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new Error("browser_run_code cancelled; prior browser actions may have completed"));
    const timer = setTimeout(() => finish(undefined, failure("timed_out", `browser_run_code ran past its ${Math.round(timeoutMs / 1000)} second limit and was stopped; the steps before that already ran`)), timeoutMs);
    signal?.addEventListener("abort", abort, {once:true});
    if (signal?.aborted) abort();
    const reply = (id: number, pending: unknown) => void Promise.resolve(pending).then(value => {
      if(child.connected)child.send({ack:id,value:value ?? null},()=>{});
    },error=>{
      const code = (error as {code?: unknown})?.code;
      if(child.connected)child.send({ack:id,error:error instanceof Error ? error.message : String(error),code:code === "policy_denied" || code === "job_failed" ? code : "worker_failed"},()=>{});
    });
    child.on("error", error => finish(undefined, failure("worker_failed", error.message)));
    child.stdin!.on("error", error => finish(undefined, failure("worker_failed", error.message)));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => {
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0,newline); output=output.slice(newline+1);
        let message;
        try { message=JSON.parse(line); }
        catch { finish(undefined, failure("worker_failed", "Invalid browser script progress")); return; }
        if (message.stdio) streamed.push(message.stdio);
        else if (message.progress) {
          latest = { targets: message.progress.targets, selected: message.progress.selected };
          reply(message.id, handlers.progress?.(message.progress));
        } else if (message.request)
          reply(message.id, handlers.request ? handlers.request(message.request) : Promise.reject(new Error("This browser script request is unavailable")));
      }
      if (output.length > RUN_CODE_MESSAGE_CHARS) finish(undefined, failure("worker_failed", "browser_run_code output exceeds its transfer limit"));
    });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("close", code => {
      if (finished) return;
      try {
        const response = JSON.parse(output);
        if (!response.payload) throw new Error("No script result");
        finish(undefined, {
          payload: response.payload, images: response.images ?? [],
          targets: response.targets ?? latest.targets,
          selected: response.selected !== undefined ? response.selected : latest.selected,
        });
      } catch {
        finish(undefined, failure("worker_failed", `The browser script process exited (${code}) without a result${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });
    child.stdin!.end(JSON.stringify({
      ...input, workspace: input.workspace ?? "/workspace", downloads: input.downloads ?? "the Downloads folder",
      refPages: input.refPages ?? {}, chooser: input.chooser ?? null,
      modulePath: require.resolve("playwright-core"), refEngine: REF_ENGINE,
      maxBytes: RUN_CODE_MAX_BYTES, maxImages: RUN_CODE_MAX_IMAGES, imageBytes: RUN_CODE_IMAGE_BYTES, pdfBytes: RUN_CODE_PDF_BYTES,
    }));
  });
}
