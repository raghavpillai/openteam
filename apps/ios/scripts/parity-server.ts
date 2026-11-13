/** Loopback-only, in-memory contract fixture for the Swift UI/system tests and manual simulator QA.
 * Never use this harness as a product server. No model, external messages, or real accounts run here.
 * Unimplemented routes answer 404 `not_implemented_in_fixture`.
 */
import { CLIENT_CAPABILITIES } from "../../../packages/contracts/src/capabilities";
import { mobileFixture } from "./fixtures/snapshot";
import type { ChannelMessageView, ClientBootstrapView, ClientSnapshot } from "../../../packages/contracts/src/index";
import { randomUUID } from "node:crypto";
import { validateFixtureRequest } from "./validate-fixture-request";
import { ServerSetupFixture } from "./server-setup-fixture";

const port = Number(process.env.SWIFT_PARITY_PORT || 19997);
let snapshot: ClientSnapshot;
let hapticAudit: unknown[] = [];
let settings: any;
let events: any[];
let sequence = 14;
let offline = false;
let dropNextSend = false;
// Delays delivery lookups after a lost send acknowledgement.
let deliveryDelayMs = 0;
let authRequired = false;
let pagedHistory = false;
let failures: Record<string, {status?: number; message?: string; count?: number; delayMs?: number; body?: unknown}> = {};
let serverSetup = new ServerSetupFixture();
let contentReceipts: any[] = [];
const screen = { state: "ready", width: 1280, height: 800, humanTakeover: false, controlSession: null, apps: ["chromium", "thunar", "terminal"] };
const serverRelease = { releaseVersion: "0.0.0", apiProtocolVersion: 1, minimumClientVersion: "0.0.0", maximumClientVersionExclusive: "1.0.0", recommendedClientVersion: "0.0.0", updateChannel: "beta" };
const deliveries = new Map<string, ChannelMessageView>();
const uploadedAssets = new Map<string, { data: Uint8Array; mimeType: string }>();
const wakeups = new Set<() => void>();
const requestLog: Array<{ method: string; path: string; query?: string; clientId?: string }> = [];
const emptySidebar = () => ({ version: 2, pinnedIds: [], unreadIds: [], unassignedCollapsed: false, sections: [], sectionByChannel: {}, channelOrderByGroup: {} });
function reset() {
  uploadedAssets.clear();
  snapshot = structuredClone(mobileFixture);
  snapshot.runtime.transcription = "configured";
  sequence = 14; events = []; deliveries.clear(); offline = false; dropNextSend = false; authRequired = false;
  deliveryDelayMs = 0; pagedHistory = false; requestLog.length = 0; failures = {}; contentReceipts = [];
  serverSetup = new ServerSetupFixture();
  settings = emptySidebar();
}
reset();
/** "history-pages": one read Bot chat (`visual-chat`) with 180 alternating messages, served 60 at a time.
 * "attachment": the Research chat holds one private image message.
 * "spreadsheet": the Research chat holds a user question and a CSV attachment. */
