import { describe, expect, test } from "bun:test";
import {
  createOpenTeamClient,
  normalizeBaseUrl,
} from "../src";

describe("mobile-safe OpenTeam client", () => {

  test("rejects unsafe configured server URLs in every client", () => {
    expect(() => normalizeBaseUrl("file:///tmp/openteam")).toThrow("HTTP or HTTPS");
    expect(() => normalizeBaseUrl("https://owner:secret@openteam.test")).toThrow(
      "username or password"
    );
    expect(() => normalizeBaseUrl("https://openteam.test?token=secret")).toThrow(
      "query or fragment"
    );
  });

  test("adds idempotency and timezone fields to messages", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenTeamClient({
      baseUrl: "http://openteam.test/",
      fetch,
      createId: () => "mobile-request-1",
      timeZone: () => "Asia/Jerusalem",
    });

    await client.sendChannelMessage("channel/1", "hello");

    expect(calls[0]?.url).toBe("http://openteam.test/api/v0/channels/channel%2F1/messages");
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
    const client = createOpenTeamClient({ baseUrl: "http://openteam.test", fetch });

    await client.sendChannelMessage("channel/1", "hello", [], undefined, {
      clientId: "durable-nonce-0001",
    });
    await client.messageDeliveryStatus("channel/1", "durable-nonce-0001");

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      clientId: "durable-nonce-0001",
    });
    expect(calls[1]?.url).toBe(
      "http://openteam.test/api/v0/channels/channel%2F1/message-deliveries/durable-nonce-0001"
    );
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
    const client = createOpenTeamClient({
      baseUrl: "http://openteam.test",
      fetch,
      getAuthToken: () => "mobile-session",
    });
    const topics: string[] = [];

    await client.listenForEvents("40", {
      onEvent: (event) => topics.push(`${event.sequence}:${event.topic}`),
    });

    expect(calls).toEqual([
      {
        url: "http://openteam.test/api/v0/events?after=40",
        authorization: "Bearer mobile-session",
        accept: "text/event-stream",
      },
    ]);
    expect(topics).toEqual(["41:channel.message.accepted"]);
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
    const client = createOpenTeamClient({ baseUrl: "http://openteam.test", fetch });
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    await expect(client.uploadAsset(image, "截图.png")).resolves.toEqual(asset);

    expect(calls[0]?.url).toBe("http://openteam.test/api/v0/assets");
    expect(calls[0]?.init?.body).toBe(image);
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("image/png");
    expect(new Headers(calls[0]?.init?.headers).get("x-file-name")).toBe("%E6%88%AA%E5%9B%BE.png");
    expect(client.assetUrl(asset)).toBe(
      `http://openteam.test/api/v0/assets/${asset.assetId}?name=${encodeURIComponent(asset.fileName)}`
    );
  });

  test("attaches bearer sessions and reports expired authentication", async () => {
    const calls: RequestInit[] = [];
    const unauthorized: Array<string | null> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenTeamClient({
      baseUrl: "http://openteam.test",
      fetch,
      getAuthToken: async () => "signed-session",
      onUnauthorized: (usedToken) => {
        unauthorized.push(usedToken);
      },
    });

    await expect(client.bootstrap()).rejects.toMatchObject({ status: 401 });
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe("Bearer signed-session");
    expect(unauthorized).toEqual(["signed-session"]);
  });

});

test("routine creation preserves a supplied retry nonce and defaults other callers to fresh IDs", async () => {
  const calls: unknown[] = [];
  let nonce = 0;
  const client = createOpenTeamClient({
    baseUrl: "http://fixture",
    createId: () => `generated-${++nonce}`,
    fetch: (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }) as typeof fetch,
  });
  const input = { name: "Audit", prompt: "Inspect", schedule: "@every 1h", enabled: true };
  await client.createRoutine("bot", "bot", input, "stable-create");
  await client.createRoutine("bot", "bot", input, "stable-create");
  await client.createRoutine("bot", "bot", input);
  expect(calls).toEqual([
    { ...input, clientId: "stable-create" },
    { ...input, clientId: "stable-create" },
    { ...input, clientId: "generated-1" },
  ]);
});
