import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);

async function setup(packaged = true) {
  const fixture = await createPluginFlowFixture(databaseUrl!, { packaged, authSessions: ["owner"], callbackMode: "manual" });
  const client = createOpenTeamClient({ baseUrl: fixture.server.url.origin, getAuthToken: () => "owner" });
  const key = fixture.definitions[packaged ? 0 : 1]!.key;
  await client.installPlugin(key);
  const id = (await client.pluginSettings()).installs.find(row => row.pluginKey === key)!.connections[0]!.id;
  const configure = async (id: string) => {
    fixture.provider.registerClient(id, "http://127.0.0.1:42813/callback", "fixture-secret");
    await client.savePluginConfiguration(id, {
      values: { clientId: id }, secrets: { clientSecret: { action: "replace", value: "fixture-secret" } },
    });
  };
  const approve = async (url: string) => {
    const target = new URL(url); target.pathname = "/approve";
    const response = await fetch(target, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
    return response.headers.get("location")!;
  };
  const authorize = async (id: string) => {
    const start = await client.authenticatePlugin(id, true);
    await client.finishManualPluginAuthentication(id, await approve(start.authorizationUrl));
  };
  await configure(id);
  await authorize(id);
  const row = (account = id) => fixture.db.pluginConnection.findUniqueOrThrow({ where: { id: account } });
  const expire = async (account = id, noRefresh = false) => {
    const current = await row(account);
    const credentials = current.credentials as any;
    if (noRefresh) delete credentials.oauth.tokens.refresh_token;
    await fixture.db.pluginConnection.update({ where: { id: account }, data: {
      credentials: { ...credentials, oauth: { ...credentials.oauth, tokensExpireAt: 1 } },
    } });
  };
  return { ...fixture, client, id, row, expire, authorize, configure, approve };
}

for (const description of ["Token has been expired or revoked.", "", "Le jeton a expiré. fixture-secret"]) {
  integration(`revoked packaged grant commits needs_auth independent of description: ${description || "empty"}`, async () => {
    const f = await setup();
    const botId = crypto.randomUUID(), runId = crypto.randomUUID(), conversationId = crypto.randomUUID();
    try {
      await f.db.bot.create({ data: { id: botId, name: "OAuth recovery fixture", defaultDirectory: "/tmp", status: "active", conversation: { create: { id: conversationId } } } });
      await f.db.run.create({ data: { id: runId, botId, conversationId, userMessageId: crypto.randomUUID(), status: "running" } });
      const second = await Effect.runPromise(f.service.addAccount(f.id, "other"));
      await f.configure(second.id); await f.authorize(second.id);
      const otherBefore = await f.row(second.id);
      await f.expire();
      const before = await f.row();
      f.provider.setRefreshFailure({ error: "invalid_grant", error_description: description });
      const callId = crypto.randomUUID();
      await expect(f.service.invoke({ connectionId: f.id, botId, runId, callId, toolName: "whoami", arguments: {} })).rejects.toThrow();
      const failed = await f.row();
      expect(failed.status).toBe("needs_auth");
      expect(failed.statusMessage).toBe("Authorization expired or was revoked. Sign in to this account again.");
      expect(failed.runtimeGeneration).toBe(before.runtimeGeneration + 1);
      expect((failed.credentials as any).oauth.tokens).toBeUndefined();
      expect((failed.credentials as any).clientSecret).toBe((before.credentials as any).clientSecret);
      expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).status).toBe("failed");
      for (let i = 0; i < 2; i++) await (f.service as any).refreshLocalConnections();
      expect((await f.row()).statusMessage).toBe(failed.statusMessage);
      expect((await f.row(second.id)).credentials).toEqual(otherBefore.credentials);
      expect(JSON.stringify(await f.client.testPluginConnection(second.id, { toolName: "whoami", arguments: {} }))).toContain("Account A");
      const start = await f.client.authenticatePlugin(f.id);
      const staleCallback = await f.approve(start.authorizationUrl);
      const fresh = await f.client.authenticatePlugin(f.id, true);
      await expect(f.client.finishManualPluginAuthentication(f.id, staleCallback)).rejects.toThrow();
      const outsider = createOpenTeamClient({ baseUrl: f.server.url.origin, getAuthToken: () => "outsider" });
      await expect(outsider.authenticatePlugin(f.id)).rejects.toThrow();
      f.provider.setRefreshFailure(null);
      await f.client.finishManualPluginAuthentication(f.id, await f.approve(fresh.authorizationUrl));
      expect((await f.row()).status).toBe("ready");
      expect(JSON.stringify(await f.client.testPluginConnection(f.id, { toolName: "whoami", arguments: {} }))).toContain("Account A");
    } finally { await f.db.bot.delete({ where: { id: botId } }); await f.close(); }
  }, 20_000);
}

