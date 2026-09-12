import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { channelRoutes } from "../src/routes/channel";
import type { RouteContext } from "../src/routes/context";
import { bodyRoute, dispatchRoutes, effectRoute } from "../src/routes/dispatch";

const context = (method: string, path: string, body?: string): RouteContext => {
  const request = new Request(`http://localhost${path}`, { method, body });
  return {
    app: {} as RouteContext["app"],
    request,
    path,
    url: new URL(request.url),
    authMode: "disabled",
    authenticatedSessionId: null,
  };
};

describe("shared HTTP route dispatch", () => {
  test("does not consume the body or execute an unmatched route", async () => {
    let calls = 0;
    const handler = bodyRoute("POST", "/expected", Schema.String, () => {
      calls += 1;
      return Effect.succeed({ ok: true });
    });
    const unmatched = context("POST", "/other", "malformed JSON");
    expect(await handler(unmatched)).toBeUndefined();
    expect(unmatched.request.bodyUsed).toBe(false);
    expect(calls).toBe(0);
  });

  test("preserves raw captures, status codes, and standard response headers", async () => {
    const handler = bodyRoute(
      "POST",
      /^\/objects\/([^/]+)$/,
      Schema.Struct({ value: Schema.String }),
      (_context, id, input) => Effect.succeed({ id, ...input }),
      202
    );
    const response = await handler(context("POST", "/objects/a%2Fb", '{"value":"ok"}'));
    expect(response?.status).toBe(202);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response?.json()).toEqual({ id: "a%2Fb", value: "ok" });
    await expect(handler(context("POST", "/objects/id", "{"))).rejects.toMatchObject({
      code: "invalid_json",
      status: 400,
    });
    await expect(handler(context("POST", "/objects/id", "{}"))).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  test("stops at the first matching route and retains secondary captures", async () => {
    let laterCalls = 0;
    const response = await dispatchRoutes(context("GET", "/objects/first/second"), [
      effectRoute("DELETE", /^\/objects\/([^/]+)\/([^/]+)$/, () => Effect.succeed("wrong method")),
      effectRoute("GET", /^\/objects\/([^/]+)\/([^/]+)$/, (_context, id, secondaryId) =>
        Effect.succeed({ id, secondaryId })
      ),
      async () => {
        laterCalls += 1;
        return new Response("wrong route");
      },
    ]);
    expect(await response?.json()).toEqual({ id: "first", secondaryId: "second" });
    expect(laterCalls).toBe(0);
  });

  test("rich-message routes retain ID decoding before body validation", async () => {
    for (const suffix of ["widget-response", "widget-dismiss", "secret", "computer-handoff"]) {
      const input = context("POST", `/api/channel-messages/bad%escape/${suffix}`, "{");
      await expect(channelRoutes(input)).rejects.toBeInstanceOf(URIError);
      expect(input.request.bodyUsed).toBe(false);
    }
  });
});
