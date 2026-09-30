import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { nodeBinary } from "../node-runtime";

const require = createRequire(import.meta.url);
export const RUN_CODE_TIMEOUT_MS = 30_000;
export const RUN_CODE_MAX_BYTES = 256 * 1024;

// A separate process makes CPU loops and unresolved promises cancellable without
// terminating the computer runtime. This is not an OS security sandbox; the
// worker already has Shell authority. Do not pass runtime credentials to it.
const runner = String.raw`
const vm = require('node:vm');
const {Console} = require('node:console');
const {Writable} = require('node:stream');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
 let browser, state;
 const stdio=[]; let logBytes=0;
 try {
  const {modulePath, endpoint, targets, selected, code, maxBytes} = JSON.parse(input);
  const {chromium} = require(modulePath);
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const allowed = new Set();
  const ids = new Map(), targetInfoByPage = new Map();
  async function identify(page) {
   if (ids.has(page)) return ids.get(page);
   const cdp = await context.newCDPSession(page);
   try { const {targetInfo} = await cdp.send('Target.getTargetInfo'); ids.set(page,targetInfo.targetId);targetInfoByPage.set(page,targetInfo);return targetInfo.targetId; }
   finally { await cdp.detach(); }
  }
  for (const page of context.pages()) if (targets.includes(await identify(page))) allowed.add(page);
  let page = [...allowed].find(p => ids.get(p) === selected);
  if (!page) throw new Error('Selected browser tab is unavailable');
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
  // Merely connecting a second Playwright client must not dismiss dialogs.
  let progressId=0;
  const acknowledgements=new Map();
  process.on('message',message=>{
   const waiting=acknowledgements.get(message.ack);
   if(waiting){acknowledgements.delete(message.ack);message.error?waiting.reject(new Error(message.error)):waiting.resolve();}
  });
  const progress = async extra => {
   const id=++progressId;
   const ready=new Promise((resolve,reject)=>acknowledgements.set(id,{resolve,reject}));
   process.stdout.write(JSON.stringify({id,progress:{...await state(),...extra}})+'\n');
   await ready;
  };
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
     stdio.push({type:'info',text:'A popup opened; subsequent browser calls use the popup tab.'});
     await progress({});
    }
   });
   popupTasks.add(pending);
   void pending.catch(()=>{}).finally(()=>popupTasks.delete(pending));
  });
  const wrapped = new WeakMap(), originals = new WeakMap(), callbacks = new WeakMap();
  function callback(value) {
   if(!callbacks.has(value))callbacks.set(value,(...args)=>value(...args.map(wrap)));
   return callbacks.get(value);
  }
  function unwrap(value, seen = new WeakMap()) {
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
  function wrap(value) {
   if (!value || !['object','function'].includes(typeof value)) return value;
   if (value instanceof Promise) return value.then(wrap);
   if (Array.isArray(value)) return value.map(wrap);
   if (wrapped.has(value)) return wrapped.get(value);
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
     if (typeof key === 'string' && (key.startsWith('_') || ['constructor','prototype','__proto__'].includes(key))) throw new Error('Internal browser properties are unavailable');
     if(key==='opener' && allowed.has(target))return async()=>wrap(openers.get(target) || await target.opener());
     if (target === context) {
      if (key === 'pages') return () => [...allowed].filter(p => !p.isClosed()).map(wrap);
      if (key === 'newPage') return async () => { const p=await context.newPage();allowed.add(p);watch(p);await progress({});return wrap(p); };
      if (['browser','newCDPSession','close','cookies','addCookies','clearCookies','storageState','setStorageState'].includes(key)) throw new Error('Browser-wide and credential operations are unavailable in browser_run_code');
     }
     if (key === 'setInputFiles' || (key === 'setFiles' && typeof target.isMultiple === 'function')) throw new Error('Use browser_file_upload for reviewed workspace uploads');
     const member = Reflect.get(target,key,target);
     if (typeof member !== 'function') return wrap(member);
     return (...args) => {
      const action = () => Reflect.apply(member,target,args.map(value => typeof value==='function' && ['on','once','addListener','removeListener','off','route','unroute','waitForEvent','waitForResponse','waitForRequest'].includes(key) ? callback(value) : unwrap(value)));
      const owner = allowed.has(target) ? target : typeof target.page === 'function' ? target.page() : null;
      const waitForFront = ['click','dblclick','hover'].includes(key) && owner && !args.some(a => a && typeof a === 'object' && a.force === true);
      const result = waitForFront ? (async () => {
       const deadline=Date.now()+(args.find(a=>a && typeof a==='object' && typeof a.timeout==='number')?.timeout || 30000);
       while (front !== owner) {
        if(owner.isClosed())throw new Error('Action target tab is closed');
        if(Date.now()>=deadline)throw new Error('Action target is not the foreground tab; use bringToFront before interacting');
        await new Promise(resolve => setTimeout(resolve,25));
       }
       return action();
      })() : action();
      if (['accept','dismiss'].includes(key) && typeof target.type === 'function' && typeof target.message === 'function')
       return Promise.resolve(result).then(value=>{handledDialogs.add(target);return wrap(value)});
      if (key === 'bringToFront' && allowed.has(target)) return Promise.resolve(result).then(async () => { if(front!==target)previousFront.set(target,front);front=target;await progress({}); });
      return wrap(result);
     };
    },
    getPrototypeOf() { return null; },
   });
   wrapped.set(value,proxy); originals.set(proxy,value);return proxy;
  }
  const output = type => new Writable({write(chunk,encoding,callback) {
   const text=chunk.toString();logBytes+=Buffer.byteLength(text);
   if(logBytes>maxBytes)throw new Error('browser_run_code output exceeds 256 KB');
   stdio.push({type,text:text.replace(/\n$/,'')});callback();
  }});
  const consoleObject=new Console({stdout:output('log'),stderr:output('error'),ignoreErrors:false});
  await page.bringToFront();
  context.setDefaultTimeout(30000);context.setDefaultNavigationTimeout(30000);
  const sandbox=vm.createContext({page:wrap(page),console:consoleObject,Buffer,URL,TextEncoder,TextDecoder}, {codeGeneration:{strings:false,wasm:false}});
  const result=await new vm.Script('('+code+')(page)').runInContext(sandbox,{timeout:30000});
  await Promise.all(popupTasks);
  const payload={result: result === undefined ? null : result,stdio};
  const encoded=JSON.stringify(payload);
  if(Buffer.byteLength(encoded)>maxBytes)throw new Error('browser_run_code output exceeds 256 KB');
  process.stdout.write(JSON.stringify({payload,...await state()}));
 } catch(error) {
  const tabs = state ? await state().catch(()=>({})) : {};
  const message=error && typeof error.message==='string' ? error.message : String(error);
  process.stdout.write(JSON.stringify({error:message,payload:{error:{code:'job_failed',message},stdio},...tabs}));
 }
 finally { if(browser)await browser.close().catch(()=>{}); if(process.connected)process.disconnect(); }
});
`;

