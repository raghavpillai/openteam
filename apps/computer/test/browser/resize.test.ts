import {expect,test} from 'bun:test';
import {BrowserUseSession,BROWSER_USE_TOOLS} from '../../src/browser/use';

test('resize exposes dimensions and acts only on the selected leased page',async()=>{
 expect(BROWSER_USE_TOOLS.some(t=>t.name==='browser_resize')).toBe(true);
 const calls:unknown[]=[];
 const page={setViewportSize:async(size:unknown)=>{calls.push(size);}};
 const owner={viewId:(args:any)=>args.viewId,ensurePage:async(id:string)=>{
   if(id!=='owned')throw new Error('Browser tab is unavailable');return page;
 },pageState:async(p:unknown,label:string)=>({content:[{type:'text',text:label}],details:{}}),
 resize:(BrowserUseSession.prototype as any).resize};
 const run=(args:unknown,signal?:AbortSignal)=>(BrowserUseSession.prototype as any).executeRaw.call(owner,'browser_resize',args,signal);
 await run({viewId:'owned',width:390,height:800});
 expect(calls).toEqual([{width:390,height:800}]);
 await expect(run({viewId:'foreign',width:390,height:800})).rejects.toThrow('unavailable');
 await expect(run({viewId:'owned',width:390,height:800},AbortSignal.abort())).rejects.toThrow();
 for(const width of [0,-1,1.5,Infinity,'390'])
   await expect(run({viewId:'owned',width,height:800})).rejects.toThrow('positive integers');
 expect(calls).toHaveLength(1);
});

test('resize propagates a crashed target without claiming success or resizing another tab',async()=>{
 let observations=0;
 const owner={viewId:()=>undefined,ensurePage:async()=>({setViewportSize:async()=>{throw new Error('Target crashed');}}),
 pageState:async()=>{observations++;}};
 await expect((BrowserUseSession.prototype as any).resize.call(owner,{width:390,height:800})).rejects.toThrow('Target crashed');
 expect(observations).toBe(0);
});

test('cancellation during resize does not emit a successful observation',async()=>{
 const controller=new AbortController();let observations=0;
 const owner={viewId:()=>undefined,ensurePage:async()=>({setViewportSize:async()=>{controller.abort();}}),
 pageState:async()=>{observations++;}};
 await expect((BrowserUseSession.prototype as any).resize.call(owner,{width:1280,height:800},controller.signal)).rejects.toThrow();
 expect(observations).toBe(0);
});