function scene(name: string) {
  if (name === "history-pages") {
    const bot = { ...mobileFixture.bots[0]!, id: "bot-visual-chat", name: "New Bot", title: "New Bot", color: "#FF6600", icon: "chip", description: "", conversationId: "conversation-visual-chat", dmChannelId: "visual-chat" };
    const channel = { ...mobileFixture.channels[0]!, id: "visual-chat", name: "New Bot", directKey: bot.id, members: [{ botId: bot.id, ordinal: 0 }], unreadCount: 0,
      notificationState: { lastReadSequence: "999", lastReadNotificationSequence: "0", notificationCursor: "0", notifications: [], activityUnreadCount: 0 } } as any;
    const start = new Date(); start.setHours(22, 45, 0, 0);
    snapshot.bots = [bot]; snapshot.channels = [channel]; snapshot.runs = [];
    snapshot.channelMessages = Array.from({ length: 180 }, (_, index) => {
      const i = index + 1, sender = i % 2 ? "user" : "agent";
      return { id: `visual-message-visual-chat-${i}`, clientId: null, sequence: String(i), channelId: "visual-chat", sender, senderBotId: sender === "agent" ? bot.id : null,
        sourceRunId: null, content: `Page message ${i}`, metadata: { type: "text" }, createdAt: new Date(start.getTime() + i * 1000).toISOString() } as any;
    });
    pagedHistory = true; sequence = 180;
  } else if (name === "attachment") {
    snapshot.runs = [];
    snapshot.channelMessages = snapshot.channelMessages.filter(m => m.channelId !== "channel-research");
    snapshot.channelMessages.push({ id: "content-fixture", sequence: "400", channelId: "channel-research", sender: "bot", senderBotId: "bot-research", sourceRunId: null, content: "", createdAt: "2026-09-16T12:00:00.000Z",
      metadata: { attachments: [{ assetId: "private-fixture-image", fileName: "Fixture image.png", mimeType: "image/png", byteSize: 6000, kind: "image" }] } } as any);
    sequence = 400;
  } else if (name === "spreadsheet") {
    const user = { channelId: "channel-research", sender: "user", senderBotId: null, sourceRunId: null, content: "", createdAt: "2026-09-16T12:00:00.000Z", metadata: {} };
    snapshot.channelMessages = snapshot.channelMessages.filter(m => m.channelId !== "channel-research");
    snapshot.channelMessages.push(
      { ...user, id: "sheet-question", sequence: "401", content: "What changed in these transactions?" } as any,
      { ...user, id: "sheet-file", sequence: "402", metadata: { attachments: [{ assetId: "sheet-transactions", fileName: "Transactions.csv", mimeType: "text/csv", byteSize: 1450, kind: "file" }] } } as any);
    sequence = 402;
  } else throw new Error(`Unknown scene: ${name}`);
}
function emit(topic = "channel.message.created", entityId: string | null = null) {
  events.push({ sequence: String(++sequence), topic, entityId, payload: {}, createdAt: new Date().toISOString() });
  for (const wake of wakeups) wake(); wakeups.clear();
}
function bootstrap(): ClientBootstrapView {
  return { cursor: String(sequence), workspace: snapshot.workspace, bots: snapshot.bots, channels: snapshot.channels,
    latestMessages: pagedHistory ? snapshot.channelMessages.slice(-60) : snapshot.channelMessages, activeRuns: snapshot.runs,
    channelRounds: [], subagents: snapshot.subagents, runtime: snapshot.runtime, capabilities: CLIENT_CAPABILITIES };
}
const response = (data: unknown, status = 200) => Response.json(data, { status });
const fixturePNG = () => new Response(Bun.file(new URL("./fixtures/attachment.png", import.meta.url)), { headers: { "Content-Type": "image/png" } });
const server = Bun.serve({
  hostname: "127.0.0.1", port, idleTimeout: 40,
  async fetch(request) {
    const url = new URL(request.url), path = decodeURIComponent(url.pathname), method = request.method;
    let input: any = {};
    const upload = path === "/api/v0/assets" && method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
    if (!upload && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { input = await request.json(); } catch {} }
    if (path === "/__qa/reset" && method === "POST") { reset(); emit("snapshot.reset"); return response({ ok: true }); }
    if (path === "/__qa/scene" && method === "POST") { reset(); scene(input.scene); emit("snapshot.reset"); return response({ ok: true }); }
    if (path === "/__qa/update-message" && method === "POST") {
      // Server-side edits of an existing row: reactions, card answers or content.
      const message: any = snapshot.channelMessages.find(m => m.id === input.id);
      if (!message) return response({ error: "Unknown message" }, 404);
      if (typeof input.content === "string") message.content = input.content;
      if (input.metadata) message.metadata = { ...message.metadata, ...input.metadata };
      emit("channel.message.updated", message.channelId); return response({ ok: true });
    }
    if (path === "/__qa/control" && method === "POST") {
      if (input.onboarding) {
        snapshot.bots = []; snapshot.channels = []; snapshot.runs = []; snapshot.channelMessages = [];
        snapshot.runtime.transcription = "missing";
      }
      offline = input.offline ?? offline; dropNextSend = input.dropNextSend ?? dropNextSend; authRequired = input.authRequired ?? authRequired;
      deliveryDelayMs = input.deliveryDelayMs ?? deliveryDelayMs;
      if (input.failures) failures = input.failures;
      emit("snapshot.reset"); return response({ ok: true });
    }
    if (path === "/__qa/state") return response({ messages: snapshot.channelMessages, requests: requestLog, contentReceipts, settings, bots: snapshot.bots, channels: snapshot.channels,
      transcription: serverSetup.voice, modelSettings: { inference: serverSetup.inference, saves: serverSetup.saves, tests: serverSetup.tests } });
    if (path === "/__qa/haptics") {
      if (method === "POST") hapticAudit.push(input);
      if (method === "DELETE") hapticAudit = [];
      return response(hapticAudit);
    }
    if (path === "/health") return response({ status: "ready", purpose: "swift-parity-fixture" });
    if (offline) return response({ error: { message: "Fixture offline", code: "offline" } }, 503);
    // Count attempts before injected latency/failures, including canceled searches.
    if (path.startsWith("/api/v0/")) requestLog.push({ method, path, query: url.search,
      ...(input.clientId ? { clientId: input.clientId } : {}) });
    const failure = failures[`${method} ${path}`] ?? Object.entries(failures).find(
      ([key]) => key.endsWith("/*") && `${method} ${path}`.startsWith(key.slice(0, -1))
    )?.[1];
    if (failure && (failure.count ?? 1) > 0) {
      failure.count = (failure.count ?? 1) - 1;
      if (failure.delayMs) await Bun.sleep(failure.delayMs);
      if (failure.status) return response(failure.body ?? (failure.message ? { message: failure.message } : {}), failure.status);
    }
    if (path === "/api/auth/config") return response({ mode: authRequired ? "required" : "disabled" });
    if (path === "/api/auth/login") {
      if (input.username !== "fixture" || input.password !== "fixture-only") return response({ message: "Incorrect username or password" }, 401);
      return Response.json({ user: { id: "fixture-owner", name: "Fixture owner", username: "fixture", email: "fixture@example.invalid", image: null } }, { headers: { "set-auth-token": "fixture-token-not-a-real-credential" } });
    }
    if (authRequired && request.headers.get("authorization") !== "Bearer fixture-token-not-a-real-credential") return response({ message: "Session expired" }, 401);
    if (path === "/api/auth/sign-out") return response({ success: true });
    if (path === "/api/auth/get-session") return response({ session: { id: "fixture" }, user: { id: "fixture-owner", name: "Fixture owner", username: "fixture", email: "fixture@example.invalid" } });
    const invalid = validateFixtureRequest(path, method, input); if (invalid) return response({ message: invalid }, 400);
    if (upload) {
      const assetId = new Bun.CryptoHasher("sha256").update(upload).digest("hex");
      const fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "File");
      const mimeType = request.headers.get("content-type") ?? "application/octet-stream";
      uploadedAssets.set(assetId, { data: upload, mimeType });
      contentReceipts.push({ path, fileName, mimeType, byteSize: upload.byteLength, authenticated: request.headers.has("authorization") });
      return response({ assetId, fileName, mimeType, byteSize: upload.byteLength,
        kind: mimeType.startsWith("image/") ? "image" : "file" });
    }
    const setupResponse = serverSetup.handle(path, method, input, url);
    if (setupResponse) return setupResponse;
    if (path === "/api/v0/transcriptions" && method === "POST") return response({ text: "Native voice QA transcription" });
    if (path.endsWith("/screen")) return response(screen);
    if (path.endsWith("/avatar")) return fixturePNG();
    if (path.endsWith("/screen/frame")) return new Response(Bun.file(new URL("./fixtures/computer.png", import.meta.url)), { headers: { "Content-Type": "image/png" } });
    if (path.startsWith("/api/v0/assets/")) {
      contentReceipts.push({ path, authenticated: request.headers.has("authorization") });
      const uploaded = uploadedAssets.get(path.split("/").at(-1)!);
      if (path.endsWith("/sheet-transactions")) return new Response(Bun.file(new URL("./fixtures/transactions.csv", import.meta.url)), { headers: { "Content-Type": "text/csv" } });
      return uploaded ? new Response(uploaded.data, { headers: { "Content-Type": uploaded.mimeType } }) : fixturePNG();
    }
    if (path === "/api/v0/system/version") return response(serverRelease);
    if (path === "/api/v0/client-bootstrap") return response(bootstrap());
    if (path === "/api/v0/client-snapshot") return response({ ...snapshot, cursor: String(sequence) });
    if (path === "/api/v0/client-runtime") return response({ runtime: snapshot.runtime });
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
    if (path.endsWith("/client-state")) return response({ channelId: path.split("/")[4], revision: String(sequence), channelRounds: [], runs: snapshot.runs, runItems: [], subagents: snapshot.subagents.filter(task => task.parentChannelId === path.split("/")[4]), truncated: { channelRounds: false, runs: false, runItems: false, subagents: false } });
    if (path.includes("/message-deliveries/")) {
      if (deliveryDelayMs) await Bun.sleep(deliveryDelayMs);
      const message = deliveries.get(path.split("/").at(-1)!);
      return response({ clientId: path.split("/").at(-1), status: message ? "accepted" : "not_found", message: message ?? null, acceptedAtMs: message ? Date.now() : null });
    }
    if (path.endsWith("/messages") && method === "POST") {
      let message = deliveries.get(input.clientId);
      if (!message) {
        const owner = path.split("/")[4];
        const channelId = path.includes("/conversations/") ? snapshot.bots.find(b => b.conversationId === owner)?.dmChannelId : owner;
        if (!channelId) return response({ error: { message: "Unknown conversation" } }, 404);
        message = { id: randomUUID(), clientId: input.clientId, sequence: String(++sequence), channelId, sender: "user", senderBotId: null, sourceRunId: null, content: input.content,
          metadata: { attachments: input.attachments ?? [], ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}), ...(input.isFork ? { branched: true } : {}) }, createdAt: new Date().toISOString() };
        deliveries.set(input.clientId, message); snapshot.channelMessages.push(message); emit("channel.message.created", channelId);
      }
      if (dropNextSend) { dropNextSend = false; return response({ error: { message: "Simulated lost acknowledgment after durable acceptance" } }, 503); }
      return response({ message });
    }
    if (path.endsWith("/read")) {
      const channel = snapshot.channels.find(c => c.id === path.split("/")[4]);
      if (channel) { channel.unreadCount = 0; channel.notificationState = { channelId: channel.id, lastReadNotificationSequence: "0", notificationCursor: "0", notifications: [], activityUnreadCount: 0, ...channel.notificationState, lastReadSequence: input.throughSequence ?? "0" } as any; }
      return response({ channelId: path.split("/")[4], lastReadSequence: input.throughSequence ?? "0", unreadCount: 0 });
    }
    if (path === "/api/v0/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return response({ query: q, results: snapshot.channelMessages.filter(m => m.content.toLowerCase().includes(q)).map(m => ({ id: m.id, kind: "message", title: snapshot.channels.find(c => c.id === m.channelId)?.name, subtitle: m.content, channelId: m.channelId, messageId: m.id, botId: m.senderBotId, url: null, createdAt: m.createdAt })) });
    }
    if (path.endsWith("/context")) {
      const message = snapshot.channelMessages.find(m => m.id === path.split("/")[4]);
      if (!message) return response({ error: { message: "Message not found" } }, 404);
      const history = snapshot.channelMessages.filter(m => m.channelId === message.channelId);
      const index = history.findIndex(m => m.id === message.id), limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 60)));
      const direction = url.searchParams.get("direction");
      const start = direction === "after" ? index + 1 : direction === "before" ? Math.max(0, index - limit) : Math.max(0, index - 20);
      const end = direction === "before" ? index : direction === "after" ? Math.min(history.length, start + limit) : Math.min(history.length, index + 21);
      const messages = history.slice(start, end);
      return response({ channelId: message.channelId, targetMessageId: message.id, messages, threadContext: [], threadContextTruncated: false, beforeSequence: messages[0]?.sequence ?? null, afterSequence: messages.at(-1)?.sequence ?? null, hasMoreBefore: start > 0, hasMoreAfter: end < history.length, revision: String(sequence) });
    }
    if (path.endsWith("/reaction")) {
      const message = snapshot.channelMessages.find(m => m.id === path.split("/")[4])!;
      const previous = ((message.metadata as any).reactions ?? []) as Array<{ emoji: string; by: string }>;
      const own = previous.some(r => r.emoji === input.emoji && r.by === "me");
      const reactions = own ? previous.filter(r => !(r.emoji === input.emoji && r.by === "me")) : [...previous, { by: "me", emoji: input.emoji }];
      message.metadata = { ...(message.metadata as object), reactions }; emit("channel.message.updated", message.channelId); return response({ message, messageId: message.id, emoji: input.emoji, reacted: !own, removed: own, runId: null });
    }
    if (path === "/api/v0/bots" && method === "POST") {
      const id = randomUUID(), now = new Date().toISOString();
      // First-run setup has no existing bot/channel to use as a complete template.
      const bot = { ...mobileFixture.bots[0]!, id, name: input.name, title: input.title ?? "", description: input.description ?? "", color: input.color ?? "#FD6A3A", icon: input.icon ?? "hexagon", conversationId: "conversation-" + id, dmChannelId: "channel-" + id, createdAt: now, updatedAt: now };
      snapshot.bots.push(bot); snapshot.channels.push({ ...mobileFixture.channels[0]!, id: bot.dmChannelId, name: bot.name, directKey: id, members: [{ botId: id, ordinal: 0 }], createdAt: now, updatedAt: now }); emit("bot.created"); return response(bot);
    }
    if (path === "/api/v0/channels" && method === "POST") {
      const channel = { ...snapshot.channels[0]!, id: randomUUID(), kind: "group" as const, name: input.name, directKey: null, members: input.botIds.map((botId: string, ordinal: number) => ({ botId, ordinal })) };
      snapshot.channels.push(channel); emit("channel.created"); return response(channel);
    }
    if (path.match(/^\/api\/v0\/bots\/[^/]+$/) && method === "PATCH") {
      const bot = snapshot.bots.find(b => b.id === path.split("/")[4])!; Object.assign(bot, input);
      if (input.icon || input.color) bot.hasAvatar = false;
      snapshot.channels.find(c => c.id === bot.dmChannelId)!.name = bot.name; emit("bot.updated"); return response(bot);
    }
    if (path === "/api/v0/plugins") return response({ catalog: [], installs: [], activity: [], botCount: snapshot.bots.length });
    if (path === "/api/v0/plugin-management") return response({ sources: [], drafts: [], skills: [] });
    if (path.startsWith("/api/v0/plugins/composer")) return response({ items: [] });
    const channel = snapshot.channels.find(c => c.id === path.split("/")[4]);
    if (path.endsWith("/profile") && method === "PATCH") { Object.assign(channel ?? {}, input); emit("channel.updated"); return response(channel); }
    if (path.endsWith("/members") && method === "PUT") { channel!.members = input.botIds.map((botId: string, ordinal: number) => ({ botId, ordinal })); emit("channel.updated"); return response(channel); }
    if (path.endsWith("/hidden") && method === "PATCH") { channel!.hiddenFromSidebar = input.hidden; emit("channel.updated"); return response(channel); }
    if (path.match(/^\/api\/v0\/(?:bots|channels)\/[^/]+$/) && method === "DELETE") { const id = path.split("/")[4]; const bot = snapshot.bots.find(b => b.id === id); snapshot.bots = snapshot.bots.filter(b => b.id !== id); snapshot.channels = snapshot.channels.filter(c => c.id !== id && c.id !== bot?.dmChannelId); emit("channel.deleted"); return response({ ok: true }); }
    if (path.match(/^\/api\/v0\/runs\/[^/]+\/cancel$/)) { snapshot.runs = []; emit("run.updated"); return response({ ok: true }); }
    if (path === "/api/v0/bots") return response(snapshot.bots);
    if (path === "/api/v0/groups") return response(snapshot.channels.filter(c => c.kind === "group"));
    return response({ error: { code: "not_implemented_in_fixture", message: `Fixture does not implement ${method} ${path}` } }, 404);
  }
});
console.log(`Swift parity fixture listening on http://127.0.0.1:${server.port}`);
