/** Isolated audit projections. No production services or personal data are modified. */
const upstream = "http://127.0.0.1:20011";
let scene = "thread";
let revision = 1000;
let linkVisits = 0;
let approval: any;
let policy = {isEnabled:true,allowInstructions:["Read public documentation"],blockInstructions:["Delete account data"]};
const resetApproval = () => ({id:"qa-chrome",runId:"qa-run",kind:"tool",status:"pending",ownerConversationId:"channel-research",details:{title:"Chrome site access",type:"nativeCapability",presentation:{kind:"cookie-import",items:[
 {profileId:"Profile 1",profileDisplayName:"Personal",origin:"example.com"},
 {profileId:"Profile 2",profileDisplayName:"Work",origin:"example.com"},
 {profileId:"Profile 2",profileDisplayName:"Work",origin:"docs.example.com"},
]}}});
const threadMessages = [
  { id: "audit-root", sequence: "401", channelId: "channel-research", sender: "bot", senderBotId: "bot-research", sourceRunId: null, content: "QA thread root", metadata: { type: "text" }, createdAt: "2026-09-16T12:00:00Z" },
  { id: "audit-reply", sequence: "402", channelId: "channel-research", sender: "bot", senderBotId: "bot-research", sourceRunId: null, content: "QA hidden thread reply", metadata: { type: "text", branched: true, replyTo: "audit-root" }, createdAt: "2026-09-16T12:00:01Z" },
];
const server = Bun.serve({ hostname: "127.0.0.1", port: 20010, idleTimeout: 40, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__audit/reset") {
    scene = ((await request.json()) as any).scene ?? "thread";
    approval = resetApproval(); revision = 1000; linkVisits = 0;
    policy = {isEnabled:true,allowInstructions:["Read public documentation"],blockInstructions:["Delete account data"]};
    await fetch(upstream + "/__qa/reset", { method: "POST" });
    await fetch(upstream + "/__qa/content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: ["attachment", "markdown"].includes(scene) ? scene : "empty" }) });
    return Response.json({ scene });
  }
  if (url.pathname === "/__audit/receipt") return Response.json({approval,policy,linkVisits});
  if (url.pathname === "/__audit/link-destination") { linkVisits++; return new Response("<title>QA link destination</title><p>Isolated search destination</p>", {headers:{"content-type":"text/html"}}); }
  if (url.pathname === "/__audit/action-state") { approval.details.actionState = ((await request.json()) as any).state; revision++; return Response.json({ok:true}); }
  if (url.pathname === "/api/v0/server-settings/auto-review") {
    if (request.method === "PATCH") policy = await request.json() as any;
    return Response.json(policy);
  }
  if (scene === "approval") {
    if (url.pathname === "/api/v0/client-bootstrap") {
      const body = await (await fetch(upstream + url.pathname)).json() as any;
      return Response.json({...body,cursor:String(revision),pendingApprovals:approval.status === "pending" ? [approval] : []});
    }
    if (url.pathname === "/api/v0/events/poll") {
      await Bun.sleep(250);
      return Response.json({events: Number(url.searchParams.get("after")) < revision ? [{sequence:String(revision),topic:"approval.updated",payload:{}}] : []});
    }
    if (url.pathname.endsWith("/client-state")) return Response.json({channelId:"channel-research",revision:String(revision),runs:[],approvals:[approval]});
    if (url.pathname === "/api/v0/approvals/qa-chrome/resolve") {
      const input = await request.json() as any;
      const offered = new Set(approval.details.presentation.items.map((x:any) => JSON.stringify([x.profileId,x.origin])));
      if (input.decision === "accept" && (!input.selectedItems?.length || input.selectedItems.some((x:string)=>!offered.has(x)))) return Response.json({message:"Invalid selected sites"},{status:400});
      approval.status = input.decision === "decline" ? "declined" : "accepted";
      approval.details.selectedItems = input.selectedItems;
      approval.details.actionState = "running"; revision++;
      return Response.json({status:approval.status});
    }
  }
  if (["thread", "routine-search", "link-search"].includes(scene)) {
    if (url.pathname === "/api/v0/bots/bot-research/routines") return Response.json([{id:"audit-routine",name:"QA search routine",prompt:"Review the QA report",schedule:"0 9 * * 1-5",scheduleKind:"cron",timezone:"UTC",enabled:false,revision:1}]);
    if (url.pathname.endsWith("/history")) return Response.json({ channelId: "channel-research", messages: threadMessages, threadContext: [], threadContextTruncated: false, beforeSequence: "401", hasMore: false, revision: "402" });
    if (url.pathname.endsWith("/context")) return Response.json({ channelId: "channel-research", targetMessageId: "audit-reply", messages: threadMessages, threadContext: [], threadContextTruncated: false });
    if (url.pathname === "/api/v0/search") return Response.json({ results: [{ id: scene === "routine-search" ? "routine:audit-routine" : "audit-reply", kind: scene === "routine-search" ? "routine" : scene === "link-search" ? "link" : "message", title: "QA search result", subtitle: "QA hidden thread reply", channelId: "channel-research", messageId: scene === "routine-search" ? null : "audit-reply", botId: "bot-research", url: scene === "link-search" ? "http://127.0.0.1:20010/__audit/link-destination" : null }] });
  }
  const response = await fetch(upstream + url.pathname + url.search, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  if (url.pathname === "/api/v0/client-bootstrap" && response.ok && ["thread", "routine-search", "link-search"].includes(scene)) {
    const body = await response.json() as any;
    body.latestMessages = threadMessages;
    return Response.json(body);
  }
  return response;
}});
console.log(`Native audit proxy on http://127.0.0.1:${server.port}`);
