/** Loopback-only, in-memory contract fixture shared by Swift UI tests and the RN reference.
 * Never use this harness as a product server. No model, external messages, or real accounts run here.
 */
import { mobileFixture } from "../../mobile/src/fixtures";
import type { ChannelMessageView, ClientBootstrapView, ClientSnapshot } from "../../../packages/contracts/src/index";
import { visualFixture } from "./visual-fixtures";
import { randomUUID } from "node:crypto";
import { FunctionalFixtures } from "./functional-fixtures";
import { contentScene } from "./content-fixtures";
import { validateFixtureRequest } from "./validate-fixture-request";
import { validateUserFormValues } from "../../../packages/contracts/src/review-cards";

const port = Number(process.env.SWIFT_PARITY_PORT || 19997);
let snapshot: ClientSnapshot;
let hapticAudit: unknown[] = [];
let settings: any;
let routines: any[];
let events: any[];
let sequence = 14;
let offline = false;
let dropNextSend = false;
let dropNextRoutineRun = false;
let authRequired = false;
let authExpired = false;
let invalidServer = false;
let missingToken = false;
let memories: any[] = [];
let pagedHistory = false;
let failures: Record<string, {status?: number; message?: string; count?: number; delayMs?: number}> = {};
let functionality = new FunctionalFixtures();
let screen = {state:"ready",width:1280,height:800,humanTakeover:false,apps:["chromium","thunar","terminal"]};
let contentReceipts:any[] = [];
let routineExecutions:any[] = [];
const deliveries = new Map<string, ChannelMessageView>();
const wakeups = new Set<() => void>();
const requestLog: Array<{ method: string; path: string; clientId?: string }> = [];
function reset() {
  snapshot = structuredClone(mobileFixture);
  snapshot.runtime.transcription = "configured";
  sequence = 14; events = []; deliveries.clear(); routines = []; offline = false; dropNextSend = false; authRequired = false;
  dropNextRoutineRun = false;
  pagedHistory = false;
  requestLog.length = 0;
  failures = {}; authExpired = false; invalidServer = false; missingToken = false;
  functionality = new FunctionalFixtures(); screen.humanTakeover=false; screen.state="ready"; contentReceipts=[]; routineExecutions=[];
  memories = [{ id: "memory-fixture", content: "Prefers concise summaries and clear next steps.", createdAt: 1789473600000, kind: "profile" }];
  settings = { version: 2, pinnedIds: [], unreadIds: [], unassignedCollapsed: false, sections: [], sectionByChannel: {}, channelOrderByGroup: {} };
}
reset();
function emit(topic = "channel.message.created", entityId: string | null = null) {
  events.push({ sequence: String(++sequence), topic, entityId, payload: {}, createdAt: new Date().toISOString() });
  for (const wake of wakeups) wake(); wakeups.clear();
}
function bootstrap(): ClientBootstrapView {
  return { cursor: String(sequence), workspace: snapshot.workspace, bots: snapshot.bots, channels: snapshot.channels,
    latestMessages: pagedHistory ? snapshot.channelMessages.slice(-60) : snapshot.channelMessages, activeRuns: snapshot.runs, pendingApprovals: snapshot.approvals.filter(a => a.status === "pending"),
    channelRounds: [], subagents: [], runtime: snapshot.runtime, capabilities: { } as any };
}
const response = (data: unknown, status = 200) => Response.json(data, { status });
const server = Bun.serve({
  hostname: "127.0.0.1", port, idleTimeout: 40,
  async fetch(request, server) {
    const url = new URL(request.url), path = decodeURIComponent(url.pathname), method = request.method;
    // Slow-ASR regression tests must exceed the app's ordinary HTTP deadlines.
    if (path === "/api/v0/transcriptions") server.timeout(request, 150);
    let input: any = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { input = await request.json(); } catch {} }
    if (path === "/__qa/reset" && method === "POST") { reset(); emit("snapshot.reset"); return response({ ok: true }); }
    if (path === "/__qa/scene" && method === "POST") { reset(); const visual=visualFixture(snapshot,input.scene); snapshot=visual.snapshot; settings=visual.sidebar; pagedHistory=input.scene==="history-pages"; sequence=Math.max(100,...snapshot.channelMessages.map(m=>Number(m.sequence))); emit("snapshot.reset"); return response({ok:true}); }
    if (path === "/__qa/content" && method === "POST") { snapshot=contentScene(snapshot,input.scene); sequence=400; emit("snapshot.reset"); return response({ok:true}); }
    if (path === "/__qa/motion" && method === "POST") {
      const channel = snapshot.channels.find(c => c.id === "visual-chat");
      const bot = snapshot.bots.find(b => b.dmChannelId === channel?.id);
      if (!channel || !bot) return response({error: "Load a visual chat scene first"}, 400);
      snapshot.runs = input.active ? [{...mobileFixture.runs[0]!, id:"motion-run", botId:bot.id, conversationId:bot.conversationId, channelId:channel.id, status:"running"}] : [];
      if (input.content) snapshot.channelMessages.push({id:randomUUID(),clientId:null,sequence:String(++sequence),channelId:channel.id,sender:"agent",senderBotId:bot.id,sourceRunId:"motion-run",content:input.content,metadata:{type:"text"},createdAt:new Date().toISOString()});
      emit("snapshot.reset"); return response({ok:true});
    }
    if (path === "/__qa/group-reply" && method === "POST") {
      const channel = snapshot.channels.find(c => c.id === input.channelId && c.kind === "group");
      if (!channel || (input.botId && !channel.members.some(m => m.botId === input.botId))) return response({error:"Unknown group member"},400);
      snapshot.channelMessages.push({id:randomUUID(),clientId:null,sequence:String(++sequence),channelId:channel.id,sender:input.botId?"agent":"user",senderBotId:input.botId??null,sourceRunId:null,content:input.content,metadata:{type:"text"},createdAt:new Date().toISOString()});
      emit("channel.message.created",channel.id); return response({ok:true});
    }
    if (path === "/__qa/control" && method === "POST") {
      offline = input.offline ?? offline; dropNextSend = input.dropNextSend ?? dropNextSend; authRequired = input.authRequired ?? authRequired;
      dropNextRoutineRun = input.dropNextRoutineRun ?? dropNextRoutineRun;
      if (input.screenState) screen.state = input.screenState;
      if (input.pluginCanAuthenticate !== undefined) functionality.connection.canAuthenticate = input.pluginCanAuthenticate;
      if (input.configuration) Object.assign(functionality.configuration, input.configuration);
      if (input.customAvatarRevision) {
        snapshot.bots[0]!.hasAvatar = true;
        snapshot.bots[0]!.icon = "classic";
        snapshot.bots[0]!.color = "#A47952";
        snapshot.bots[0]!.updatedAt = input.customAvatarRevision;
        const group = snapshot.channels.find(c => c.kind === "group");
        if (group) { group.hasAvatar = true; group.updatedAt = input.customAvatarRevision; }
      }
      if (input.expireTakeover) screen.humanTakeover = false;
      authExpired = input.authExpired ?? authExpired; invalidServer = input.invalidServer ?? invalidServer; missingToken = input.missingToken ?? missingToken;
      if (input.failures) failures = input.failures;
      emit("snapshot.reset"); return response({ ok: true });
    }
    if (path === "/__qa/state") return response({ messages: snapshot.channelMessages, requests: requestLog, settings, approvals: snapshot.approvals, bots: snapshot.bots, channels: snapshot.channels, memories, routines, routineExecutions, contentReceipts, screen, configuration:functionality.configuration, pluginSettings:functionality.settings(snapshot.bots), sources:functionality.sources, skills:functionality.skills });
    if (path === "/__qa/haptics") {
      if (method === "POST") hapticAudit.push(input);
      if (method === "DELETE") hapticAudit = [];
      return response(hapticAudit);
    }
    if (path === "/health") return response({ status: "ready", purpose: "swift-parity-fixture" });
    if (offline) return response({ error: { message: "Fixture offline", code: "offline" } }, 503);
    const failure = failures[`${method} ${path}`];
    if (failure && (failure.count ?? 1) > 0) {
      failure.count = (failure.count ?? 1) - 1;
      if (failure.delayMs) await Bun.sleep(failure.delayMs);
      if (failure.status) return response(failure.message ? { message: failure.message } : {}, failure.status);
    }
    if (path === "/api/auth/config") return response(invalidServer ? {mode:"unrecognized"} : { mode: authRequired ? "required" : "disabled" });
    if (path === "/api/auth/login") {
      if (input.username !== "fixture" || input.password !== "fixture-only") return response({ message: "Incorrect username or password" }, 401);
      authExpired = false;
      return Response.json({ user: { id: "fixture-owner", name: "Fixture owner", username: "fixture", email: "fixture@example.invalid", image: null } }, { headers: missingToken ? {} : { "set-auth-token": "fixture-token-not-a-real-credential" } });
    }
    if (authRequired && (authExpired || request.headers.get("authorization") !== "Bearer fixture-token-not-a-real-credential")) return response({ message: "Session expired" }, 401);
    if (path === "/api/auth/sign-out") return response({ success: true });
    if (path === "/api/auth/get-session") return response({ session: { id: "fixture" }, user: { id: "fixture-owner", name: "Fixture owner", username: "fixture", email: "fixture@example.invalid" } });
    const invalid = validateFixtureRequest(path,method,input); if(invalid)return response({message:invalid},400);
    requestLog.push({ method, path, ...(input.clientId ? { clientId: input.clientId } : {}) });
    if (process.env.SWIFT_QA_LIVE_SCREEN_URL && /\/screen(?:\/(?:frame|stream|takeover|actions))?$/.test(path)) {
      const target = new URL(path, process.env.SWIFT_QA_LIVE_SCREEN_URL);
      if (!["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("Live QA screen must be loopback-only");
      return fetch(target, {method, signal:request.signal, headers:{"Content-Type":"application/json"}, body:method === "GET" ? undefined : JSON.stringify(input)});
    }
    if(path === "/api/v0/transcriptions" && method === "POST") return response({text:"Native voice QA transcription"});
    if(path.endsWith("/screen"))return response(screen);
    if(path.endsWith("/avatar"))return new Response(Bun.file(new URL(path.includes("visual-group-") && path.includes("-bot-0/") ? "./fixtures/group-blue-avatar.png" : "./fixtures/attachment.png",import.meta.url)),{headers:{"Content-Type":"image/png"}});
    if(path.endsWith("/screen/frame"))return new Response(Bun.file(new URL("./fixtures/computer.png",import.meta.url)),{headers:{"Content-Type":"image/png"}});
    if(path.endsWith("/screen/takeover")){screen.humanTakeover=input.active;contentReceipts.push({path,active:input.active});return response(screen);}
    if(path.endsWith("/screen/actions")){if(!screen.humanTakeover)return response({message:"Take control first."},409);contentReceipts.push({path,...input});return response(screen);}
    if(path.startsWith("/api/v0/assets/")){
      contentReceipts.push({path,authenticated:request.headers.has("authorization")});
      const id=path.split('/').at(-1)!;
      const archive=/^([789])\1{63}$/.test(id), photo=/^([1-6])\1{63}$/.test(id);
      return new Response(Bun.file(new URL(archive?'./fixtures/media-archive.zip':photo?'./fixtures/media-reference.png':'./fixtures/attachment.png',import.meta.url)),{headers:{'Content-Type':archive?'application/zip':'image/png'}});
    }
    if(path.endsWith("/user-form/prefill"))return response({email:"fixture@example.invalid"});
    if(path.endsWith("/user-form")||path.endsWith("/computer-handoff")){
      const message:any=snapshot.channelMessages.find(m=>m.id===path.split("/")[4]);if(!message)return response({},404);
      contentReceipts.push({path,...input});
      if(path.endsWith("/user-form") && input.action==="submit"){try{validateUserFormValues(message.metadata.form,input.values)}catch(error){return response({message:String(error)},400)}}
      if(path.endsWith("/user-form")){message.metadata.cardState=input.action==="submit"?"completed":"dismissed";message.metadata.outcomeText=input.action==="submit"?"Form filled successfully.":"Dismissed";}
      else{message.metadata.computerHandoffState=input.action==="start"?"active":"completed";screen.humanTakeover=input.action==="start";}
      emit("channel.message.updated",message.channelId);return response({accepted:true,message});
    }
    const functional = await functionality.handle(path,method,input,url,snapshot.bots);
    if (functional) return functional;
    if (path === "/api/v0/client-bootstrap") return response(bootstrap());
    if (path === "/api/v0/client-snapshot") return response({ ...snapshot, cursor: String(sequence) });
    if (path === "/api/v0/client-runtime") return response({ runtime: snapshot.runtime });
    if (path === "/api/v0/system/version") return response({ releaseVersion: "0.0.1", apiProtocolVersion: 1, minimumClientVersion: "0.0.1", maximumClientVersionExclusive: "1.0.0", recommendedClientVersion: "0.0.1", updateChannel: "beta" });
    if (path === "/api/v0/settings") return response({ settings: { sidebarPreferences: settings }, valid: true });
    if (path === "/api/v0/settings/sidebar") { settings = input; emit("settings.updated"); return response(settings); }
    if (path === "/api/v0/events/poll") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!events.some(e => Number(e.sequence) > after) && Number(url.searchParams.get("waitMs")) > 0) {
        await new Promise<void>(resolve => { const wake = () => { clearTimeout(timeout); resolve(); }; const timeout = setTimeout(() => { wakeups.delete(wake); resolve(); }, 2000); wakeups.add(wake); });
      }
      return response({ events: events.filter(e => Number(e.sequence) > after) });
    }
    if (path.endsWith("/history")) {
      const channelId = path.split("/")[4]; const before = url.searchParams.get("before");
      const messages = snapshot.channelMessages.filter(m => m.channelId === channelId && (!before || Number(m.sequence) < Number(before)));
      const page = pagedHistory ? messages.slice(-60) : messages;
      return response({ channelId, messages: page, threadContext: [], threadContextTruncated: false, beforeSequence: page[0]?.sequence ?? null, hasMore: pagedHistory && messages.length > page.length, revision: String(sequence) });
    }
    if (path.endsWith("/client-state")) return response({ channelId: path.split("/")[4], revision: String(sequence), channelRounds: [], runs: snapshot.runs, runItems: [], approvals: snapshot.approvals, subagents: [], truncated: { channelRounds:false, runs:false, runItems:false, approvals:false, subagents:false } });
    if (path.includes("/message-deliveries/")) {
      const message = deliveries.get(path.split("/").at(-1)!);
      return response({ clientId: path.split("/").at(-1), status: message ? "accepted" : "not_found", message: message ?? null, acceptedAtMs: message ? Date.now() : null });
    }
    if (path.endsWith("/messages") && method === "POST") {
      let message = deliveries.get(input.clientId);
      if (!message) {
        const owner = path.split("/")[4];
        const channelId = path.includes("/conversations/") ? snapshot.bots.find(b => b.conversationId === owner)?.dmChannelId : owner;
        if (!channelId) return response({ error: { message: "Unknown conversation" } }, 404);
        message = { id: randomUUID(), clientId: input.clientId, sequence: String(++sequence), channelId, sender:"user", senderBotId: null, sourceRunId: null, content: input.content,
          metadata: { attachments: input.attachments ?? [], ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}), ...(input.isFork ? { branched: true } : {}) }, createdAt: new Date().toISOString() };
        deliveries.set(input.clientId, message); snapshot.channelMessages.push(message); emit("channel.message.created", channelId);
      }
      if (dropNextSend) { dropNextSend = false; return response({ error: { message: "Simulated lost acknowledgment after durable acceptance" } }, 503); }
      return response({ message });
    }
    if (path.endsWith("/read")) {const channel=snapshot.channels.find(c=>c.id===path.split("/")[4]);if(channel){channel.unreadCount=0;channel.notificationState={...channel.notificationState,lastReadSequence:input.throughSequence} as any;}return response({ channelId: path.split("/")[4], lastReadSequence: input.throughSequence ?? "0", unreadCount: 0 });}
    if (path === "/api/v0/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return response({ query: q, results: snapshot.channelMessages.filter(m => m.content.toLowerCase().includes(q)).map(m => ({ id:m.id, kind:"message", title: snapshot.channels.find(c => c.id === m.channelId)?.name, subtitle:m.content, channelId:m.channelId, messageId:m.id, botId:m.senderBotId, url:null, createdAt:m.createdAt })) });
    }
    if (path.endsWith("/context")) {
      const message = snapshot.channelMessages.find(m => m.id === path.split("/")[4]);
      if (!message) return response({ error: { message: "Message not found" } },404);
      const messages = snapshot.channelMessages.filter(m => m.channelId === message.channelId);
      return response({ channelId:message.channelId, targetMessageId:message.id, messages, threadContext:[], threadContextTruncated:false, beforeSequence:messages[0]?.sequence, afterSequence:messages.at(-1)?.sequence, hasMoreBefore:false, hasMoreAfter:false, revision:String(sequence) });
    }
    if (path.endsWith("/reaction")) {
      const message = snapshot.channelMessages.find(m => m.id === path.split("/")[4])!;
      message.metadata = { ...(message.metadata as object), reactions: [{ by: "me", emoji: input.emoji }] }; emit("channel.message.updated", message.channelId); return response({ message, messageId: message.id, emoji:input.emoji, reacted:true, removed:false, runId:null });
    }
    if (path.includes("/approvals/") && path.endsWith("/resolve")) { const approval = snapshot.approvals.find(a => a.id === path.split("/")[4])!; approval.status = input.decision === "decline" ? "declined" : "accepted"; snapshot.runs = []; emit("approval.resolved"); return response({ status:approval.status }); }
    if (path === "/api/v0/bots" && method === "POST") {
      const id = randomUUID(), now = new Date().toISOString();
      const bot = { ...snapshot.bots[0], id, name:input.name, title:input.name, description:input.description ?? "", instructions:input.instructions ?? "", color:input.color ?? "#FD6A3A", icon:input.icon ?? "hexagon", conversationId:"conversation-"+id, dmChannelId:"channel-"+id, createdAt:now, updatedAt:now };
      snapshot.bots.push(bot); snapshot.channels.push({ ...snapshot.channels[0], id:bot.dmChannelId, name:bot.name, directKey:id, members:[{botId:id,ordinal:0}], createdAt:now, updatedAt:now }); emit("bot.created"); return response(bot);
    }
    if (path === "/api/v0/channels" && method === "POST") {
      const channel = { ...snapshot.channels[0], id:randomUUID(), kind:"group" as const, name:input.name, directKey:null, members:input.botIds.map((botId:string,ordinal:number)=>({botId,ordinal})) };
      snapshot.channels.push(channel); emit("channel.created"); return response(channel);
    }
    if (path.match(/^\/api\/v0\/bots\/[^/]+$/) && method === "PATCH") {
      const bot = snapshot.bots.find(b => b.id === path.split("/")[4])!; Object.assign(bot,input);
      if(input.icon || input.color) bot.hasAvatar=false;
      const channel = snapshot.channels.find(c=>c.id === bot.dmChannelId)!; channel.name = bot.name; emit("bot.updated"); return response(bot);
    }
    if (path.endsWith("/routines") && method === "GET") return response(routines);
    if (path.endsWith("/routines") && method === "POST") {
      if(!input.schedule?.trim()) return response({message:"A schedule is required."},400);
      const routine = { id:randomUUID(), ...input, scheduleKind:"cron", timezone:"America/New_York", revision:1, nextRunAt:null, latestExecution:null };
      routines.push(routine); emit("routine.created"); return response(routine);
    }
    if (path.includes("/routines/") && path.endsWith("/executions")) return response(routineExecutions);
    if (path.match(/^\/api\/v0\/routines\/[^/]+(?:\/(?:pause|resume|test))?$/)) {
      const id=path.split("/")[4], routine=routines.find(r=>r.id===id);
      if(!routine)return response({message:"Routine not found"},404);
      if(path.endsWith("/test")){
        const prior = routineExecutions.find(e=>e.routineId===id && e.clientId===input.clientId);
        if(prior)return response(prior);
        const execution={id:randomUUID(),routineId:id,clientId:input.clientId,status:"completed",createdAt:new Date().toISOString()};
        routineExecutions.push(execution);
        if(dropNextRoutineRun){dropNextRoutineRun=false;return response({message:"Simulated lost response after starting the routine"},503);}
        return response(execution);
      }
      if(input.expectedRevision!==routine.revision)return response({message:"This routine changed on another device. Reload the latest version."},409);
      if(method==="DELETE")routines=routines.filter(r=>r.id!==id);
      else {Object.assign(routine,input);routine.revision++;if(path.endsWith("/pause"))routine.enabled=false;if(path.endsWith("/resume"))routine.enabled=true;}
      emit("routine.updated");return response(routine);
    }
    if (path === "/api/v0/plugins") return response({ catalog: [], installs: [], policies: [], activity: [], botCount:snapshot.bots.length });
    if (path === "/api/v0/plugin-management") return response({ sources:[], drafts:[], skills:[] });
    if (path.startsWith("/api/v0/plugins/composer")) return response({ items:[] });
    if (path.includes("/memories")) {
      if(method==="DELETE")memories=path.endsWith("/memories")?[]:memories.filter(m=>m.id!==path.split("/").at(-1));
      return response({ botId:path.split("/")[4], memories, total:memories.length, limit:1000 });
    }
    if(path.endsWith("/profile")&&method==="PATCH") { const channel=snapshot.channels.find(c=>c.id===path.split("/")[4]);Object.assign(channel??{},input);emit("channel.updated");return response(channel); }
    if(path.endsWith("/members")&&method==="PUT") {const channel=snapshot.channels.find(c=>c.id===path.split("/")[4])!;channel.members=input.botIds.map((botId:string,ordinal:number)=>({botId,ordinal}));emit("channel.updated");return response(channel);}
    if(path.endsWith("/hidden")&&method==="PATCH") {const channel=snapshot.channels.find(c=>c.id===path.split("/")[4])!;channel.hiddenFromSidebar=input.hidden;emit("channel.updated");return response(channel);}
    if(path.match(/^\/api\/v0\/(?:bots|channels)\/[^/]+$/)&&method==="DELETE") {const id=path.split("/")[4];const bot=snapshot.bots.find(b=>b.id===id);snapshot.bots=snapshot.bots.filter(b=>b.id!==id);snapshot.channels=snapshot.channels.filter(c=>c.id!==id&&c.id!==bot?.dmChannelId);emit("channel.deleted");return response({ok:true});}
    if (path.match(/^\/api\/v0\/runs\/[^/]+\/cancel$/)) { snapshot.runs = []; emit("run.updated"); return response({ ok:true }); }
    if (path === "/api/v0/bots") return response(snapshot.bots);
    if (path === "/api/v0/groups") return response(snapshot.channels.filter(c=>c.kind === "group"));
    return response({ error: { code:"not_implemented_in_fixture", message:`Fixture does not implement ${method} ${path}` } },404);
  }
});
console.log(`Swift/RN parity fixture listening on http://127.0.0.1:${server.port}`);
