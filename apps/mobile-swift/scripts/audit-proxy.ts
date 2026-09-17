/** Isolated audit projections. No production services or personal data are modified. */
const upstream = "http://127.0.0.1:20011";
let scene = "thread";
const threadMessages = [
  { id: "audit-root", sequence: "401", channelId: "channel-research", sender: "bot", senderBotId: "bot-research", sourceRunId: null, content: "QA thread root", metadata: { type: "text" }, createdAt: "2026-09-16T12:00:00Z" },
  { id: "audit-reply", sequence: "402", channelId: "channel-research", sender: "bot", senderBotId: "bot-research", sourceRunId: null, content: "QA hidden thread reply", metadata: { type: "text", branched: true, replyTo: "audit-root" }, createdAt: "2026-09-16T12:00:01Z" },
];
const server = Bun.serve({ hostname: "127.0.0.1", port: 20010, idleTimeout: 40, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__audit/reset") {
    scene = ((await request.json()) as any).scene ?? "thread";
    await fetch(upstream + "/__qa/reset", { method: "POST" });
    await fetch(upstream + "/__qa/content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: ["attachment", "markdown"].includes(scene) ? scene : "empty" }) });
    return Response.json({ scene });
  }
  if (["thread", "routine-search", "link-search"].includes(scene)) {
    if (url.pathname.endsWith("/history")) return Response.json({ channelId: "channel-research", messages: threadMessages, threadContext: [], threadContextTruncated: false, beforeSequence: "401", hasMore: false, revision: "402" });
    if (url.pathname.endsWith("/context")) return Response.json({ channelId: "channel-research", targetMessageId: "audit-reply", messages: threadMessages, threadContext: [], threadContextTruncated: false });
    if (url.pathname === "/api/v0/search") return Response.json({ results: [{ id: scene === "routine-search" ? "routine:audit-routine" : "audit-reply", kind: scene === "routine-search" ? "routine" : scene === "link-search" ? "link" : "message", title: "QA search result", subtitle: "QA hidden thread reply", channelId: "channel-research", messageId: scene === "routine-search" ? null : "audit-reply", botId: "bot-research", url: scene === "link-search" ? "https://example.invalid/audit" : null }] });
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
