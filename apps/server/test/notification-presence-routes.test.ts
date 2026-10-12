import { expect, test } from "bun:test";
import { Effect } from "effect";
import { clientRoutes } from "../src/routes/client";
import type { RouteContext } from "../src/routes/context";

const context = (
  path: string,
  body: unknown,
  sessionId: string | null = "authenticated-session"
) => {
  const calls: unknown[] = [];
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    calls,
    route: {
      path,
      request,
      url: new URL(request.url),
      authMode: "required",
      authenticatedSessionId: sessionId,
      app: {
        notifications: {
          updatePresence: (input: unknown, auth: unknown) => {
            calls.push({ input, auth });
            return Effect.succeed({ smartEnabled: true });
          },
        },
      },
    } as unknown as RouteContext,
  };
};

test("presence route binds the authenticated session, not client-supplied ownership", async () => {
  const input = { clientId: crypto.randomUUID(), sequence: 1, platform: "ios", active: true };
  const { route, calls } = context("/api/notification-presence", { ...input, sessionId: "forged" });
  const response = await clientRoutes(route);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(calls).toEqual([
    { input, auth: { mode: "required", sessionId: "authenticated-session" } },
  ]);
});

test("presence route rejects missing auth and invalid activity before touching storage", async () => {
  const missing = context("/api/notification-presence", {}, null);
  expect((await clientRoutes(missing.route))?.status).toBe(401);
  expect(missing.calls).toEqual([]);
  const invalid = context("/api/notification-presence", {
    clientId: crypto.randomUUID(),
    sequence: 1,
    platform: "macos",
    active: true,
    idleSeconds: -1,
  });
  await expect(clientRoutes(invalid.route)).rejects.toThrow("Request body failed validation");
  expect(invalid.calls).toEqual([]);
});
