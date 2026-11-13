// OAuth sign-in through the real plugin routes, database and a local provider: manual and
// desktop callbacks, session binding, agent hand-off, and recovery from refresh failures.
import { expect } from "bun:test";
import { Effect } from "effect";
import { renderControlResult } from "@openteam/contracts/tool-results";
import { DesktopPluginOAuth, type PluginOAuthResult } from "../../../desktop/src/main/plugin-oauth";
import { MANUAL_OAUTH_REDIRECT } from "../../src/plugins/oauth-callback";
import { dbTest, databaseUrl } from "../harness";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";

type Flow = Awaited<ReturnType<typeof createPluginFlowFixture>>;
const flow = (options: Parameters<typeof createPluginFlowFixture>[1], body: (f: Flow) => Promise<void>) => async () => {
  const f = await createPluginFlowFixture(databaseUrl!, options);
  try { await body(f); } finally { await f.close(); }
};
const oauth = (row: { credentials: unknown }) => (row.credentials as any).oauth;
const whoami = async (f: Flow, id: string, session?: string) => JSON.stringify(await f.client(session).testPluginConnection(id, { toolName: "whoami", arguments: {} }));
/** Tokens are stored server-side only, then a forced expiry refreshes without any client. */
async function expectServerRefresh(f: Flow, id: string) {
  const credentials = (await f.row(id)).credentials as any;
  expect(credentials.oauth.tokens.refresh_token).toBeTruthy();
  expect(credentials.oauth.codeVerifier).toBeUndefined();
  expect(JSON.stringify(await f.client().pluginSettings())).not.toContain(credentials.oauth.tokens.refresh_token);
  await f.expireTokens(id);
  f.provider.expireTokens();
  await f.client().restartPluginConnection(id);
  expect(f.provider.observations.refreshes).toBeGreaterThan(0);
  expect(await whoami(f, id)).toContain("Account A");
}

// ---- Manual completion ----

dbTest("HTTP defaults to manual completion through the authenticated API and refreshes on the server", flow({ callbackMode: "auto" }, async f => {
  const client = f.client(), connection = await f.install();
  expect(connection).toMatchObject({ configured: true, setupPhase: "ready_to_authorize", oauthCallbackMode: "manual" });
  const started = await client.authenticatePlugin(connection.id);
  const auth = new URL(started.authorizationUrl);
  expect(auth.searchParams.get("redirect_uri")).toBe(MANUAL_OAUTH_REDIRECT);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect((await client.pluginConnectionStatuses([connection.id])).connections[0]).toMatchObject({ setupPhase: "authorization_pending", oauthCallbackMode: "manual" });
  const callback = await f.approve(started.authorizationUrl);
  const oversized = await fetch(`${f.server.url.origin}/api/v0/plugin-connections/${connection.id}/authenticate/manual`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callbackUrl: `${callback}&sensitive-marker=${"a".repeat(17_000)}` }),
  });
  expect(oversized.status).toBe(400);
  expect(await oversized.text()).not.toContain("sensitive-marker");
  expect((await fetch(`${f.server.url.origin}/api/v0/plugin-oauth/callback?${new URL(callback).searchParams}`)).status).toBe(400);
  await expect(client.finishManualPluginAuthentication(connection.id, callback.replace("state=", "state=wrong"))).rejects.toThrow("state");
  // A pasted callback without its scheme (as Safari copies it) completes exactly once.
  const safariCallback = callback.replace(/^http:\/\//, "");
  const completions = await Promise.allSettled([1, 2].map(() => client.finishManualPluginAuthentication(connection.id, safariCallback)));
  expect(completions.filter(result => result.status === "fulfilled")).toHaveLength(1);
  await expect(client.finishManualPluginAuthentication(connection.id, callback)).rejects.toThrow();
  expect((await client.pluginConnectionStatuses([connection.id])).connections[0]).toMatchObject({ status: "ready", setupPhase: "connected", authorizationUrl: null });
  await expectServerRefresh(f, connection.id);
}), 20_000);

dbTest("manual completion is session-bound, expires, rejects issuer mismatch, and handles cancellation", flow({ callbackMode: "auto" }, async f => {
  const client = f.client(), { id } = await f.install();
  const callback = await f.approve((await Effect.runPromise(f.service.authenticate(id, false, undefined, "phone"))).authorizationUrl);
  const finish = (url: string, session: string) => Effect.runPromise(f.service.finishManualAuthentication(id, url, session));
  await expect(finish(callback, "laptop")).rejects.toThrow("session");
  await expect(finish(`${callback}&iss=https%3A%2F%2Fwrong.test`, "phone")).rejects.toThrow("issuer");
  const credentials = (await f.row(id)).credentials as any;
  await f.db.pluginConnection.update({ where: { id }, data: { credentials: { ...credentials, oauth: { ...credentials.oauth, stateCreatedAt: Date.now() - 16 * 60_000 } } } });
  await expect(finish(callback, "phone")).rejects.toThrow("state");
  await client.finishManualPluginAuthentication(id, await f.approve((await client.authenticatePlugin(id)).authorizationUrl, "cancel"));
  expect((await client.pluginConnectionStatuses([id])).connections[0]).toMatchObject({ authorizationUrl: null, setupPhase: "ready_to_authorize" });
  const retry = await client.authenticatePlugin(id);
  await client.cancelPluginAuthentication(id, new URL(retry.authorizationUrl).searchParams.get("state")!);
  await expect(client.finishManualPluginAuthentication(id, await f.approve(retry.authorizationUrl))).rejects.toThrow();
}), 20_000);

