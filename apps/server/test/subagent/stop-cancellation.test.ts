import {expect,test} from 'bun:test';
import {Effect} from 'effect';
import {SubagentService} from '../../src/services/subagent/service';
const shellStops=(stops:string[], ok=()=>true)=>async(path:string,init:RequestInit)=>{
 expect(init.method).toBe('POST');stops.push(path);return new Response(ok()?'{"stopped":1}':'computer unavailable',{status:ok()?200:503});
};
function fixture(cancel:()=>Promise<void>, runStatus='running', shellsOk=()=>true) {
 const child:any={id:'child',childBotId:'child-bot',parentBotId:'parent',currentRunId:'run',status:'running',prompt:'Check the page'};
 const stops:string[]=[];
 const events:any[]=[];
 const db:any={
  subagent:{findFirst:async()=>({...child}),findUnique:async()=>({...child}),findMany:async()=>[],update:async({data}:any)=>Object.assign(child,data),updateMany:async({where,data}:any)=>{
   if(where.currentRunId!==child.currentRunId||!where.status.in.includes(child.status))return {count:0};Object.assign(child,data);return {count:1};}},
  subagentAttempt:{updateMany:async()=>({count:1})},
  run:{findUnique:async()=>({status:runStatus})},
  event:{create:async({data}:any)=>events.push(data)}
 };
 db.$transaction=async(fn:any)=>fn(db);
 const service=new SubagentService(db,{} as never,{cancel:()=>Effect.tryPromise(cancel)} as never,'/workspace',shellStops(stops,shellsOk) as never,{} as never);
 return {service,child,events,stops};
}
test('failed cancellation leaves worker active and retryable, never reports stopped',async()=>{
 const f=fixture(async()=>{throw new Error('computer connection timeout')});
 await expect(f.service.stop('parent','call',{subagent_id:'child'})).rejects.toThrow();
 expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);expect(f.stops).toEqual([]);
});
test('stop does not announce completion while cancellation is pending',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);const f=fixture(()=>pending);
 const result=f.service.stop('parent','call',{subagent_id:'child'});
 await new Promise(r=>setTimeout(r,10));expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
 release();expect(await result).toMatchObject({stopped:true,status:'stopped'});expect(f.child.status).toBe('stopped');
 expect(f.stops).toEqual(['/v1/bots/child-bot/background-shells/stop']);
});
test('stopping a subagent ends its background shells, and a failure to end them leaves it running and retryable',async()=>{
 const f=fixture(async()=>{},'running',()=>false);
 await expect(f.service.stop('parent','call',{subagent_id:'child'})).rejects.toThrow("The subagent's background commands could not be stopped");
 expect(f.stops).toEqual(['/v1/bots/child-bot/background-shells/stop']);expect(f.child.status).toBe('running');expect(f.events).toHaveLength(0);
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
 const stops: string[] = [];
 const db: any = {
  $executeRaw: async () => 1,
  channelMessage: { findMany: async () => [] },
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
  run: { findUnique: async () => ({ status: 'running' }), findMany: async () => [] },
  event: { create: async ({ data }: any) => events.push(data) },
 };
 db.$transaction = async (fn: any) => fn(db);
 const service = new SubagentService(db, {} as never, { cancel: (runId: string) => Effect.tryPromise({ try: () => cancel(runId), catch: (error) => error }) } as never, '/workspace', shellStops(stops) as never, {} as never);
 return { service, events, stops };
}
const worker = (id: string, extra: Record<string, unknown> = {}) =>
 ({ id, childBotId: `bot-${id}`, parentBotId: 'parent', currentRunId: `run-${id}`, status: 'running', subagentType: 'executor', prompt: `Worker ${id}`, ...extra });
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
  delegated: [],
 });
 expect(children.map((child) => child.status)).toEqual(['stopped', 'running', 'completed', 'running', 'completed']);
 expect(f.events).toHaveLength(1);
 // The stopped worker's background shells end with it; one whose run would not cancel keeps running.
 expect(f.stops.sort()).toEqual(['/v1/bots/bot-a/background-shells/stop', '/v1/bots/bot-c/background-shells/stop']);
});
test('stop all with nothing running reports an empty receipt', async () => {
 const f = stopAllFixture([worker('a', { status: 'completed' })], async () => {});
 expect(await f.service.stop('parent', 'call', { all: true })).toEqual({ stopped_all: true, stopped: [], already_finished: [], failed: [], delegated: [] });
});