export interface RunCodeResult {
  error?: string;
  payload: { result?: unknown; error?: {code: string; message: string}; stdio: Array<{ type: string; text: string }> };
  targets: string[];
  selected: string | null;
}

export async function runBrowserCode(input: {endpoint: string; targets: string[]; selected: string; code: string}, signal?: AbortSignal, timeoutMs = RUN_CODE_TIMEOUT_MS, onProgress?: (state: {targets: string[]; selected: string | null; dialog?: string}) => void | Promise<void>): Promise<RunCodeResult> {
  if (typeof input.code !== "string" || !input.code.trim() || input.code.length > 16_384)
    throw new Error("browser_run_code requires code of 1 to 16384 characters");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary(), ["-e", runner], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let output = "", stderr = "", finished = false;
    const finish = (error?: Error, value?: RunCodeResult) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new Error("browser_run_code cancelled; prior browser actions may have completed"));
    const timer = setTimeout(() => finish(new Error("browser_run_code exceeded its 30 second limit; prior browser actions may have completed")), timeoutMs);
    signal?.addEventListener("abort", abort, {once:true});
    if (signal?.aborted) abort();
    child.on("error", error => finish(error));
    child.stdin!.on("error", error => finish(error));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => {
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0,newline); output=output.slice(newline+1);
        try {
          const message=JSON.parse(line);
          if(message.progress) void Promise.resolve(onProgress?.(message.progress)).then(() => {
            if(child.connected)child.send({ack:message.id},()=>{});
          },error=>{
            if(child.connected)child.send({ack:message.id,error:String(error)},()=>{});
          });
        }
        catch { finish(new Error("Invalid browser script progress")); return; }
      }
      if (Buffer.byteLength(output) > RUN_CODE_MAX_BYTES + 64 * 1024) finish(new Error("browser_run_code output exceeds 256 KB"));
    });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("close", code => {
      if (finished) return;
      try {
        const response = JSON.parse(output);
        if (response.error && !response.targets) finish(new Error(response.error));
        else if (response.error) finish(undefined, response);
        else if (code !== 0 || !response.payload) finish(new Error(`browser_run_code failed (${code}): ${stderr}`));
        else finish(undefined, response);
      } catch { finish(new Error(`browser_run_code returned invalid output (${code}): ${stderr}`)); }
    });
    child.stdin!.end(JSON.stringify({...input,modulePath:require.resolve("playwright-core"),maxBytes:RUN_CODE_MAX_BYTES}));
  });
}
