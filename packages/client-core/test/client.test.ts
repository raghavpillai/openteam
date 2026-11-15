import { describe, expect, test } from "bun:test";
import type { ExternalDraft } from "@openteam/contracts/external-draft";
import { createKeyedRequestCoordinator, createOpenTeamClient, normalizeBaseUrl } from "../src";
import { assessOpenTeamAuthSession, authHeadersForUrl, createOpenTeamAuthClient } from "../src/auth";
import { externalDraftReviewEdits, externalDraftReviewFields, externalDraftReviewState, mergeExternalDraftReviewFields } from "../src/external-draft";

const recordingFetch = (respond: () => Response = () => Response.json({})) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const authClient = (status: number) => createOpenTeamAuthClient({
  baseUrl: "https://openteam.test",
  fetch: async (input) => String(input).endsWith("/api/auth/config") ? Response.json({ mode: "required" }) : new Response("error", { status }),
});

describe("mobile-safe OpenTeam client", () => {
  test("rejects unsafe configured server URLs in every client", () => {
    expect(() => normalizeBaseUrl("file:///tmp/openteam")).toThrow("HTTP or HTTPS");
    expect(() => normalizeBaseUrl("https://owner:secret@openteam.test")).toThrow("username or password");
    expect(() => normalizeBaseUrl("https://openteam.test?token=secret")).toThrow("query or fragment");
  });

  test("messages carry idempotency and timezone fields, keep a durable caller nonce and expose delivery lookup", async () => {
    const { calls, fetch } = recordingFetch();
    const client = createOpenTeamClient({ baseUrl: "http://openteam.test/", fetch, createId: () => "mobile-request-1", timeZone: () => "Asia/Jerusalem" });
    await client.sendChannelMessage("channel/1", "hello");
    expect(calls[0]?.url).toBe("http://openteam.test/api/v0/channels/channel%2F1/messages");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ content: "hello", attachments: [], clientId: "mobile-request-1", timeZone: "Asia/Jerusalem" });
    await client.sendChannelMessage("channel/1", "hello", [], undefined, { clientId: "durable-nonce-0001" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ clientId: "durable-nonce-0001" });
    await client.messageDeliveryStatus("channel/1", "durable-nonce-0001");
    expect(calls[2]?.url).toBe("http://openteam.test/api/v0/channels/channel%2F1/message-deliveries/durable-nonce-0001");
  });

  test("a send carries the device location while sharing is on, and a failed read never holds it up", async () => {
    const { calls, fetch } = recordingFetch();
    const location = { latitude: 40.75, longitude: -73.99, accuracyMeters: 30, capturedAt: "2026-11-14T10:00:00.000Z", device: "computer" as const };
    let read: () => Promise<typeof location | undefined> = async () => location;
    const client = createOpenTeamClient({ baseUrl: "http://fixture", fetch, location: () => read() });
    await client.sendDirectMessage("conversation", "coffee near me?");
    await client.sendChannelMessage("channel", "coffee near me?");
    read = async () => undefined;
    await client.sendDirectMessage("conversation", "sharing off");
    read = async () => { throw new Error("permission denied"); };
    await client.sendDirectMessage("conversation", "read failed");
    expect(calls.map((call) => JSON.parse(String(call.init?.body)).location)).toEqual([location, location, undefined, undefined]);
  });

  test("streams authenticated product events across arbitrary response chunks", async () => {
    const encoded = new TextEncoder().encode(
      ': connected\r\n\r\nid: 41\r\nevent: product\r\ndata: {"sequence":"41","topic":"channel.message.accepted","entityId":"message-1","payload":{},"createdAt":"2026-08-31T00:00:00.000Z"}\r\n\r\n'
    );
    const { calls, fetch } = recordingFetch(() => new Response(new ReadableStream({
      start(controller) {
        for (const [start, end] of [[0, 19], [19, 67], [67, undefined]]) controller.enqueue(encoded.slice(start, end));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const client = createOpenTeamClient({ baseUrl: "http://openteam.test", fetch, getAuthToken: () => "mobile-session" });
    const topics: string[] = [];
    await client.listenForEvents("40", { onEvent: (event) => topics.push(`${event.sequence}:${event.topic}`) });
    expect(calls.map(({ url, init }) => [url, new Headers(init?.headers).get("authorization"), new Headers(init?.headers).get("accept")]))
      .toEqual([["http://openteam.test/api/v0/events?after=40", "Bearer mobile-session", "text/event-stream"]]);
    expect(topics).toEqual(["41:channel.message.accepted"]);
  });

  test("invalidated keyed-request leases cannot commit stale results", async () => {
    const coordinator = createKeyedRequestCoordinator();
    let captured: Parameters<typeof coordinator.isCurrent>[0] | null = null;
    const request = coordinator.run("channel-1", async (lease) => { captured = lease; return "done"; });
    expect(coordinator.isCurrent(captured!)).toBe(true);
    coordinator.invalidate("channel-1");
    expect(coordinator.isCurrent(captured!)).toBe(false);
    expect(await request).toBe("done");
  });
});

describe("shared authentication protocol", () => {
  test("fails closed for unknown auth modes and rejects invalid sessions", async () => {
    const responses = [Response.json({ mode: "off" }), Response.json({ session: { id: "session" }, user: { id: "missing-name" } })];
    const client = createOpenTeamAuthClient({ baseUrl: "https://openteam.test", fetch: async () => responses.shift() as Response });
    expect(await client.discoverMode()).toBe("required");
    expect(await client.getSession("session-token")).toBeNull();
  });

  test("only attaches a bearer to same-origin API resources", () => {
    expect(authHeadersForUrl("https://openteam.test", "token", "/api/v0/assets/1")).toEqual({ authorization: "Bearer token" });
    expect(authHeadersForUrl("https://openteam.test", "token", "https://evil.test/api/v0/assets/1")).toBeUndefined();
    expect(authHeadersForUrl("https://openteam.test", "token", "/public/file")).toBeUndefined();
  });

  test("keeps the credential on server or proxy errors and clears it when the server rejects the session", async () => {
    for (const status of [500, 502, 503, 504]) {
      const client = authClient(status);
      await expect(client.getSession("session-token")).rejects.toMatchObject({ code: "offline", status });
      expect(await assessOpenTeamAuthSession({ client, loadToken: async () => "session-token" }))
        .toMatchObject({ status: "authenticated", connection: "offline", clearCredentials: false });
    }
    const rejected = authClient(401);
    expect(await rejected.getSession("session-token")).toBeNull();
    expect(await assessOpenTeamAuthSession({ client: rejected, loadToken: async () => "session-token" })).toMatchObject({ status: "signed-out", clearCredentials: true });
  });

  test("a rejected sign-out cannot silently claim session revocation", async () => {
    const client = createOpenTeamAuthClient({ baseUrl: "https://auth-qa.test", fetch: async () => new Response(null, { status: 503 }) });
    await expect(client.signOut("test-token")).rejects.toMatchObject({ code: "sign_out_failed", status: 503 });
  });
});

describe("external draft review edits", () => {
  test("normalize recipients while preserving the verified account and route", () => {
    const draft: ExternalDraft = { platform: "email", providerIdentifier: "gmail-fixture", from: "sender@example.com", to: ["old@example.com"], subject: "Original", body: "Original", replyToMessageId: "thread-fixture" };
    const fields = { body: "Edited", subject: "Updated", to: " first@example.com, ,second@example.com ", cc: "" };
    expect(externalDraftReviewEdits(draft, "send", fields)).toEqual({ body: "Edited", subject: "Updated", to: ["first@example.com", "second@example.com"], cc: [] });
    expect(() => externalDraftReviewEdits(draft, "send", { ...fields, to: "" })).toThrow("Invalid draft to");
    expect(externalDraftReviewEdits(draft, "send", { ...fields, from: "Alias@Example.com" }, ["alias@example.com"])).toMatchObject({ from: "Alias@Example.com" });
    expect(() => externalDraftReviewEdits(draft, "send", { ...fields, from: "other@example.com" }, ["alias@example.com"])).toThrow("verified addresses");
    expect(externalDraftReviewEdits(draft, "cancel", { ...fields, to: "" })).toBeUndefined();
    expect(draft.to).toEqual(["old@example.com"]);
  });

  test("Slack reviews send only the edited body", () => {
    const draft: ExternalDraft = { platform: "slack", providerIdentifier: "slack-fixture", target: "general", channelId: "C12345678", threadTs: "123.456", body: "Original" };
    expect(externalDraftReviewEdits(draft, "send", { body: "Edited", subject: "ignored", to: "ignored", cc: "ignored" })).toEqual({ body: "Edited" });
  });

  test("another device updates untouched fields without replacing local edits", () => {
    const previous = externalDraftReviewFields({ platform: "email", providerIdentifier: "fixture", from: "me@example.com", to: ["ann@example.com"], cc: [], subject: "Original", body: "Original body" });
    const local = { ...previous, body: "Unsaved local body", cc: "local@example.com" };
    const remote = { ...previous, to: "remote@example.com", subject: "Remote subject", body: "Remote body", cc: "remote-cc@example.com" };
    const merged = mergeExternalDraftReviewFields(previous, local, remote);
    expect(merged).toEqual({ ...remote, body: local.body, cc: local.cc });
    // A local field that now matches the last saved version follows later snapshots again.
    const later = { ...remote, body: "Later remote body" };
    expect(mergeExternalDraftReviewFields(remote, { ...merged, body: remote.body }, later)).toEqual({ ...later, cc: local.cc });
    expect(mergeExternalDraftReviewFields(remote, merged, remote)).toBe(merged);
  });

  test("terminal review outcomes cannot be undone by late responses or events", () => {
    expect(externalDraftReviewState("pending", "sending")).toBe("sending");
    expect(externalDraftReviewState("sending", "pending")).toBe("pending");
    for (const terminal of ["sent", "dismissed", "unknown", "failed", "draft-created"]) {
      expect(externalDraftReviewState("sending", terminal)).toBe(terminal);
      for (const stale of ["pending", "sending", "sent", "failed"]) expect(externalDraftReviewState(terminal, stale)).toBe(terminal);
    }
  });
});