const matchesKey = (where: any, key: string) =>
 where.OR.some((clause: any) => typeof clause.idempotencyKey === 'string' ? clause.idempotencyKey === key : key.startsWith(clause.idempotencyKey.startsWith));

test('stop all cancels the turn a priority message started for a peer, with that turn\'s subagents, and reports idle peers', async () => {
 const cancelled: string[] = [];
 const children = [worker('peer-child', { parentBotId: 'peer-1', parentRunId: 'peer-run-1' })];
 const f = stopAllFixture(children, async (runId) => { cancelled.push(runId); });
 const db = (f.service as any).prisma;
 const since: Date[] = [];
 db.channelMessage.findMany = async ({ where }: any) => {
  expect(where).toMatchObject({ senderBotId: 'parent', clientId: { startsWith: 'a2a:out:' } });
  since.push(where.createdAt.gte);
  return [
   { clientId: 'a2a:out:call-2', metadata: { toAgent: { id: 'peer-1', name: 'Researcher' } } },
   { clientId: 'a2a:out:call-1', metadata: { toAgent: { id: 'peer-1', name: 'Researcher' } } },
   { clientId: 'a2a:out:call-3', metadata: { toAgent: { id: 'peer-2', name: 'Scout' } } },
   { clientId: 'a2a:out:call-4', metadata: { toAgent: { id: 'peer-3', name: 'Writer' } } },
  ];
 };
 // Only priority messages count: call-4 was an ordinary message.
 db.inboxEvent = { findMany: async ({ where }: any) => [
  { idempotencyKey: 'agent:call-2:peer-1', runId: 'peer-run-1' },
  { idempotencyKey: 'agent:call-1:peer-1', runId: 'peer-run-0' },
  { idempotencyKey: 'agent:call-3:peer-2', runId: 'peer-run-2' },
 ].filter((wake) => matchesKey(where, wake.idempotencyKey) && where.priority === 250) };
 db.run.findUnique = async ({ where }: any) => ({ status: where.id === 'peer-run-1' ? 'running' : 'completed' });
 const result: any = await f.service.stop('parent', 'call', { all: true });
 expect(Date.now() - since[0]!.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000);
 expect(result.delegated).toEqual([
  { id: 'peer-1', name: 'Researcher', result: 'stopped' },
  { id: 'peer-2', name: 'Scout', result: 'not_running' },
 ]);
 expect(cancelled).toEqual(['peer-run-1', 'run-peer-child']);
 expect(children[0]!.status).toBe('stopped');
 expect(f.stops).toEqual(['/v1/bots/bot-peer-child/background-shells/stop']);
});

test('stop all cancels a peer turn the worker ran again after a typed message cut it off', async () => {
 const cancelled: string[] = [];
 const f = stopAllFixture([], async (runId) => { cancelled.push(runId); });
 const db = (f.service as any).prisma;
 db.channelMessage.findMany = async () => [{ clientId: 'a2a:out:call-1', metadata: { toAgent: { id: 'peer-1', name: 'Researcher' } } }];
 db.inboxEvent = { findMany: async ({ where, orderBy }: any) => {
  expect(orderBy).toEqual({ createdAt: 'desc' });
  return [
   { idempotencyKey: 'agent:call-1:peer-1:redrive:1', runId: 'peer-run-1' },
   { idempotencyKey: 'agent:call-1:peer-1', runId: 'peer-run-0' },
   { idempotencyKey: 'agent:call-10:peer-1', runId: 'peer-run-9' },
  ].filter((wake) => matchesKey(where, wake.idempotencyKey) && where.priority === 250);
 } };
 db.run.findUnique = async ({ where }: any) => ({ status: where.id === 'peer-run-1' ? 'running' : 'interrupted' });
 const result: any = await f.service.stop('parent', 'call', { all: true });
 expect(result.delegated).toEqual([{ id: 'peer-1', name: 'Researcher', result: 'stopped' }]);
 expect(cancelled).toEqual(['peer-run-1']);
});
