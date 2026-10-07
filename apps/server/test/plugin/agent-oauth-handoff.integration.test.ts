import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";
import { renderControlResult } from "@openteam/contracts/tool-results";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const sessions = ["fixture-phone", "fixture-laptop"];
const clientFor = (f: Awaited<ReturnType<typeof createPluginFlowFixture>>, session = sessions[0]!) =>
  createOpenTeamClient({ baseUrl: f.server.url.origin, getAuthToken: () => session });
const rowFor = (f: Awaited<ReturnType<typeof createPluginFlowFixture>>, id: string) =>
  f.db.pluginConnection.findUniqueOrThrow({ where: { id } });
const oauth = (row: Awaited<ReturnType<typeof rowFor>>) => (row.credentials as any).oauth;
async function approve(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  url.pathname = "/approve";
  const response = await fetch(url, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
  expect(response.status).toBe(302);
  return response.headers.get("location")!;
}
async function install(f: Awaited<ReturnType<typeof createPluginFlowFixture>>) {
  const client = clientFor(f);
  const key = f.definitions[0]!.key;
  await client.installPlugin(key);
  return (await client.pluginSettings()).installs.find(row => row.pluginKey === key)!.connections[0]!;
}

test.skipIf(!databaseUrl)("agent manual OAuth hands off without creating or replacing a session; signed-in UI completes", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "manual", authSessions: sessions });
  const callId = crypto.randomUUID();
  try {
    const connection = await install(f);
    const client = clientFor(f);
    const anonymous = createOpenTeamClient({ baseUrl: f.server.url.origin });
    await expect(anonymous.authenticatePlugin(connection.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(Effect.runPromise(f.service.authenticate(connection.id))).rejects.toThrow("signed-in session");
    const request = { callId, botId: crypto.randomUUID(), runId: crypto.randomUUID(), action: "AuthenticateMcpServer", arguments: { connectionId: connection.id, forceReauth: true } };
    const before = await rowFor(f, connection.id);
    const result = await f.service.requestAction(request) as any;
    expect(result.actionResult).toMatchObject({ connectionId: connection.id, status: "awaiting_user", requiresUserAction: true, accountLabel: "default", pluginId: connection.pluginKey });
    expect(result.actionResult.setupUrl).toBe(`openteam://app/v1/plugin/add?id=${encodeURIComponent(connection.pluginKey)}`);
    expect(result.actionResult.authorizationUrl).toBeUndefined();
    expect(renderControlResult("AuthenticateMcpServer", result, request.arguments)).toContain(result.actionResult.setupUrl);
    expect(await rowFor(f, connection.id)).toEqual(before);
    expect((await f.service.requestAction(request) as any).actionResult).toEqual(result.actionResult);

    const started = await client.authenticatePlugin(connection.id);
    const pending = await rowFor(f, connection.id);
    expect(oauth(pending).callbackSessionId).toBe(sessions[0]);
    // Even force_reauth from a later agent call must not steal a user's attempt.
    await Effect.runPromise(f.service.authenticateFromAgent(connection.id, true));
    expect(await rowFor(f, connection.id)).toEqual(pending);
    const callback = await approve(started.authorizationUrl);
    await expect(clientFor(f, sessions[1]).finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    await client.finishManualPluginAuthentication(connection.id, callback);
    const ready = await rowFor(f, connection.id);
    expect(ready.status).toBe("ready");
    expect(oauth(ready).tokens.refresh_token).toBeTruthy();
    await Effect.runPromise(f.service.authenticateFromAgent(connection.id, true));
    expect(await rowFor(f, connection.id)).toEqual(ready);
  } finally {
    await f.db.idempotencyRecord.deleteMany({ where: { scope: "plugin-action", key: callId } });
    await f.close();
  }
}, 20_000);

test.skipIf(!databaseUrl)("signed-in UI can discard a legacy orphan but cannot redeem it or cancel another user's attempt", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "manual", authSessions: sessions });
  try {
    const connection = await install(f);
    const client = clientFor(f);
    const other = await client.addPluginAccount(connection.id, "other");
    const otherId = (other as { id: string }).id;
    const otherStart = await client.authenticatePlugin(otherId);
    await client.finishManualPluginAuthentication(otherId, await approve(otherStart.authorizationUrl));
    const otherBefore = await rowFor(f, otherId);
    const started = await client.authenticatePlugin(connection.id);
    const callback = await approve(started.authorizationUrl);
    const pending = await rowFor(f, connection.id);
    await f.db.pluginConnection.update({ where: { id: connection.id }, data: {
      credentials: { ...(pending.credentials as object), oauth: { ...oauth(pending), callbackSessionId: null } },
    } });
    await expect(client.finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    const state = new URL(callback).searchParams.get("state")!;
    await expect(createOpenTeamClient({ baseUrl: f.server.url.origin }).cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(client.cancelPluginAuthentication(connection.id, "wrong-state")).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
    await client.cancelPluginAuthentication(connection.id, state);
    const cleared = await rowFor(f, connection.id);
    expect(cleared.runtimeGeneration).toBe(pending.runtimeGeneration + 1);
    for (const key of ["state", "stateGeneration", "stateCreatedAt", "codeVerifier", "authorizationUrl", "callbackSessionId", "callbackMode", "exchangeStarted"])
      expect(oauth(cleared)[key]).toBeUndefined();
    // The UI's Retry/Restart path must propagate its session too.
    await client.restartPluginConnection(connection.id);
    const fresh = (await client.pluginConnectionStatuses([connection.id])).connections[0]!;
    expect(oauth(await rowFor(f, connection.id)).callbackSessionId).toBe(sessions[0]);
    expect(fresh.authorizationUrl).not.toBe(started.authorizationUrl);
    await expect(client.finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
    await expect(client.cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
    const freshState = new URL(fresh.authorizationUrl!).searchParams.get("state")!;
    await expect(clientFor(f, sessions[1]).cancelPluginAuthentication(connection.id, freshState)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    await client.finishManualPluginAuthentication(connection.id, await approve(fresh.authorizationUrl!));
    expect((await rowFor(f, connection.id)).status).toBe("ready");
    expect(await rowFor(f, otherId)).toEqual(otherBefore);
  } finally { await f.close(); }
}, 20_000);

test.skipIf(!databaseUrl)("immediate replacement changes ownership and PKCE; stale cancellation cannot erase the new attempt", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "manual", authSessions: sessions });
  try {
    const connection = await install(f);
    const phone = clientFor(f);
    const laptop = clientFor(f, sessions[1]);
    const first = await phone.authenticatePlugin(connection.id);
    const callback = await approve(first.authorizationUrl);
    const before = await rowFor(f, connection.id);
    const state = new URL(callback).searchParams.get("state")!;
    const [replacement] = await Promise.allSettled([
      laptop.authenticatePlugin(connection.id, true),
      phone.cancelPluginAuthentication(connection.id, state),
    ]);
    // A generation conflict is safe; retry the explicit replacement if cancellation won.
    const fresh = replacement.status === "fulfilled" ? replacement.value : await laptop.authenticatePlugin(connection.id, true);
    const current = await rowFor(f, connection.id);
    expect(oauth(current).callbackSessionId).toBe(sessions[1]);
    expect(oauth(current).codeVerifier).not.toBe(oauth(before).codeVerifier);
    expect(oauth(current).state).not.toBe(state);
    await expect(phone.cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    await expect(laptop.finishManualPluginAuthentication(connection.id, callback)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
    expect(await rowFor(f, connection.id)).toEqual(current);
    await laptop.finishManualPluginAuthentication(connection.id, await approve(fresh.authorizationUrl));
    expect((await rowFor(f, connection.id)).status).toBe("ready");
  } finally { await f.close(); }
}, 20_000);

test.skipIf(!databaseUrl)("reset and cancellation cannot replace a claimed exchange, including a legacy orphan", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "manual", authSessions: sessions });
  try {
    const connection = await install(f);
    const client = clientFor(f);
    const started = await client.authenticatePlugin(connection.id);
    const row = await rowFor(f, connection.id);
    await f.db.pluginConnection.update({ where: { id: connection.id }, data: {
      credentials: { ...(row.credentials as object), oauth: { ...oauth(row), callbackSessionId: null, exchangeStarted: true } },
    } });
    const claimed = await rowFor(f, connection.id);
    await expect(client.authenticatePlugin(connection.id, true)).rejects.toMatchObject({ code: "plugin_oauth_in_progress" });
    await expect(client.cancelPluginAuthentication(connection.id, new URL(started.authorizationUrl).searchParams.get("state")!)).rejects.toMatchObject({ code: "plugin_oauth_state_invalid" });
    expect(await rowFor(f, connection.id)).toEqual(claimed);
    await f.db.pluginConnection.update({ where: { id: connection.id }, data: {
      credentials: { ...(claimed.credentials as object), oauth: { ...oauth(claimed), stateCreatedAt: Date.now() - 16 * 60_000 } },
    } });
    // A process crash during exchange must not strand the connection forever.
    const recovered = await client.authenticatePlugin(connection.id, true);
    await client.finishManualPluginAuthentication(connection.id, await approve(recovered.authorizationUrl));
    expect((await rowFor(f, connection.id)).status).toBe("ready");
  } finally { await f.close(); }
}, 20_000);

