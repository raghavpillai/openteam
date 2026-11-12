import { expect, test } from "bun:test";
import { McpHttpClientManager } from "../../src/plugins/mcp-client-manager";
import { OpenTeamOAuthProvider } from "../../src/plugins/oauth-provider";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function setup(timeoutMs?: number) {
  const server = createOAuthMcpFixture(0, { refreshTokens: false });
  const manager = new McpHttpClientManager(timeoutMs);
  const provider = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: { state: crypto.randomUUID() }, save: async () => {},
  });
  const options = { endpoint: server.endpoint, authProvider: provider };
  return { server, manager, provider, options };
}

test("closing a connection aborts a stalled OAuth registration", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  f.server.setBeforeRegistration(async () => { entered.release(); await release.promise; });
  const pending = f.manager.beginOAuth("register", f.options).then(() => "authorized", () => "cancelled");
  try {
    await entered.promise;
    await f.manager.closeAll();
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toBe("cancelled");
  } finally { release.release(); await pending; await f.manager.closeAll(); f.server.close(); }
});

test("an unresponsive authorization server has a bounded deadline", async () => {
  const f = setup(100);
  const entered = gate(), release = gate();
  f.server.setBeforeRegistration(async () => { entered.release(); await release.promise; });
  const pending = f.manager.beginOAuth("deadline", f.options).then(() => "authorized", () => "timed out");
  try {
    await entered.promise;
    expect(await Promise.race([pending, Bun.sleep(1000).then(() => "blocked")])).toBe("timed out");
    expect(f.provider.snapshot().authorizationUrl).toBeUndefined();
  } finally { release.release(); await pending; await f.manager.closeAll(); f.server.close(); }
});

test("closing a connection aborts a stalled token exchange without installing its late token", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  const start = await f.manager.beginOAuth("token", f.options);
  const approve = new URL(start.authorizationUrl); approve.pathname = "/approve";
  const response = await fetch(approve, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
  const callback = new URL(response.headers.get("location")!);
  f.server.setBeforeToken(async () => { entered.release(); await release.promise; });
  const pending = f.manager.finishOAuth("token", f.options, callback.searchParams.get("code")!).then(() => "authorized", () => "cancelled");
  try {
    await entered.promise;
    await f.manager.close("token");
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toBe("cancelled");
    expect(f.provider.tokens()).toBeUndefined();
  } finally { release.release(); await pending; await f.manager.closeAll(); f.server.close(); }
});

test("overlapping OAuth starts cannot leave an untracked authorization after shutdown", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  const other = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: { state: crypto.randomUUID() }, save: async () => {},
  });
  f.server.setBeforeRegistration(async () => { entered.release(); await release.promise; });
  const first = f.manager.beginOAuth("overlap", f.options).then(() => "authorized", () => "cancelled");
  const second = f.manager.beginOAuth("overlap", { ...f.options, authProvider: other }).then(() => "authorized", () => "cancelled");
  const pending = Promise.all([first, second]);
  try {
    await entered.promise;
    await f.manager.closeAll();
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toEqual(["cancelled", "cancelled"]);
  } finally { release.release(); await pending; await f.manager.closeAll(); f.server.close(); }
});

test("a replacement OAuth start can finish after the superseded attempt rejects", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  const other = new OpenTeamOAuthProvider({
    redirectUrl: "http://127.0.0.1/callback", initial: { state: crypto.randomUUID() }, save: async () => {},
  });
  f.server.setBeforeRegistration(async () => { entered.release(); await release.promise; });
  const first = f.manager.beginOAuth("replacement", f.options).then(() => "authorized", () => "cancelled");
  const second = f.manager.beginOAuth("replacement", { ...f.options, authProvider: other });
  try {
    await entered.promise;
    release.release();
    expect(await first).toBe("cancelled");
    const start = await second;
    const approve = new URL(start.authorizationUrl); approve.pathname = "/approve";
    const response = await fetch(approve, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
    const callback = new URL(response.headers.get("location")!);
    expect((await f.manager.finishOAuth("replacement", { ...f.options, authProvider: other }, callback.searchParams.get("code")!)).map(tool => tool.name))
      .toContain("whoami");
  } finally { release.release(); await first; await second.catch(() => {}); await f.manager.closeAll(); f.server.close(); }
});

test("overlapping starts using the same provider cannot corrupt the surviving redirect callback", async () => {
  const f = setup();
  const entered = gate(), release = gate();
  f.server.setBeforeRegistration(async () => { entered.release(); await release.promise; });
  const first = f.manager.beginOAuth("shared-provider", f.options).then(() => "authorized", () => "cancelled");
  const second = f.manager.beginOAuth("shared-provider", f.options).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    release.release();
    expect(await first).toBe("cancelled");
    const result = await second;
    if (!("value" in result)) throw result.error;
    const authorizationUrl = result.value.authorizationUrl;
    expect(typeof authorizationUrl).toBe("string");
    expect(f.provider.snapshot().authorizationUrl).toBe(authorizationUrl);
    const approve = new URL(authorizationUrl); approve.pathname = "/approve";
    const response = await fetch(approve, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
    const callback = new URL(response.headers.get("location")!);
    expect((await f.manager.finishOAuth("shared-provider", f.options, callback.searchParams.get("code")!)).map(tool => tool.name)).toContain("whoami");
  } finally { release.release(); await first; await second; await f.manager.closeAll(); f.server.close(); }
});
