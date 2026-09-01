import { describe, expect, test } from "bun:test";
import { createOpenBotClient } from "@openbot/client-core";
import { coordinatePushRetirement } from "../src/push-retirement";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const device = {
  installationId: "ios-installation",
  platform: "ios" as const,
  pushToken: "ExpoPushToken[issued-registration]",
};

describe("push retirement ordering", () => {
  test("waits for an issued registration before unregistering with the captured credential", async () => {
    const registerResponse = deferred();
    const registerStarted = deferred();
    const calls: Array<{ authorization: string | null; method: string }> = [];
    let enabled = false;
    const client = createOpenBotClient({
      baseUrl: "https://first.openbot.test",
      getAuthToken: () => "captured-first-token",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          authorization: new Headers(init?.headers).get("authorization"),
          method,
        });
        if (method === "POST") {
          registerStarted.resolve();
          await registerResponse.promise;
          enabled = true;
          return Response.json({ ok: true });
        }
        enabled = false;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const registration = client.registerPushDevice(device);
    await registerStarted.promise;

    const retirement = coordinatePushRetirement(
      [registration],
      () => client.unregisterPushDevice(device.installationId),
      1_000
    );
    await Promise.resolve();
    expect(calls.map(({ method }) => method)).toEqual(["POST"]);
    registerResponse.resolve();
    await Promise.all([retirement.bounded, retirement.eventual]);

    expect(enabled).toBe(false);
    expect(calls).toEqual([
      { authorization: "Bearer captured-first-token", method: "POST" },
      { authorization: "Bearer captured-first-token", method: "DELETE" },
    ]);
  });

  test("repeats cleanup after a registration that outlives the bounded sign-out wait", async () => {
    const registerResponse = deferred();
    const registerStarted = deferred();
    const calls: string[] = [];
    let enabled = false;
    const client = createOpenBotClient({
      baseUrl: "https://slow.openbot.test",
      getAuthToken: () => "captured-slow-token",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        if (method === "POST") {
          registerStarted.resolve();
          await registerResponse.promise;
          enabled = true;
        } else {
          enabled = false;
        }
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    const registration = client.registerPushDevice(device);
    await registerStarted.promise;

    const retirement = coordinatePushRetirement(
      [registration],
      () => client.unregisterPushDevice(device.installationId),
      1
    );
    await retirement.bounded;
    expect(calls).toEqual(["POST", "DELETE"]);
    expect(enabled).toBe(false);

    registerResponse.resolve();
    await retirement.eventual;
    expect(calls).toEqual(["POST", "DELETE", "DELETE"]);
    expect(enabled).toBe(false);
  });
});
