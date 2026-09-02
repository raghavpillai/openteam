import { describe, expect, test } from "bun:test";
import {
  consumeProductEventStream,
  createOpenBotClient,
  normalizeBaseUrl,
  normalizeClientSnapshot,
  sidebarPreferencesFromRootSettings,
} from "../src";

describe("mobile-safe OpenBot client", () => {
  test("normalizes a configured server origin", () => {
    expect(normalizeBaseUrl(" https://openbot.example.test/// ")).toBe(
      "https://openbot.example.test"
    );
  });

  test("rejects unsafe configured server URLs in every client", () => {
    expect(() => normalizeBaseUrl("file:///tmp/openbot")).toThrow("HTTP or HTTPS");
    expect(() => normalizeBaseUrl("https://owner:secret@openbot.test")).toThrow(
      "username or password"
    );
    expect(() => normalizeBaseUrl("https://openbot.test?token=secret")).toThrow(
      "query or fragment"
    );
  });

  test("adds idempotency and timezone fields to messages", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test/",
      fetch,
      createId: () => "mobile-request-1",
      timeZone: () => "Asia/Jerusalem",
    });

    await client.sendChannelMessage("channel/1", "hello");

    expect(calls[0]?.url).toBe("http://openbot.test/api/v0/channels/channel%2F1/messages");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      content: "hello",
      attachments: [],
      clientId: "mobile-request-1",
      timeZone: "Asia/Jerusalem",
    });
  });

  test("preserves a durable caller nonce and exposes delivery acceptance lookup", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({});
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });

    await client.sendChannelMessage("channel/1", "hello", [], undefined, {
      clientId: "durable-nonce-0001",
    });
    await client.messageDeliveryStatus("channel/1", "durable-nonce-0001");

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      clientId: "durable-nonce-0001",
    });
    expect(calls[1]?.url).toBe(
      "http://openbot.test/api/v0/channels/channel%2F1/message-deliveries/durable-nonce-0001"
    );
  });

  test("routes widget and secure handoff actions through one-shot message endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let nextId = 0;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ accepted: true, message: {}, runId: null }, { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      createId: () => `rich-client-${++nextId}`,
    });

    await client.respondToWidget("message/1", "Deploy");
    await client.dismissWidget("message/2");
    await client.submitSecret("message/3", "  preserve-whitespace  ");

    expect(
      calls.map((call) => [call.url, call.init?.method, JSON.parse(String(call.init?.body))])
    ).toEqual([
      [
        "http://openbot.test/api/v0/channel-messages/message%2F1/widget-response",
        "POST",
        { value: "Deploy", clientId: "rich-client-1" },
      ],
      [
        "http://openbot.test/api/v0/channel-messages/message%2F2/widget-dismiss",
        "POST",
        { clientId: "rich-client-2" },
      ],
      [
        "http://openbot.test/api/v0/channel-messages/message%2F3/secret",
        "POST",
        { value: "  preserve-whitespace  ", clientId: "rich-client-3" },
      ],
    ]);
  });

  test("exposes additive bootstrap and cursor-paginated history surfaces", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });

    await client.bootstrap();
    await client.runtime();
    await client.channelHistory("channel/1", { beforeSequence: "900", limit: 50 });
    await client.channelState("channel/1");
    await client.messageContext("message/1", { before: 20, after: 10 });
    await client.messageContext("older/edge", { direction: "before", limit: 25 });
    await client.messageContext("newer/edge", { direction: "after", limit: 30 });

    expect(calls).toEqual([
      "http://openbot.test/api/v0/client-bootstrap",
      "http://openbot.test/api/v0/client-runtime",
      "http://openbot.test/api/v0/channels/channel%2F1/history?before=900&limit=50",
      "http://openbot.test/api/v0/channels/channel%2F1/client-state",
      "http://openbot.test/api/v0/channel-messages/message%2F1/context?before=20&after=10",
      "http://openbot.test/api/v0/channel-messages/older%2Fedge/context?direction=before&limit=25",
      "http://openbot.test/api/v0/channel-messages/newer%2Fedge/context?direction=after&limit=30",
    ]);
  });

  test("streams authenticated product events across arbitrary response chunks", async () => {
    const calls: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    const encoded = new TextEncoder().encode(
      ': connected\r\n\r\nid: 41\r\nevent: product\r\ndata: {"sequence":"41","topic":"channel.message.accepted","entityId":"message-1","payload":{},"createdAt":"2026-08-31T00:00:00.000Z"}\r\n\r\n'
    );
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoded.slice(0, 19));
            controller.enqueue(encoded.slice(19, 67));
            controller.enqueue(encoded.slice(67));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      getAuthToken: () => "mobile-session",
    });
    const topics: string[] = [];

    await client.listenForEvents("40", {
      onEvent: (event) => topics.push(`${event.sequence}:${event.topic}`),
    });

    expect(calls).toEqual([
      {
        url: "http://openbot.test/api/v0/events?after=40",
        authorization: "Bearer mobile-session",
        accept: "text/event-stream",
      },
    ]);
    expect(topics).toEqual(["41:channel.message.accepted"]);
  });

  test("surfaces stream diagnostics without confusing them for product events", async () => {
    const response = new Response(
      'event: stream-error\ndata: {"message":"listener unavailable"}\n\n',
      { status: 200 }
    );
    const events: string[] = [];
    const errors: string[] = [];

    await consumeProductEventStream(response, {
      onEvent: (event) => events.push(event.topic),
      onStreamError: (message) => errors.push(message),
    });

    expect(events).toEqual([]);
    expect(errors).toEqual(["listener unavailable"]);
  });

  test("cancels the network body when product event handling throws", async () => {
    let cancelled = false;
    const encoded = new TextEncoder().encode(
      'event: product\ndata: {"sequence":"1","topic":"bot.updated","entityId":null,"payload":{},"createdAt":"2026-08-31T00:00:00.000Z"}\n\n'
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    await expect(
      consumeProductEventStream(response, {
        onEvent: () => {
          throw new Error("consumer failed");
        },
      })
    ).rejects.toThrow("consumer failed");
    expect(cancelled).toBe(true);
  });

  test("adapts canonical root sidebar settings while preserving local-only fields", () => {
    const fallback = {
      version: 2 as const,
      pinnedIds: [],
      unreadIds: ["channel-unread"],
      unassignedCollapsed: true,
      sections: [],
      sectionByChannel: {},
      channelOrderByGroup: { section: ["channel-2"] },
    };

    expect(
      sidebarPreferencesFromRootSettings(
        {
          valid: true,
          settings: {
            pinnedAgentIds: ["channel-1"],
            sidebarSections: [
              {
                id: "priority",
                name: "Priority",
                agentIds: ["channel-1", "channel-2"],
                isCollapsed: false,
              },
            ],
          },
        },
        fallback
      )
    ).toEqual({
      ...fallback,
      pinnedIds: ["channel-1"],
      sections: [{ id: "priority", name: "Priority", collapsed: false }],
      sectionByChannel: { "channel-1": "priority", "channel-2": "priority" },
    });
  });

  test("exposes mobile Bot and group creation and editing mutations", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      createId: () => "mobile-mutation-1",
      timeZone: () => "America/New_York",
    });

    await client.createBot({ clientRequestId: "create-bot-1", name: "Research" });
    await client.createGroup({ name: "Launch", botIds: ["bot/1"] });
    await client.renameChannel("channel/1", "Launch room");
    await client.updateChannelProfile("channel/1", "Launch room", "Ships the launch");
    await client.setChannelMembers("channel/1", ["bot/1", "bot/2"]);
    await client.setChannelHidden("channel/1", true);
    await client.groups(true);
    await client.deleteGroup("channel/1");
    await client.archiveBot("bot/1");

    expect(
      calls.map((call) => [
        call.url,
        call.init?.method,
        call.init?.body ? JSON.parse(String(call.init.body)) : null,
      ])
    ).toEqual([
      [
        "http://openbot.test/api/v0/bots",
        "POST",
        { clientRequestId: "create-bot-1", name: "Research" },
      ],
      ["http://openbot.test/api/v0/channels", "POST", { name: "Launch", botIds: ["bot/1"] }],
      [
        "http://openbot.test/api/v0/channels/channel%2F1/name",
        "PATCH",
        { name: "Launch room", clientId: "mobile-mutation-1", timeZone: "America/New_York" },
      ],
      [
        "http://openbot.test/api/v0/channels/channel%2F1/profile",
        "PATCH",
        {
          name: "Launch room",
          description: "Ships the launch",
          clientId: "mobile-mutation-1",
        },
      ],
      [
        "http://openbot.test/api/v0/channels/channel%2F1/members",
        "PUT",
        { botIds: ["bot/1", "bot/2"], clientId: "mobile-mutation-1" },
      ],
      [
        "http://openbot.test/api/v0/channels/channel%2F1/hidden",
        "PATCH",
        { hidden: true, clientId: "mobile-mutation-1" },
      ],
      ["http://openbot.test/api/v0/groups?includeHidden=1", undefined, null],
      ["http://openbot.test/api/v0/channels/channel%2F1", "DELETE", null],
      ["http://openbot.test/api/v0/bots/bot%2F1", "DELETE", null],
    ]);
  });

  test("uploads attachment bytes without base64 expansion", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const asset = {
      assetId: "a".repeat(64),
      fileName: "截图.png",
      mimeType: "image/png",
      byteSize: 3,
      kind: "image" as const,
    };
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(asset), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    await expect(client.uploadAsset(image, "截图.png")).resolves.toEqual(asset);

    expect(calls[0]?.url).toBe("http://openbot.test/api/v0/assets");
    expect(calls[0]?.init?.body).toBe(image);
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("image/png");
    expect(new Headers(calls[0]?.init?.headers).get("x-file-name")).toBe("%E6%88%AA%E5%9B%BE.png");
    expect(client.assetUrl(asset)).toBe(
      `http://openbot.test/api/v0/assets/${asset.assetId}?name=${encodeURIComponent(asset.fileName)}`
    );
  });

  test("retains the canonical JSON upload transport for non-Blob clients", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const asset = {
      assetId: "c".repeat(64),
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      kind: "text" as const,
    };
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(asset, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });
    const input = {
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytesBase64: "aGVsbG8=",
    };

    await expect(client.uploadAsset(input)).resolves.toEqual(asset);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
  });

  test("sends attachment-only messages through the shared durable-asset contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      createId: () => "mobile-image-request-1",
      timeZone: () => "Asia/Jerusalem",
    });
    const attachment = {
      assetId: "b".repeat(64),
      fileName: "upload-test.png",
      mimeType: "image/png",
      byteSize: 12,
      kind: "image" as const,
      alt: "Upload test",
    };

    await client.sendDirectMessage("conversation/1", "", [attachment], "message/1");

    expect(calls[0]?.url).toBe(
      "http://openbot.test/api/v0/conversations/conversation%2F1/messages"
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      content: "",
      attachments: [attachment],
      replyToMessageId: "message/1",
      clientId: "mobile-image-request-1",
      timeZone: "Asia/Jerusalem",
    });
  });

  test("maps API failures to stable client errors", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "stale", message: "Already resolved" } }), {
        status: 409,
      })) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });

    await expect(client.resolveApproval("approval-1", "accept")).rejects.toMatchObject({
      name: "OpenBotClientError",
      code: "stale",
      status: 409,
      message: "Already resolved",
    });
  });

  test("attaches bearer sessions and reports expired authentication", async () => {
    const calls: RequestInit[] = [];
    const unauthorized: Array<string | null> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      getAuthToken: async () => "signed-session",
      onUnauthorized: (usedToken) => {
        unauthorized.push(usedToken);
      },
    });

    await expect(client.snapshot()).rejects.toMatchObject({ status: 401 });
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer signed-session");
    expect(unauthorized).toEqual(["signed-session"]);
  });

  test("brokers shared-computer status, input, takeover, and frames through the server", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });

    await client.screenStatus("bot/1");
    await client.screenAction("bot/1", { action: "click", x: 640, y: 400 });
    await client.setScreenTakeover("bot/1", true);

    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["http://openbot.test/api/v0/bots/bot%2F1/screen", "GET"],
      ["http://openbot.test/api/v0/bots/bot%2F1/screen/actions", "POST"],
      ["http://openbot.test/api/v0/bots/bot%2F1/screen/takeover", "POST"],
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      action: "click",
      x: 640,
      y: 400,
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ active: true });
    expect(client.screenFrameUrl("bot/1", 42)).toBe(
      "http://openbot.test/api/v0/bots/bot%2F1/screen/frame?v=42"
    );
  });

  test("normalizes missing snapshot lists during reconnect", () => {
    const snapshot = normalizeClientSnapshot({
      cursor: "partial",
      workspace: {
        root: "/workspace",
        sharedDirectory: "/workspace/shared",
        botsDirectory: "/workspace/bots",
        projectsDirectory: "/workspace/projects",
      },
      runtime: {
        server: "ready",
        database: "ready",
        queue: "ready",
        computer: "ready",
        inference: "ready",
      },
    } as Parameters<typeof normalizeClientSnapshot>[0]);

    expect(snapshot.bots).toEqual([]);
    expect(snapshot.channels).toEqual([]);
    expect(snapshot.channelMessages).toEqual([]);
    expect(snapshot.channelRounds).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.runItems).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.subagents).toEqual([]);
  });
});