test.skipIf(!databaseUrl)("auth-disabled manual OAuth still supports direct agent initiation and completion", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "manual" });
  try {
    const connection = await install(f);
    const started = await Effect.runPromise(f.service.authenticateFromAgent(connection.id));
    if (!("authorizationUrl" in started)) throw new Error("Expected auth-disabled manual OAuth");
    expect(oauth(await rowFor(f, connection.id)).callbackSessionId).toBeNull();
    await clientFor(f).finishManualPluginAuthentication(connection.id, await approve(started.authorizationUrl));
    expect((await rowFor(f, connection.id)).status).toBe("ready");
  } finally { await f.close(); }
}, 20_000);

test.skipIf(!databaseUrl)("agent server OAuth still starts directly; desktop OAuth returns a UI handoff", async () => {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "server", authSessions: sessions });
  try {
    const connection = await install(f);
    const started = await Effect.runPromise(f.service.authenticateFromAgent(connection.id));
    expect("authorizationUrl" in started).toBe(true);
    if (!("authorizationUrl" in started)) throw new Error("Expected server callback");
    const response = await fetch(await approve(started.authorizationUrl));
    expect(response.ok).toBe(true);
    expect((await rowFor(f, connection.id)).status).toBe("ready");
    await clientFor(f).savePluginConfiguration(connection.id, { oauthCallbackMode: "desktop" });
    const before = await rowFor(f, connection.id);
    expect(await Effect.runPromise(f.service.authenticateFromAgent(connection.id))).toMatchObject({ requiresUserAction: true });
    expect(await rowFor(f, connection.id)).toEqual(before);
  } finally { await f.close(); }
}, 20_000);