// ---- Desktop loopback completion ----

dbTest("desktop listener → backend routes → provider → database completes and refreshes without desktop", flow({ callbackMode: "desktop" }, async f => {
  const client = f.client(), connection = await f.install();
  const results: PluginOAuthResult[] = [];
  const desktop = new DesktopPluginOAuth(result => results.push(result));
  const waitFor = async (count: number) => {
    for (const deadline = Date.now() + 5000; results.length < count && Date.now() < deadline;) await Bun.sleep(10);
    expect(results).toHaveLength(count);
  };
  try {
    const started = await desktop.start("backend-one", connection.id, client);
    expect(new URL(started.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(await f.approve(started.authorizationUrl));
    expect(callback.origin).not.toBe(f.server.url.origin);
    expect(callback.pathname).toBe("/callback");
    expect((await fetch(callback)).ok).toBe(true);
    await waitFor(1);
    expect(results[0]?.status).toBe("ready");
    desktop.closeAll();
    const row = await f.row(connection.id);
    expect(row.status).toBe("ready");
    expect(oauth(row).callbackSessionId).toBeUndefined();
    await expectServerRefresh(f, connection.id);
    await expect(fetch(callback)).rejects.toThrow();
    const restart = await desktop.start("backend-one", connection.id, client, true);
    await fetch(await f.approve(restart.authorizationUrl, "cancel"));
    await waitFor(2);
    expect(results[1]?.status).toBe("cancelled");
    expect((await client.pluginConnectionStatuses([connection.id])).connections[0]?.authorizationUrl).toBeNull();
  } finally { desktop.closeAll(); }
}), 20_000);

dbTest("desktop callback is bound to session/redirect/state; public callback cannot redeem it; duplicate completion claims once", flow({}, async f => {
  const connection = await f.install();
  const context = { redirectUrl: "http://127.0.0.1:54321/callback", sessionId: "session-A" };
  const callback = new URL(await f.approve((await Effect.runPromise(f.service.authenticate(connection.id, false, context))).authorizationUrl));
  const input = { redirectUrl: context.redirectUrl, state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")! };
  const finish = (overrides: Partial<typeof input> & { iss?: string } = {}, session = "session-A") => Effect.runPromise(f.service.finishDesktopAuthentication(connection.id, { ...input, ...overrides }, session));
  await expect(f.client().finishPluginAuthentication(connection.id, input)).rejects.toThrow("different session");
  await expect(finish({}, "session-B")).rejects.toThrow("different session");
  await expect(finish({ redirectUrl: "http://127.0.0.1:54322/callback" })).rejects.toThrow("different session");
  await expect(finish({ iss: "https://wrong.example" })).rejects.toThrow("issuer");
  await expect(finish({ state: "wrong" })).rejects.toThrow("state");
  const publicCallback = new URL(`${f.server.url.origin}/api/v0/plugin-oauth/callback`);
  publicCallback.search = new URLSearchParams({ connectionId: connection.id, code: input.code, state: input.state }).toString();
  expect((await fetch(publicCallback)).status).toBe(400);
  const completions = await Promise.allSettled([finish(), finish()]);
  expect(completions.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(f.provider.observations.authMethods).toHaveLength(1);
  await expect(finish()).rejects.toThrow();
}), 20_000);

// ---- Signed-in sessions and the agent ----

const sessions = ["fixture-phone", "fixture-laptop"];

dbTest("agent manual OAuth hands off without creating or replacing a session; signed-in UI completes", flow({ callbackMode: "manual", authSessions: sessions }, async f => {
  const callId = crypto.randomUUID();
  const connection = await f.install(), client = f.client(sessions[0]);
  try {
    await expect(f.client().authenticatePlugin(connection.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(Effect.runPromise(f.service.authenticate(connection.id))).rejects.toThrow("signed-in session");
    const request = { callId, botId: crypto.randomUUID(), runId: crypto.randomUUID(), action: "AuthenticateMcpServer", arguments: { connectionId: connection.id, forceReauth: true }, origin: "user" as const };
    const before = await f.row(connection.id);
    const result = await f.service.requestAction(request) as any;
    expect(result.actionResult).toMatchObject({ connectionId: connection.id, status: "awaiting_user", requiresUserAction: true, accountLabel: "default", pluginId: connection.pluginKey });
    expect(result.actionResult.setupUrl).toBe(`openteam://app/v1/plugin/add?id=${encodeURIComponent(connection.pluginKey)}`);
    expect(result.actionResult.authorizationUrl).toBeUndefined();
    expect(renderControlResult("AuthenticateMcpServer", result, request.arguments)).toContain(result.actionResult.setupUrl);
    expect(await f.row(connection.id)).toEqual(before);
    expect((await f.service.requestAction(request) as any).actionResult).toEqual(result.actionResult);
    const started = await client.authenticatePlugin(connection.id);
    const pending = await f.row(connection.id);
    expect(oauth(pending).callbackSessionId).toBe(sessions[0]);
    // Even force_reauth from a later agent call must not steal a user's attempt.
    await Effect.runPromise(f.service.authenticateFromAgent(connection.id, true));
    expect(await f.row(connection.id)).toEqual(pending);
    const callback = await f.approve(started.authorizationUrl);
    await expect(f.client(sessions[1]).finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    await client.finishManualPluginAuthentication(connection.id, callback);
    const ready = await f.row(connection.id);
    expect(ready.status).toBe("ready");
    expect(oauth(ready).tokens.refresh_token).toBeTruthy();
    await Effect.runPromise(f.service.authenticateFromAgent(connection.id, true));
    expect(await f.row(connection.id)).toEqual(ready);
  } finally { await f.db.idempotencyRecord.deleteMany({ where: { scope: "plugin-action", key: callId } }); }
}), 20_000);

dbTest("signed-in UI cancels its own attempt but not another user's", flow({ callbackMode: "manual", authSessions: sessions }, async f => {
  const connection = await f.install(), client = f.client(sessions[0]), laptop = f.client(sessions[1]);
  const otherId = (await client.addPluginAccount(connection.id, "other") as { id: string }).id;
  await client.finishManualPluginAuthentication(otherId, await f.approve((await client.authenticatePlugin(otherId)).authorizationUrl));
  const otherBefore = await f.row(otherId);
  const started = await client.authenticatePlugin(connection.id);
  const callback = await f.approve(started.authorizationUrl);
  const pending = await f.row(connection.id);
  const state = new URL(callback).searchParams.get("state")!;
  await expect(laptop.cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
  expect(await f.row(connection.id)).toEqual(pending);
  await expect(f.client().cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "unauthorized" });
  await expect(client.cancelPluginAuthentication(connection.id, "wrong-state")).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
  await client.cancelPluginAuthentication(connection.id, state);
  const cleared = await f.row(connection.id);
  expect(cleared.runtimeGeneration).toBe(pending.runtimeGeneration + 1);
  for (const key of ["state", "stateGeneration", "stateCreatedAt", "codeVerifier", "authorizationUrl", "callbackSessionId", "callbackMode", "exchangeStarted"]) expect(oauth(cleared)[key]).toBeUndefined();
  // The UI's Retry/Restart path must propagate its session too.
  await client.restartPluginConnection(connection.id);
  const fresh = (await client.pluginConnectionStatuses([connection.id])).connections[0]!;
  expect(oauth(await f.row(connection.id)).callbackSessionId).toBe(sessions[0]);
  expect(fresh.authorizationUrl).not.toBe(started.authorizationUrl);
  await expect(client.finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
  await expect(client.cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
  await expect(laptop.cancelPluginAuthentication(connection.id, new URL(fresh.authorizationUrl!).searchParams.get("state")!)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
  await client.finishManualPluginAuthentication(connection.id, await f.approve(fresh.authorizationUrl!));
  expect((await f.row(connection.id)).status).toBe("ready");
  expect(await f.row(otherId)).toEqual(otherBefore);
}), 20_000);

// ---- Recovery of a packaged connector's grant ----

/** A packaged connector with one signed-in account, its own client registered per account. */
const packaged = (body: (f: Flow & { id: string; configure(id: string): Promise<void>; authorize(id: string): Promise<void> }) => Promise<void>) =>
  flow({ packaged: true, authSessions: ["owner"], callbackMode: "manual" }, async f => {
    const client = f.client("owner");
    const configure = async (id: string) => {
      f.provider.registerClient(id, "http://127.0.0.1:42813/callback", "fixture-secret");
      await client.savePluginConfiguration(id, { values: { clientId: id }, secrets: { clientSecret: { action: "replace", value: "fixture-secret" } } });
    };
    const authorize = async (id: string) => client.finishManualPluginAuthentication(id, await f.approve((await client.authenticatePlugin(id, true)).authorizationUrl)).then(() => {});
    const { id } = await f.install("owner");
    await configure(id);
    await authorize(id);
    await body(Object.assign(f, { id, configure, authorize }));
  });

dbTest("a revoked packaged grant commits needs_auth regardless of its description and leaves other accounts alone", packaged(async f => {
  const botId = crypto.randomUUID(), runId = crypto.randomUUID(), conversationId = crypto.randomUUID();
  try {
    await f.db.bot.create({ data: { id: botId, name: "OAuth recovery fixture", defaultDirectory: "/tmp", status: "active", conversation: { create: { id: conversationId } } } });
    await f.db.run.create({ data: { id: runId, botId, conversationId, userMessageId: crypto.randomUUID(), status: "running" } });
    const second = await Effect.runPromise(f.service.addAccount(f.id, "other"));
    await f.configure(second.id); await f.authorize(second.id);
    const otherBefore = await f.row(second.id);
    await f.expireTokens(f.id);
    const before = await f.row(f.id);
    // A localized description that even echoes the client secret is not trusted or shown.
    f.provider.setRefreshFailure({ error: "invalid_grant", error_description: "Le jeton a expiré. fixture-secret" });
    const callId = crypto.randomUUID();
    await expect(f.service.invoke({ connectionId: f.id, botId, runId, callId, toolName: "whoami", arguments: {} })).rejects.toThrow();
    const failed = await f.row(f.id);
    expect(failed).toMatchObject({ status: "needs_auth", statusMessage: "Authorization expired or was revoked. Sign in to this account again.", runtimeGeneration: before.runtimeGeneration + 1 });
    expect(oauth(failed).tokens).toBeUndefined();
    expect((failed.credentials as any).clientSecret).toBe((before.credentials as any).clientSecret);
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).status).toBe("failed");
    for (let i = 0; i < 2; i++) await (f.service as any).refreshLocalConnections();
    expect((await f.row(f.id)).statusMessage).toBe(failed.statusMessage);
    expect((await f.row(second.id)).credentials).toEqual(otherBefore.credentials);
    expect(await whoami(f, second.id, "owner")).toContain("Account A");
    const client = f.client("owner");
    const staleCallback = await f.approve((await client.authenticatePlugin(f.id)).authorizationUrl);
    const fresh = await client.authenticatePlugin(f.id, true);
    await expect(client.finishManualPluginAuthentication(f.id, staleCallback)).rejects.toThrow();
    await expect(f.client("outsider").authenticatePlugin(f.id)).rejects.toThrow();
    f.provider.setRefreshFailure(null);
    await client.finishManualPluginAuthentication(f.id, await f.approve(fresh.authorizationUrl));
    expect((await f.row(f.id)).status).toBe("ready");
    expect(await whoami(f, f.id, "owner")).toContain("Account A");
  } finally { await f.db.bot.delete({ where: { id: botId } }); }
}), 20_000);

for (const failure of [{ error: "server_error", status: 503, error_description: "Provider unavailable" }, { error: "invalid_client", status: 401, error_description: "Client setup is wrong" }])
  dbTest(`non-grant failure preserves credentials: ${failure.error}`, packaged(async f => {
    await f.expireTokens(f.id);
    const before = await f.row(f.id);
    f.provider.setRefreshFailure(failure);
    await expect(f.client("owner").restartPluginConnection(f.id)).rejects.toThrow(failure.error_description);
    expect(await f.row(f.id)).toMatchObject({ status: "error", credentials: before.credentials });
    f.provider.setRefreshFailure(null);
    await f.client("owner").restartPluginConnection(f.id);
    expect((await f.row(f.id)).status).toBe("ready");
  }), 20_000);

dbTest("a stale successful connect cannot overwrite a rejected grant or a newer sign-in", packaged(async f => {
  const blocked = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const transport = (f.service as any).transport;
  const original = transport.discoverStdio.bind(transport);
  try {
    transport.discoverStdio = async (...args: unknown[]) => { const result = await original(...args); entered.resolve(); await blocked.promise; return result; };
    const old = Effect.runPromise(f.service.connect(f.id)).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await f.expireTokens(f.id);
    f.provider.setRefreshFailure({ error: "invalid_grant" });
    // A file request prepared before connect can still reach the shared token boundary.
    await expect(transport.fileAccessToken(await f.row(f.id))).rejects.toThrow("Sign in to this account again");
    expect((await f.row(f.id)).status).toBe("needs_auth");
    transport.discoverStdio = original;
    f.provider.setRefreshFailure(null);
    await f.authorize(f.id);
    const fresh = await f.row(f.id);
    blocked.resolve();
    expect(await old).toHaveProperty("error");
    expect(await f.row(f.id)).toMatchObject({ status: "ready", credentials: fresh.credentials });
  } finally { blocked.resolve(); }
}), 20_000);
