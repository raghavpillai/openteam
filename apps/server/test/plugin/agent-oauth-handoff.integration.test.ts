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
    const request = { callId, botId: crypto.randomUUID(), runId: crypto.randomUUID(), action: "AuthenticateMcpServer", arguments: { connectionId: connection.id, forceReauth: true }, origin: "user" as const };
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

test.skipIf(!databaseUrl)("signed-in UI cancels its own attempt but not another user's", async () => {
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
    const state = new URL(callback).searchParams.get("state")!;
    await expect(clientFor(f, sessions[1]).cancelPluginAuthentication(connection.id, state)).rejects.toMatchObject({ code: "plugin_oauth_session_changed" });
    expect(await rowFor(f, connection.id)).toEqual(pending);
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
