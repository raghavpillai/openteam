import {expect,test} from 'bun:test';
import {Effect} from 'effect';
import {SubagentService} from '../../src/services/subagent/service';
function fixture(cancel:()=>Promise<void>, runStatus='running') {
 const child:any={id:'child',parentBotId:'parent',currentRunId:'run',status:'running',prompt:'Check the page'};
 const events:any[]=[];
 const db:any={
  subagent:{findFirst:async()=>({...child}),findUnique:async()=>({...child}),findMany:async()=>[],update:async({data}:any)=>Object.assign(child,data),updateMany:async({where,data}:any)=>{
   if(where.currentRunId!==child.currentRunId||!where.status.in.includes(child.status))return {count:0};Object.assign(child,data);return {count:1};}},
  subagentAttempt:{updateMany:async()=>({count:1})},
  run:{findUnique:async()=>({status:runStatus})},
  event:{create:async({data}:any)=>events.push(data)}
 };
 db.$transaction=async(fn:any)=>fn(db);
 const service=new SubagentService(db,{} as never,{cancel:()=>Effect.tryPromise(cancel)} as never,'/workspace',{} as never,{} as never);
 return {service,child,events};
}
test('failed cancellation leaves worker active and retryable, never reports stopped',async()=>{
 const f=fixture(async()=>{throw new Error('computer connection timeout')});
 await expect(f.service.stop('parent','call',{subagent_id:'child'})).rejects.toThrow();
 expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
});
test('stop does not announce completion while cancellation is pending',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);const f=fixture(()=>pending);
 const result=f.service.stop('parent','call',{subagent_id:'child'});
 await new Promise(r=>setTimeout(r,10));expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
 release();expect(await result).toMatchObject({stopped:true,status:'stopped'});expect(f.child.status).toBe('stopped');
});
test('terminal run racing with failed cancellation can settle stopped',async()=>{
 const f=fixture(async()=>{throw new Error('already finished')},'completed');
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toMatchObject({stopped:true});
});
test('completion race is not overwritten as stopped',async()=>{
 const f=fixture(async()=>{f.child.status='completed'});
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toBe('No subagent "sand-subagent-child" is currently running. It may have already finished (you\'re revived automatically with a finished subagent\'s result), or the id is wrong. No subagents are running right now.');
 expect(f.child.status).toBe('completed');expect(f.events).toHaveLength(0);
});
test('new attempt is not stopped by acknowledgement for an older attempt',async()=>{
 const f=fixture(async()=>{f.child.currentRunId='new-run'});
 expect(await f.service.stop('parent','call',{subagent_id:'child'})).toMatchObject({stopped:false,status:'running'});
 expect(f.child.currentRunId).toBe('new-run');expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
});
function stopAllFixture(children: any[], cancel: (runId: string) => Promise<void>) {
 const events: any[] = [];
 const db: any = {
  subagent: {
   findMany: async ({ where }: any) => children.filter((child) => child.parentBotId === where.parentBotId && where.status.in.includes(child.status)),
   findUnique: async ({ where }: any) => ({ ...children.find((child) => child.id === where.id) }),
   updateMany: async ({ where, data }: any) => {
    const child = children.find((candidate) => candidate.id === where.id);
    if (!child || where.currentRunId !== child.currentRunId || !where.status.in.includes(child.status)) return { count: 0 };
    Object.assign(child, data); return { count: 1 };
   },
  },
  subagentAttempt: { updateMany: async () => ({ count: 1 }) },
  run: { findUnique: async () => ({ status: 'running' }) },
  event: { create: async ({ data }: any) => events.push(data) },
 };
 db.$transaction = async (fn: any) => fn(db);
 const service = new SubagentService(db, {} as never, { cancel: (runId: string) => Effect.tryPromise({ try: () => cancel(runId), catch: (error) => error }) } as never, '/workspace', {} as never, {} as never);
 return { service, events };
}
const worker = (id: string, extra: Record<string, unknown> = {}) =>
 ({ id, parentBotId: 'parent', currentRunId: `run-${id}`, status: 'running', subagentType: 'executor', prompt: `Worker ${id}`, ...extra });
test('stop all stops each running subagent on its own and reports every outcome', async () => {
 const children = [worker('a'), worker('b', { subagentType: 'computerUse' }), worker('c'), worker('d', { parentBotId: 'other' }), worker('e', { status: 'completed' })];
 const f = stopAllFixture(children, async (runId) => {
  if (runId === 'run-b') throw new Error('computer connection timeout');
  if (runId === 'run-c') children[2]!.status = 'completed';
 });
 expect(await f.service.stop('parent', 'call', { all: true })).toEqual({
  stopped_all: true,
  stopped: [{ subagent_id: 'sand-subagent-a', subagent_type: 'executor', title: 'Worker a' }],
  already_finished: [{ subagent_id: 'sand-subagent-c', subagent_type: 'executor', title: 'Worker c' }],
  failed: [{ subagent_id: 'sand-subagent-b', subagent_type: 'computerUse', title: 'Worker b', error: 'computer connection timeout' }],
 });
 expect(children.map((child) => child.status)).toEqual(['stopped', 'running', 'completed', 'running', 'completed']);
 expect(f.events).toHaveLength(1);
});
test('stop all with nothing running reports an empty receipt', async () => {
 const f = stopAllFixture([worker('a', { status: 'completed' })], async () => {});
 expect(await f.service.stop('parent', 'call', { all: true })).toEqual({ stopped_all: true, stopped: [], already_finished: [], failed: [] });
});
