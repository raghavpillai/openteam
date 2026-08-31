import { describe, expect, test } from "bun:test";
import { createOpenBotClient, normalizeBaseUrl, normalizeClientSnapshot } from "../src";

describe("mobile-safe OpenBot client", () => {
  test("normalizes a configured server origin", () => {
    expect(normalizeBaseUrl(" https://openbot.example.test/// ")).toBe(
      "https://openbot.example.test"
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

  test("authenticates mobile calls and advances a channel read cursor", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json({ channelId: "channel/1", lastReadSequence: "42", unreadCount: 0 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "https://openbot.test",
      accessToken: async () => "mobile-secret",
      fetch,
    });

    await client.markChannelRead("channel/1", "42");

    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer mobile-secret");
    expect(calls[0]?.url).toBe("https://openbot.test/api/v0/channels/channel%2F1/read");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ throughSequence: "42" });
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
      assetId: "a".repeat(64),
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
    let unauthorized = 0;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({
      baseUrl: "http://openbot.test",
      fetch,
      getAuthToken: async () => "signed-session",
      onUnauthorized: () => {
        unauthorized += 1;
      },
    });

    await expect(client.snapshot()).rejects.toMatchObject({ status: 401 });
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer signed-session");
    expect(unauthorized).toBe(1);
  });

  test("uploads bytes once and addresses the resulting immutable asset", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const asset = {
      assetId: "b".repeat(64),
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

    await expect(
      client.uploadAsset({
        fileName: "notes.txt",
        mimeType: "text/plain",
        bytesBase64: "aGVsbG8=",
      })
    ).resolves.toEqual(asset);
    expect(calls[0]?.url).toBe("http://openbot.test/api/v0/assets");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytesBase64: "aGVsbG8=",
    });
    expect(client.assetUrl(asset)).toBe(
      `http://openbot.test/api/v0/assets/${asset.assetId}?name=notes.txt`
    );
    expect(client.assetUrl(asset, true)).toBe(
      `http://openbot.test/api/v0/assets/${asset.assetId}?name=notes.txt&download=1`
    );
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
        agent: "ready",
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
