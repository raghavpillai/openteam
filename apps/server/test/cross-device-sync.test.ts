import { describe, expect, test } from "bun:test";
import type {
  ChannelClientState,
  ChannelHistoryPage,
  ChannelMessageView,
  ClientBootstrapView,
  ProductEvent,
} from "@openteam/contracts";
import {
  CommittedEventCursor,
  createLiveSyncController,
  createOpenTeamClient,
  shouldRefreshForEvent,
  synchronizeClientSnapshot,
} from "../../../packages/client-core/src";
import { createDurableSendController } from "../../../packages/product-core/src/durable-delivery";
import { projectOutgoingMessages } from "../../../packages/product-core/src/outgoing-messages";
import {
  type EventStreamSource,
  eventPoll,
  eventStream,
  SSE_EVENT_BATCH_SIZE,
} from "../src/event-stream";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

// Real loopback HTTP and production SSE/poll implementations, without inference or a real account.
const fixture = () => {
  const messages: ChannelMessageView[] = [];
  const events: ProductEvent[] = [];
  const wakeups = new Set<() => void>();
  const connections = new Set<AbortController>();
  const limits: number[] = [];
  const requests: string[] = [];
  let acceptance: Promise<void> | null = null;
  let acknowledgement: Promise<void> | null = null;
  let failHistory = 0;
  const source: EventStreamSource = {
    get eventVersion() {
      return events.length;
    },
    eventWindowAfter: async (after, limit) => {
      limits.push(limit);
      return {
        oldest: events.length ? 1n : null,
        latest: events.length ? BigInt(events.length) : null,
        cursorExpired: false,
        cursorAhead: false,
        events: events.filter((event) => BigInt(event.sequence) > after).slice(0, limit),
      };
    },
    waitForEvent: async (version, timeout, signal) => {
      if (version !== events.length || signal?.aborted) return events.length;
      return new Promise<number>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wakeups.delete(finish);
          signal?.removeEventListener("abort", finish);
          resolve(events.length);
        };
        const timer = setTimeout(finish, timeout);
        wakeups.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
  };
  const commit = (content: string, sender: "user" | "agent" = "agent", clientId?: string) => {
    const existing = clientId ? messages.find((m) => m.clientId === clientId) : undefined;
    if (existing) return existing;
    const message: ChannelMessageView = {
      id: crypto.randomUUID(),
      channelId: "chat",
      sequence: String(messages.length + 1),
      sender,
      senderBotId: null,
      sourceRunId: null,
      content,
      ...(clientId ? { clientId } : {}),
      metadata: { type: "text" },
      createdAt: new Date().toISOString(),
    };
    messages.push(message);
    events.push({
      sequence: String(events.length + 1),
      topic: "channel.message.created",
      entityId: message.id,
      payload: {},
      createdAt: message.createdAt,
    });
    for (const wake of [...wakeups]) wake();
    return message;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname.startsWith("/api/v0/events")) {
        const lifetime = new AbortController();
        connections.add(lifetime);
        request.signal.addEventListener(
          "abort",
          () => {
            lifetime.abort();
            connections.delete(lifetime);
          },
          { once: true }
        );
        const after = BigInt(url.searchParams.get("after") ?? "0");
        if (url.pathname.endsWith("/poll")) {
          try {
            return Response.json(
              await eventPoll(
                source,
                after,
                lifetime.signal,
                Number(url.searchParams.get("waitMs"))
              )
            );
          } finally {
            connections.delete(lifetime);
          }
        }
        return new Response(eventStream(source, after, lifetime.signal), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname.endsWith("/client-bootstrap"))
        return Response.json({ cursor: String(events.length), channels: [{ id: "chat" }] });
      if (url.pathname.endsWith("/history")) {
        if (failHistory > 0) {
          failHistory -= 1;
          return new Response("temporary read failure", { status: 503 });
        }
        return Response.json({ channelId: "chat", revision: String(events.length), messages });
      }
      if (url.pathname.endsWith("/client-state"))
        return Response.json({ channelId: "chat", revision: String(events.length) });
      if (url.pathname.endsWith("/messages") && request.method === "POST") {
        const input = (await request.json()) as { content: string; clientId: string };
        await acceptance;
        const message = commit(input.content, "user", input.clientId);
        await acknowledgement;
        return Response.json({ message });
      }
      return new Response("not found", { status: 404 });
    },
  });
  type FixturePeer = {
    client: ReturnType<typeof createOpenTeamClient>;
    sync: ReturnType<typeof createLiveSyncController>;
    received: string[];
    readonly history: ChannelMessageView[];
    readonly healthy: boolean;
    readonly reads: number;
    setPending(value: Promise<unknown> | null): void;
  };
  const peers: FixturePeer[] = [];
  function peer(eventTransport: "stream" | "long-poll"): FixturePeer {
    const client = createOpenTeamClient({ baseUrl: server.url.toString(), eventTransport });
    const cursor = new CommittedEventCursor();
    let history: ChannelMessageView[] = [];
    let healthy = false;
    let reads = 0;
    const received: string[] = [];
    let pendingHistory: Promise<unknown> | null = null;
    const sync = createLiveSyncController({
      cursor: () => cursor.reconnectAfter(),
      listen: client.listenForEvents,
      debounceMs: 5,
      delayForReconnectAttempt: () => 10,
      delayForSyncRetryAttempt: () => 10,
      healthyFallbackMs: 60_000,
      degradedFallbackMs: 60_000,
      onHealthChange: (value) => {
        healthy = value;
      },
      handleEvent: (event) => {
        cursor.observe(event.sequence);
        received.push(event.sequence);
        return shouldRefreshForEvent(event);
      },
      synchronize: async () => {
        reads += 1;
        await synchronizeClientSnapshot({
          readBootstrap: client.bootstrap,
          readHistory: client.channelHistory,
          readState: client.channelState,
          activeChannel: () => "chat",
          historyIdentity: () => history,
          pendingHistory: () => pendingHistory,
          isCurrent: () => true,
          acceptBootstrap: (bootstrap: ClientBootstrapView) => cursor.commit(bootstrap.cursor),
          acceptHistory: (page: ChannelHistoryPage) => {
            history = page.messages;
          },
          acceptState: (_state: ChannelClientState) => {},
          defer: (pending) => {
            if (pending) void pending.then(() => sync.requestSync());
            else sync.requestSync();
          },
        });
      },
    });
    const result = {
      client,
      sync,
      received,
      get history() {
        return history;
      },
      get healthy() {
        return healthy;
      },
      get reads() {
        return reads;
      },
      setPending(value: Promise<unknown> | null) {
        pendingHistory = value;
      },
    };
    peers.push(result);
    sync.setActive(true);
    return result;
  }
  return {
    messages,
    limits,
    requests,
    peer,
    commit,
    holdAcceptance(value: Promise<void> | null) {
      acceptance = value;
    },
    holdAcknowledgement(value: Promise<void> | null) {
      acknowledgement = value;
    },
    failNextHistory() {
      failHistory += 1;
    },
    disconnect() {
      for (const connection of connections) connection.abort();
      connections.clear();
    },
    stop() {
      for (const peer of peers) peer.sync.stop();
      for (const connection of connections) connection.abort();
      server.stop(true);
    },
  };
};

