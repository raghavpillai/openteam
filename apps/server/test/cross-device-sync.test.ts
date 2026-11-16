import { expect, test } from "bun:test";
import type { ChannelClientState, ChannelHistoryPage, ChannelMessageView, ClientBootstrapView, ProductEvent } from "@openteam/contracts";
import { CommittedEventCursor, createLiveSyncController, createOpenTeamClient, shouldRefreshForEvent, synchronizeClientSnapshot } from "../../../packages/client-core/src";
import { type EventStreamSource, eventPoll, eventStream } from "../src/event-stream";

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

// Real loopback HTTP and production SSE/poll implementations, without inference or a real account.
const fixture = () => {
  const messages: ChannelMessageView[] = [], events: ProductEvent[] = [];
  const wakeups = new Set<() => void>(), connections = new Set<AbortController>();
  const source: EventStreamSource = {
    get eventVersion() { return events.length; },
    eventWindowAfter: async (after, limit) => ({
      oldest: events.length ? 1n : null, latest: events.length ? BigInt(events.length) : null, cursorExpired: false, cursorAhead: false,
      events: events.filter((event) => BigInt(event.sequence) > after).slice(0, limit),
    }),
    waitForEvent: async (version, timeout, signal) => {
      if (version !== events.length || signal?.aborted) return events.length;
      return new Promise<number>((resolve) => {
        const finish = () => { clearTimeout(timer); wakeups.delete(finish); signal?.removeEventListener("abort", finish); resolve(events.length); };
        const timer = setTimeout(finish, timeout);
        wakeups.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
  };
  const commit = (content: string, sender: "user" | "agent" = "agent", clientId?: string) => {
    const message: ChannelMessageView = {
      id: crypto.randomUUID(), channelId: "chat", sequence: String(messages.length + 1), sender, senderBotId: null, sourceRunId: null,
      content, ...(clientId ? { clientId } : {}), metadata: { type: "text" }, createdAt: new Date().toISOString(),
    };
    messages.push(message);
    events.push({ sequence: String(events.length + 1), topic: "channel.message.created", entityId: message.id, payload: {}, createdAt: message.createdAt });
    for (const wake of [...wakeups]) wake();
    return message;
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v0/events")) {
      const lifetime = new AbortController();
      connections.add(lifetime);
      request.signal.addEventListener("abort", () => { lifetime.abort(); connections.delete(lifetime); }, { once: true });
      const after = BigInt(url.searchParams.get("after") ?? "0");
      if (url.pathname.endsWith("/poll")) {
        try { return Response.json(await eventPoll(source, after, lifetime.signal, Number(url.searchParams.get("waitMs")))); }
        finally { connections.delete(lifetime); }
      }
      return new Response(eventStream(source, after, lifetime.signal), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/client-bootstrap")) return Response.json({ cursor: String(events.length), channels: [{ id: "chat" }] });
    if (url.pathname.endsWith("/history")) return Response.json({ channelId: "chat", revision: String(events.length), messages });
    if (url.pathname.endsWith("/client-state")) return Response.json({ channelId: "chat", revision: String(events.length) });
    if (url.pathname.endsWith("/messages") && request.method === "POST") {
      const input = (await request.json()) as { content: string; clientId: string };
      return Response.json({ message: commit(input.content, "user", input.clientId) });
    }
    return new Response("not found", { status: 404 });
  } });
  const syncs: Array<ReturnType<typeof createLiveSyncController>> = [];
  function peer(eventTransport: "stream" | "long-poll") {
    const client = createOpenTeamClient({ baseUrl: server.url.toString(), eventTransport });
    const cursor = new CommittedEventCursor();
    let history: ChannelMessageView[] = [], healthy = false;
    const sync = createLiveSyncController({
      cursor: () => cursor.reconnectAfter(), listen: client.listenForEvents, debounceMs: 5,
      delayForReconnectAttempt: () => 10, delayForSyncRetryAttempt: () => 10, healthyFallbackMs: 60_000, degradedFallbackMs: 60_000,
      onHealthChange: (value) => { healthy = value; },
      handleEvent: (event) => { cursor.observe(event.sequence); return shouldRefreshForEvent(event); },
      synchronize: async () => { await synchronizeClientSnapshot({
        readBootstrap: client.bootstrap, readHistory: client.channelHistory, readState: client.channelState,
        activeChannel: () => "chat", historyIdentity: () => history, pendingHistory: () => null, isCurrent: () => true,
        acceptBootstrap: (bootstrap: ClientBootstrapView) => cursor.commit(bootstrap.cursor),
        acceptHistory: (page: ChannelHistoryPage) => { history = page.messages; },
        acceptState: (_state: ChannelClientState) => {},
        defer: (pending) => { if (pending) void pending.then(() => sync.requestSync()); else sync.requestSync(); },
      }); },
    });
    syncs.push(sync);
    sync.setActive(true);
    return { client, get history() { return history; }, get healthy() { return healthy; } };
  }
  return {
    peer, commit,
    stop() {
      for (const sync of syncs) sync.stop();
      for (const connection of connections) connection.abort();
      server.stop(true);
    },
  };
};

// One SSE and one long-poll peer, so both server transports reach the real client.
test("a send from an SSE peer and a later reply reach a long-poll peer through the live sync controller", async () => {
  const f = fixture();
  const sender = f.peer("stream"), receiver = f.peer("long-poll");
  try {
    await until(() => sender.healthy && receiver.healthy);
    await sender.client.sendChannelMessage("chat", "local send", [], undefined, { clientId: "nonce-1" });
    await until(() => sender.history.length === 1 && receiver.history.length === 1);
    f.commit("simulated incoming reply");
    await until(() => sender.history.length === 2 && receiver.history.length === 2);
    expect(receiver.history.map((m) => m.content)).toEqual(["local send", "simulated incoming reply"]);
    expect(sender.history).toEqual(receiver.history);
  } finally {
    f.stop();
  }
});
