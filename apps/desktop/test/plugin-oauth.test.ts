import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { DesktopPluginOAuth, type PluginOAuthResult } from "../src/main/plugin-oauth";

function fixture(timeout = 2000) {
  const results: PluginOAuthResult[] = [];
  const received: unknown[] = [];
  const cancelled: unknown[] = [];
  let port = 0;
  let mode = "desktop";
  const client = {
    pluginConfiguration: async () => ({ oauthCallbackMode: mode, oauthLoopbackPort: port }),
    authenticatePlugin: async (_id: string, _force: boolean, redirectUrl?: string) => ({
      status: "needs_auth",
      authorizationUrl: `https://provider.example/authorize?${new URLSearchParams({
        redirect_uri: redirectUrl ?? "https://server.example/callback",
        state: crypto.randomUUID(),
      })}`,
    }),
    finishPluginAuthentication: async (_id: string, input: unknown) => {
      received.push(input);
      return { status: "ready" };
    },
    cancelPluginAuthentication: async (...input: unknown[]) => {
      cancelled.push(input);
    },
    pluginConnectionStatuses: async () => ({ connections: [] }),
  };
  const native = new DesktopPluginOAuth((result) => results.push(result), timeout);
  const start = (id = "account", force = false) =>
    native.start("server-session", id, client as any, force);
  const callback = (started: Awaited<ReturnType<typeof start>>) => {
    const auth = new URL(started.authorizationUrl);
    const url = new URL(auth.searchParams.get("redirect_uri")!);
    url.searchParams.set("state", auth.searchParams.get("state")!);
    url.searchParams.set("code", "synthetic-code");
    return url;
  };
  return {
    native,
    client,
    start,
    callback,
    results,
    received,
    cancelled,
    setPort: (value: number) => {
      port = value;
    },
    setMode: (value: string) => {
      mode = value;
    },
  };
}

test("local callback rejects invalid requests without consuming the listener; relays once and closes", async () => {
  const f = fixture();
  try {
    const [started, resumed] = await Promise.all([f.start(), f.start()]);
    expect(resumed).toEqual(started);
    expect(await f.start()).toEqual(started);
    const url = f.callback(started);
    const wrongState = new URL(url);
    wrongState.searchParams.set("state", "wrong");
    expect((await fetch(wrongState)).status).toBe(400);
    expect((await fetch(url, { method: "POST" })).status).toBe(400);
    const duplicate = new URL(url);
    duplicate.searchParams.append("code", "extra");
    expect((await fetch(duplicate)).status).toBe(400);
    const path = new URL(url);
    path.pathname = "/unrelated";
    expect((await fetch(path)).status).toBe(400);
    expect(f.received).toHaveLength(0);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("synthetic-code");
    await Bun.sleep(10);
    expect(f.received).toHaveLength(1);
    expect(f.results).toEqual([{ connectionId: "account", status: "ready" }]);
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    f.native.closeAll();
  }
});

test("denial, cancellation, timeout and force-restart clean up the listener", async () => {
  const f = fixture(150);
  try {
    const old = f.callback(await f.start());
    const next = f.callback(await f.start("account", true));
    expect(next.origin).not.toBe(old.origin);
    await expect(fetch(old)).rejects.toThrow();
    expect(f.cancelled).toHaveLength(1);
    next.searchParams.delete("code");
    next.searchParams.set("error", "access_denied");
    await fetch(next);
    await Bun.sleep(10);
    expect(f.results[0]?.status).toBe("cancelled");
    const cancel = f.callback(await f.start());
    expect(await f.native.cancel("account", "wrong-state")).toBe(false);
    expect(await f.native.cancel("account", cancel.searchParams.get("state")!)).toBe(true);
    await expect(fetch(cancel)).rejects.toThrow();
    const timeout = f.callback(await f.start());
    await Bun.sleep(180);
    expect(f.results.at(-1)?.message).toContain("timed out");
    await expect(fetch(timeout)).rejects.toThrow();
  } finally {
    f.native.closeAll();
  }
});

test("backend switch during authorization closes the listener and cancels the late attempt", async () => {
  const f = fixture();
  let resolve!: (value: { status: string; authorizationUrl: string }) => void;
  let redirect = "";
  f.client.authenticatePlugin = async (_id, _force, url) => {
    redirect = url!;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const pending = f.start();
  const rejection = pending.then(
    () => null,
    (error) => error as Error
  );
  while (!redirect) await Bun.sleep(1);
  f.native.closeAll();
  resolve({
    status: "needs_auth",
    authorizationUrl: `https://provider.example/authorize?${new URLSearchParams({ redirect_uri: redirect, state: "late-state" })}`,
  });
  expect((await rejection)?.message).toContain("cancelled");
  expect(f.cancelled).toHaveLength(1);
  await expect(fetch(redirect)).rejects.toThrow();
});

test("port conflicts and old servers fail clearly; server callback remains opt-in", async () => {
  const f = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  try {
    f.setPort((occupied.address() as { port: number }).port);
    await expect(f.start()).rejects.toThrow("port is unavailable");
    f.setPort(0);
    const original = f.client.authenticatePlugin;
    f.client.authenticatePlugin = (id, force) => original(id, force);
    await expect(f.start()).rejects.toThrow("did not accept the desktop callback");
    f.setMode("server");
    expect(new URL((await f.start()).authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://server.example/callback"
    );
  } finally {
    f.native.closeAll();
    occupied.close();
  }
});

test("lost completion response checks status without redeeming the code again", async () => {
  const f = fixture();
  let exchanges = 0;
  f.client.finishPluginAuthentication = async () => {
    exchanges++;
    throw new Error("Network disconnected");
  };
  f.client.pluginConnectionStatuses = async () => ({ connections: [{ status: "ready" }] }) as any;
  try {
    await fetch(f.callback(await f.start()));
    await Bun.sleep(10);
    expect(exchanges).toBe(1);
    expect(f.results[0]?.status).toBe("ready");
  } finally {
    f.native.closeAll();
  }
});

test("separate accounts have isolated listeners and all close on shutdown", async () => {
  const f = fixture();
  try {
    const first = f.callback(await f.start("one"));
    const second = f.callback(await f.start("two"));
    expect(first.origin).not.toBe(second.origin);
    const mixed = new URL(first);
    mixed.searchParams.set("state", second.searchParams.get("state")!);
    expect((await fetch(mixed)).status).toBe(400);
    f.native.closeAll();
    await expect(fetch(first)).rejects.toThrow();
    await expect(fetch(second)).rejects.toThrow();
  } finally {
    f.native.closeAll();
  }
});
