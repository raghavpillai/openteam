import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { channelRoutes } from "../src/routes/channel";
import type { RouteContext } from "../src/routes/context";
import { bodyRoute, dispatchRoutes, effectRoute } from "../src/routes/dispatch";

const context = (method: string, path: string, body?: string): RouteContext => {
  const request = new Request(`http://localhost${path}`, { method, body });
  return { app: {} as RouteContext["app"], request, path, url: new URL(request.url), authMode: "disabled", authenticatedSessionId: null };
};

test("an unmatched body route neither consumes the body nor runs", async () => {
  let calls = 0;
  const handler = bodyRoute("POST", "/expected", Schema.String, () => { calls += 1; return Effect.succeed({ ok: true }); });
  const unmatched = context("POST", "/other", "malformed JSON");
  expect(await handler(unmatched)).toBeUndefined();
  expect(unmatched.request.bodyUsed).toBe(false);
  expect(calls).toBe(0);
});

test("routes preserve raw captures, status codes and standard headers, and stop at the first match", async () => {
  const handler = bodyRoute("POST", /^\/objects\/([^/]+)$/, Schema.Struct({ value: Schema.String }), (_context, id, input) => Effect.succeed({ id, ...input }), 202);
  const response = await handler(context("POST", "/objects/a%2Fb", '{"value":"ok"}'));
  expect(response?.status).toBe(202);
  expect(response?.headers.get("access-control-allow-origin")).toBe("*");
  expect(await response?.json()).toEqual({ id: "a%2Fb", value: "ok" });
  await expect(handler(context("POST", "/objects/id", "{"))).rejects.toMatchObject({ code: "invalid_json", status: 400 });
  await expect(handler(context("POST", "/objects/id", "{}"))).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  let laterCalls = 0;
  const dispatched = await dispatchRoutes(context("GET", "/objects/first/second"), [
    effectRoute("DELETE", /^\/objects\/([^/]+)\/([^/]+)$/, () => Effect.succeed("wrong method")),
    effectRoute("GET", /^\/objects\/([^/]+)\/([^/]+)$/, (_context, id, secondaryId) => Effect.succeed({ id, secondaryId })),
    async () => { laterCalls += 1; return new Response("wrong route"); },
  ]);
  expect(await dispatched?.json()).toEqual({ id: "first", secondaryId: "second" });
  expect(laterCalls).toBe(0);
});

test("Library routes forward the conversation and cursor without caching file metadata", async () => {
  const route = context("GET", "/api/channels/channel-1/library?before=12.2");
  route.path = "/api/channels/channel-1/library";
  const calls: unknown[][] = [];
  route.app = { channelLibrary: (...args: unknown[]) => { calls.push(args); return Effect.succeed({ items: [], nextCursor: null }); } } as never;
  const response = await channelRoutes(route);
  expect(calls).toEqual([["channel-1", "12.2"]]);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ items: [], nextCursor: null });
});