for (const failure of [
  { error: "server_error", status: 503, error_description: "Provider unavailable" },
  { error: "access_denied", status: 403, error_description: "Permission denied (403)" },
  { error: "invalid_client", status: 401, error_description: "Client setup is wrong" },
]) {
  integration(`non-grant failure preserves credentials: ${failure.error}`, async () => {
    const f = await setup();
    try {
      await f.expire(); const before = await f.row();
      f.provider.setRefreshFailure(failure);
      await expect(f.client.restartPluginConnection(f.id)).rejects.toThrow(failure.error_description);
      const failed = await f.row();
      expect(failed.status).toBe("error");
      expect(failed.credentials).toEqual(before.credentials);
      f.provider.setRefreshFailure(null);
      await f.client.restartPluginConnection(f.id);
      expect((await f.row()).status).toBe("ready");
    } finally { await f.close(); }
  });
}

integration("a stale successful connect cannot overwrite a rejected grant or a newer sign-in", async () => {
  const f = await setup();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = (f.service as any).transport;
  const original = transport.discoverStdio.bind(transport);
  try {
    transport.discoverStdio = async (...args: unknown[]) => {
      const result = await original(...args);
      entered(); await blocked; return result;
    };
    const old = Effect.runPromise(f.service.connect(f.id)).then(value => ({ value }), error => ({ error }));
    await started;
    await f.expire();
    f.provider.setRefreshFailure({ error: "invalid_grant" });
    // A file request prepared before connect can still reach the shared token boundary.
    await expect(transport.fileAccessToken(await f.row())).rejects.toThrow("Sign in to this account again");
    expect((await f.row()).status).toBe("needs_auth");
    transport.discoverStdio = original;
    f.provider.setRefreshFailure(null);
    await f.authorize(f.id);
    const fresh = await f.row();
    release();
    expect(await old).toHaveProperty("error");
    expect((await f.row()).credentials).toEqual(fresh.credentials);
    expect((await f.row()).status).toBe("ready");
  } finally { release(); await f.close(); }
});

integration("concurrent refresh rejection persists once and pending sign-in survives stale requests", async () => {
  const f = await setup();
  try {
    await f.expire(); const before = await f.row();
    f.provider.setRefreshFailure({ error: "invalid_grant" });
    const calls = await Promise.allSettled([1, 2, 3].map(() => f.client.testPluginConnection(f.id, { toolName: "whoami", arguments: {} })));
    expect(calls.every(result => result.status === "rejected")).toBe(true);
    const failed = await f.row();
    expect(failed.status).toBe("needs_auth");
    expect(failed.runtimeGeneration).toBe(before.runtimeGeneration + 1);
    expect(await f.db.pluginActivity.count({ where: { connectionId: f.id, kind: "connection.auth_required" } })).toBe(1);
    await f.client.authenticatePlugin(f.id, true);
    const pending = await f.row();
    await expect((f.service as any).transport.fileAccessToken(pending)).rejects.toThrow("Complete sign-in");
    expect((await f.row()).credentials).toEqual(pending.credentials);
    expect((await f.row()).runtimeGeneration).toBe(pending.runtimeGeneration);
  } finally { await f.close(); }
});

integration("HTTP OAuth can explicitly reauthorize an error account and resume tools", async () => {
  const f = await setup(false);
  try {
    const old = await f.row();
    await f.db.pluginConnection.update({ where: { id: f.id }, data: { status: "error", statusMessage: "OAuth authorization failed" } });
    await f.authorize(f.id);
    expect((await f.row()).runtimeGeneration).toBeGreaterThan(old.runtimeGeneration);
    expect(JSON.stringify(await f.client.testPluginConnection(f.id, { toolName: "whoami", arguments: {} }))).toContain("Account A");
  } finally { await f.close(); }
});