describe("desktop SSE ↔ mobile long-poll delivery over HTTP", () => {
  for (const senderTransport of ["stream", "long-poll"] as const) {
    test(`${senderTransport} sends optimistically before disk/network ACK and both peers show one echo`, async () => {
      const f = fixture();
      const disk = gate(),
        accepted = gate(),
        ack = gate();
      f.holdAcceptance(accepted.promise);
      f.holdAcknowledgement(ack.promise);
      const sender = f.peer(senderTransport),
        receiver = f.peer(senderTransport === "stream" ? "long-poll" : "stream");
      const delivery = createDurableSendController(
        "http-sync-test",
        {
          read: async () => null,
          write: async () => {
            await disk.promise;
          },
        },
        {
          dispatch: (record) =>
            sender.client.sendChannelMessage("chat", record.payload.content, [], undefined, {
              clientId: record.nonce,
            }),
          resolveAcceptance: async () => ({ status: "not_found" }),
          classifyError: () => "ambiguous",
        }
      );
      try {
        await until(() => sender.healthy && receiver.healthy);
        await delivery.restore();
        const enqueue = delivery.enqueue({
          target: { channelId: "chat", conversationId: null },
          payload: { content: "immediate local send", attachments: [] },
        });
        await until(() => delivery.getSnapshot().length === 1);
        expect(projectOutgoingMessages([], delivery.getSnapshot())[0]).toMatchObject({
          pending: true,
          message: { content: "immediate local send" },
        });
        expect(f.requests.some((r) => r.startsWith("POST"))).toBe(false);
        expect(receiver.history).toHaveLength(0);
        disk.resolve();
        await enqueue;
        await until(() => f.requests.some((r) => r.startsWith("POST")));
        expect(f.messages).toHaveLength(0);
        accepted.resolve();
        await until(() => sender.history.length === 1 && receiver.history.length === 1);
        // The HTTP ACK is still held. The authoritative echo already settles the visible row.
        const projected = projectOutgoingMessages(sender.history, delivery.getSnapshot());
        expect(projected).toHaveLength(1);
        expect(projected[0]?.pending).toBe(false);
        await delivery.reconcile(sender.history);
        ack.resolve();
        await delivery.flush();
        expect(projectOutgoingMessages(sender.history, delivery.getSnapshot())).toHaveLength(1);
        f.commit("simulated incoming reply");
        await until(() => sender.history.length === 2 && receiver.history.length === 2);
        expect(sender.history).toEqual(receiver.history);
      } finally {
        disk.resolve();
        accepted.resolve();
        ack.resolve();
        delivery.dispose();
        f.stop();
      }
    });
  }

  test("delivers a multi-batch burst exactly once and in order on both transports", async () => {
    const f = fixture();
    try {
      const desktop = f.peer("stream"),
        mobile = f.peer("long-poll");
      await until(() => desktop.healthy && mobile.healthy);
      for (let i = 0; i < 150; i += 1) f.commit(`burst ${i}`, i % 2 ? "user" : "agent");
      await until(() => desktop.history.length === 150 && mobile.history.length === 150);
      const expected = Array.from({ length: 150 }, (_, i) => String(i + 1));
      expect(desktop.received).toEqual(expected);
      expect(mobile.received).toEqual(expected);
      expect(new Set(desktop.history.map((m: ChannelMessageView) => m.id)).size).toBe(150);
      expect(desktop.history).toEqual(mobile.history);
      expect(f.limits.every((limit) => limit === SSE_EVENT_BATCH_SIZE)).toBe(true);
      expect(desktop.reads).toBeLessThan(10);
      expect(mobile.reads).toBeLessThan(10);
    } finally {
      f.stop();
    }
  });

  test("recovers the last update after read failure, transport disconnect, and background/resume", async () => {
    const f = fixture();
    try {
      const desktop = f.peer("stream"),
        mobile = f.peer("long-poll");
      await until(() => desktop.healthy && mobile.healthy);
      mobile.sync.setActive(false);
      f.failNextHistory();
      f.commit("final event; no later wakeup");
      await until(() => desktop.history.length === 1);
      expect(desktop.reads).toBeGreaterThanOrEqual(2);
      expect(mobile.history).toHaveLength(0);
      f.disconnect();
      f.commit("sent while disconnected");
      mobile.sync.setActive(true, true);
      await until(() => desktop.history.length === 2 && mobile.history.length === 2);
      expect(desktop.history).toEqual(mobile.history);
      expect(new Set(mobile.history.map((m: ChannelMessageView) => m.id)).size).toBe(2);
    } finally {
      f.stop();
    }
  });

  test("retries the final message when hydration was pending, without another event", async () => {
    const f = fixture(),
      hydration = gate();
    try {
      const mobile = f.peer("long-poll");
      await until(() => mobile.healthy);
      mobile.setPending(hydration.promise);
      f.commit("last update during hydration");
      await until(() => mobile.reads > 0);
      expect(mobile.history).toHaveLength(0);
      mobile.setPending(null);
      hydration.resolve();
      await until(() => mobile.history.length === 1);
      expect(mobile.history[0]?.content).toBe("last update during hydration");
    } finally {
      hydration.resolve();
      f.stop();
    }
  });
});
