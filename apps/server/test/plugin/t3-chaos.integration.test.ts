import { expect, test } from "bun:test";
import { createOpenTeamClient } from "../../../../packages/client-core/src";
import { pluginCatalog } from "@openteam/plugins";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { createPluginFlowFixture } from "./fixtures/plugin-flow";
import { PluginService } from "../../src/services/plugin-service";
import { Effect } from "effect";
import { recover } from "../../src/services/startup-recovery";
import { InternalToolService } from "../../src/services/internal-tool-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);

async function setup(refreshTokens = false) {
  const f = await createPluginFlowFixture(databaseUrl!, { callbackMode: "server", refreshTokens });
  const plugin = structuredClone(pluginCatalog.find(plugin => plugin.key === "t3-code")!);
  plugin.key = `t3-chaos-${crypto.randomUUID()}`;
  plugin.connections[0]!.configuration = { ...plugin.connections[0]!.configuration, oauthCallbackMode: "server" };
  f.definitions.push(plugin);
  const client = createOpenTeamClient({ baseUrl: f.server.url.origin });
  await client.installPlugin(plugin.key);
  const id = (await client.pluginSettings()).installs.find(p => p.pluginKey === plugin.key)!.connections[0]!.id;
  await client.savePluginConfiguration(id, { values: { mcpUrl: f.provider.endpoint } });
  const approve = async (authorizationUrl: string) => {
    const url = new URL(authorizationUrl); url.pathname = "/approve";
    const response = await fetch(url, { method: "POST", body: new URLSearchParams({ account: "Account A" }), redirect: "manual" });
    return response.headers.get("location")!;
  };
  const authorize = async () => {
    const start = await client.authenticatePlugin(id, true);
    expect((await fetch(await approve(start.authorizationUrl))).ok).toBe(true);
  };
  await authorize();
  return { ...f, client, id, approve, authorize,
    row: () => f.db.pluginConnection.findUniqueOrThrow({ where: { id } }),
    call: () => client.testPluginConnection(id, { toolName: "whoami", arguments: {} }),
  };
}

function freshHost(f: Awaited<ReturnType<typeof setup>>) {
  const previous = process.env.OPENTEAM_PUBLIC_URL;
  process.env.OPENTEAM_PUBLIC_URL = f.server.url.origin;
  let service: PluginService;
  try { service = new PluginService(f.db); }
  finally {
    if (previous === undefined) delete process.env.OPENTEAM_PUBLIC_URL;
    else process.env.OPENTEAM_PUBLIC_URL = previous;
  }
  Object.assign(service, {
    catalog: async () => f.definitions,
    definition: async (key: string) => f.definitions.find(plugin => plugin.key === key),
  });
  return service;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

integration("revoked no-refresh grants require explicit sign-in and recover without an orphan OAuth attempt", async () => {
  const f = await setup();
  try {
    const before = await f.row();
    const callsBefore = f.provider.observations.calls;
    f.provider.expireTokens();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => f.call()));
    expect(outcomes.every(result => result.status === "rejected")).toBe(true);
    const failed = await f.row();
    expect(failed.status).toBe("needs_auth");
    expect(failed.runtimeGeneration).toBe(before.runtimeGeneration + 1);
    const oauth = (failed.credentials as any).oauth;
    expect(oauth.tokens).toBeUndefined();
    expect(oauth.codeVerifier).toBeUndefined();
    expect(oauth.authorizationUrl).toBeUndefined();
    expect(oauth.state).toBeUndefined();
    expect(f.provider.observations.calls).toBe(callsBefore);
    expect(await f.db.pluginActivity.count({ where: { connectionId: f.id, kind: "connection.auth_required" } })).toBe(1);
    await f.authorize();
    expect((await f.row()).status).toBe("ready");
    expect(JSON.stringify(await f.call())).toContain("Account A");
  } finally { await f.close(); }
}, 20_000);

integration("temporary MCP outages preserve the grant and recover without signing in again", async () => {
  const f = await setup();
  try {
    const before = await f.row();
    f.provider.setUnavailable(true);
    await expect(f.call()).rejects.toThrow();
    expect((await f.row()).credentials).toEqual(before.credentials);
    expect((await f.row()).runtimeGeneration).toBe(before.runtimeGeneration);
    f.provider.setUnavailable(false);
    expect(JSON.stringify(await f.call())).toContain("Account A");
  } finally { await f.close(); }
});

integration("temporary refresh-server failure preserves a remote grant and a later retry refreshes successfully", async () => {
  const f = await setup(true);
  try {
    const before = await f.row();
    f.provider.expireTokens();
    f.provider.setRefreshFailure({ error: "server_error", status: 503 });
    await expect(f.call()).rejects.toThrow();
    expect((await f.row()).credentials).toEqual(before.credentials);
    expect((await f.row()).status).toBe("ready");
    f.provider.setRefreshFailure(null);
    expect(JSON.stringify(await f.call())).toContain("Account A");
    expect(f.provider.observations.refreshes).toBe(1);
  } finally { await f.close(); }
});

integration("a rejected remote refresh grant becomes needs_auth instead of silently restarting OAuth", async () => {
  const f = await setup(true);
  try {
    f.provider.expireTokens();
    f.provider.setRefreshFailure({ error: "invalid_grant" });
    await f.db.pluginConnection.update({ where: { id: f.id }, data: { status: "error" } });
    await expect(f.client.restartPluginConnection(f.id)).rejects.toThrow();
    expect((await f.row()).status).toBe("needs_auth");
    expect((await f.row()).credentials).toMatchObject({ oauth: { clientInformation: { client_id: expect.any(String) } } });
    expect((await f.row()).credentials as any).not.toHaveProperty("oauth.tokens");
  } finally { await f.close(); }
});

integration("an authorization callback cannot restore a disconnected account", async () => {
  const f = await setup();
  try {
    const start = await f.client.authenticatePlugin(f.id, true);
    const callback = await f.approve(start.authorizationUrl);
    await f.client.disconnectPlugin(f.id);
    const disconnected = await f.row();
    expect((await fetch(callback)).ok).toBe(false);
    const after = await f.row();
    expect(after.status).toBe("disconnected");
    expect(after.runtimeGeneration).toBe(disconnected.runtimeGeneration);
    expect(after.credentials).toEqual(disconnected.credentials);
    await expect(f.call()).rejects.toThrow();
  } finally { await f.close(); }
});

integration("a stale authorization failure cannot erase a newer successful sign-in", async () => {
  const f = await setup();
  try {
    const stale = await f.row();
    await f.authorize();
    const fresh = await f.row();
    await expect((f.service as any).transport.recoverHttpAuthorization(stale, new UnauthorizedError())).rejects.toMatchObject({ code: "plugin_connection_changed" });
    expect((await f.row()).credentials).toEqual(fresh.credentials);
    expect((await f.row()).runtimeGeneration).toBe(fresh.runtimeGeneration);
    expect((await f.row()).status).toBe("ready");
    expect(JSON.stringify(await f.call())).toContain("Account A");
  } finally { await f.close(); }
});

integration("a late tools-changed callback cannot overwrite a newer account generation", async () => {
  const f = await setup();
  try {
    const stale = await f.row();
    await f.authorize();
    const fresh = await f.row();
    await (f.service as any).http.onToolsChanged(f.id, [
      { name: "obsolete-tool", description: "Old session", inputSchema: { type: "object" }, risk: "read" },
    ], { endpoint: f.provider.endpoint, runtimeGeneration: stale.runtimeGeneration });
    expect((await f.row()).toolSnapshot).toEqual(fresh.toolSnapshot);
    expect((await f.row()).runtimeGeneration).toBe(fresh.runtimeGeneration);
  } finally { await f.close(); }
});

integration("a revoked grant fails an agent invocation without dispatching the tool", async () => {
  const f = await setup();
  const bot = await f.db.bot.create({ data: {
    name: "T3 chaos invocation", defaultDirectory: "/tmp", status: "active", conversation: { create: {} },
  }, include: { conversation: true } });
  try {
    const run = await f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } });
    const callsBefore = f.provider.observations.calls;
    f.provider.expireTokens();
    const callId = crypto.randomUUID();
    await expect(f.service.invoke({ connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} })).rejects.toThrow();
    expect((await f.row()).status).toBe("needs_auth");
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).status).toBe("failed");
    expect(f.provider.observations.calls).toBe(callsBefore);
  } finally { await f.db.bot.delete({ where: { id: bot.id } }); await f.close(); }
});

integration("a provider error echoing a credential cannot expose it through the settings API", async () => {
  const f = await setup();
  try {
    const token = (await f.row()).credentials as any;
    const secret = token.oauth.tokens.access_token;
    f.provider.setToolFailure({ status: 503, body: `Provider diagnostic accidentally echoed ${secret}` });
    const error = await f.call().then(() => null, error => error);
    expect(error).not.toBeNull();
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("[redacted]");
  } finally { await f.close(); }
});

integration("an error after token refresh redacts the newly issued credential", async () => {
  const f = await setup(true);
  try {
    const before = (await f.row()).credentials as any;
    f.provider.expireTokens();
    f.provider.setToolFailure({ status: 503, body: "Diagnostic: ${accessToken}" });
    const error = await f.call().then(() => null, error => error);
    const after = (await f.row()).credentials as any;
    expect(after.oauth.tokens.access_token).not.toBe(before.oauth.tokens.access_token);
    expect(String(error)).not.toContain(after.oauth.tokens.access_token);
    expect(String(error)).toContain("[redacted]");
  } finally { await f.close(); }
});

integration("provider errors are redacted before they enter invocation history", async () => {
  const f = await setup();
  const bot = await f.db.bot.create({ data: {
    name: "T3 diagnostic fixture", defaultDirectory: "/tmp", status: "active", conversation: { create: {} },
  }, include: { conversation: true } });
  try {
    const run = await f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } });
    const credentials = (await f.row()).credentials as any;
    f.provider.setToolFailure({ status: 503, body: "Diagnostic: ${accessToken}" });
    const callId = crypto.randomUUID();
    const error = await f.service.invoke({ connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} }).then(() => null, error => error);
    const saved = await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("[redacted]");
    expect(saved.error).not.toContain(credentials.oauth.tokens.access_token);
    expect(String(error)).not.toContain(credentials.oauth.tokens.access_token);
  } finally { await f.db.bot.delete({ where: { id: bot.id } }); await f.close(); }
});

integration("a browser callback survives replacement of the host service", async () => {
  const f = await setup();
  let fresh: PluginService | undefined;
  try {
    const started = await f.client.authenticatePlugin(f.id, true);
    const callback = new URL(await f.approve(started.authorizationUrl));
    await f.service.close();
    fresh = freshHost(f);
    await Effect.runPromise(fresh.finishAuthentication(f.id, callback.searchParams.get("code")!, callback.searchParams.get("state")!));
    expect((await f.row()).status).toBe("ready");
    expect(JSON.stringify(await Effect.runPromise(fresh.testTool(f.id, { toolName: "whoami", arguments: {} })))).toContain("Account A");
  } finally { await fresh?.close(); await f.close(); }
});

integration("a host interruption after token persistence can recover discovery without another sign-in", async () => {
  const f = await setup();
  let fresh: PluginService | undefined;
  try {
    const started = await f.client.authenticatePlugin(f.id, true);
    const callback = new URL(await f.approve(started.authorizationUrl));
    (f.service as any).markReady = async () => { throw new Error("Injected host interruption before ready"); };
    await expect(Effect.runPromise(f.service.finishAuthentication(f.id, callback.searchParams.get("code")!, callback.searchParams.get("state")!))).rejects.toThrow("Injected host interruption");
    const interrupted = await f.row();
    expect(interrupted.status).toBe("needs_auth");
    expect((interrupted.credentials as any).oauth.tokens.access_token).toBeString();
    const exchanges = f.provider.observations.authMethods.length;
    await f.service.close();
    fresh = freshHost(f);
    await Effect.runPromise(fresh.connect(f.id));
    expect((await f.row()).status).toBe("ready");
    expect(f.provider.observations.authMethods).toHaveLength(exchanges);
    expect(JSON.stringify(await Effect.runPromise(fresh.testTool(f.id, { toolName: "whoami", arguments: {} })))).toContain("Account A");
  } finally { await fresh?.close(); await f.close(); }
});

integration("duplicate browser callbacks redeem a one-time code only once", async () => {
  const f = await setup();
  try {
    const start = await f.client.authenticatePlugin(f.id, true);
    const callback = await f.approve(start.authorizationUrl);
    const before = f.provider.observations.authMethods.length;
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(callback)));
    expect(responses.filter(response => response.ok)).toHaveLength(1);
    expect(f.provider.observations.authMethods).toHaveLength(before + 1);
    expect((await f.row()).status).toBe("ready");
  } finally { await f.close(); }
});

integration("disconnect after call preparation prevents later credential use and tool dispatch", async () => {
  const f = await setup();
  const entered = gate(), release = gate();
  const http = (f.service as any).http;
  const original = http.call.bind(http);
  http.call = async (...args: unknown[]) => { entered.release(); await release.promise; return original(...args); };
  const before = f.provider.observations.calls;
  const pending = f.call().then(() => "executed", () => "revoked");
  try {
    await entered.promise;
    await f.client.disconnectPlugin(f.id);
    release.release();
    expect(await pending).toBe("revoked");
    expect(f.provider.observations.calls).toBe(before);
    expect((await f.row()).status).toBe("disconnected");
  } finally { release.release(); await pending; await f.close(); }
});

integration("an endpoint change after call preparation cannot send the call to the previous environment", async () => {
  const f = await setup();
  const entered = gate(), release = gate();
  const http = (f.service as any).http;
  const original = http.call.bind(http);
  http.call = async (...args: unknown[]) => { entered.release(); await release.promise; return original(...args); };
  const before = f.provider.observations.calls;
  const pending = f.call().then(() => "executed", () => "changed");
  try {
    await entered.promise;
    await f.client.savePluginConfiguration(f.id, { values: { mcpUrl: `${f.provider.endpoint}?environment=next` } });
    release.release();
    expect(await pending).toBe("changed");
    expect(f.provider.observations.calls).toBe(before);
    expect((await f.row()).status).toBe("disconnected");
  } finally { release.release(); await pending; await f.close(); }
});

for (const mutation of ["unavailable", "remove_tool", "uninstall", "reauthorize"] as const) {
  integration(`a prepared call respects a later ${mutation}`, async () => {
    const f = await setup();
    const entered = gate(), release = gate();
    const http = (f.service as any).http;
    const original = http.call.bind(http);
    http.call = async (...args: unknown[]) => { entered.release(); await release.promise; return original(...args); };
    const before = f.provider.observations.calls;
    const pending = f.call().then(() => null, error => error);
    try {
      await entered.promise;
      const row = await f.row();
      if (mutation === "unavailable") await f.db.pluginInstallation.update({ where: { id: row.installationId }, data: { status: "error" } });
      if (mutation === "remove_tool") await f.db.pluginConnection.update({ where: { id: f.id }, data: { toolSnapshot: [] } });
      if (mutation === "uninstall") {
        const install = await f.db.pluginInstallation.findUniqueOrThrow({ where: { id: row.installationId } });
        await f.client.uninstallPlugin(install.pluginKey);
      }
      if (mutation === "reauthorize") await f.authorize();
      release.release();
      expect(await pending).not.toBeNull();
      expect(f.provider.observations.calls).toBe(before);
      if (mutation === "reauthorize") {
        expect((await f.row()).status).toBe("ready");
        expect(JSON.stringify(await f.call())).toContain("Account A");
      }
    } finally { release.release(); await pending; await f.close(); }
  });
}

integration("SIGKILL after remote acceptance settles the local invocation as an unknown outcome without replay", async () => {
  const f = await setup();
  const entered = gate(), release = gate();
  const bot = await f.db.bot.create({ data: {
    name: "T3 killed host", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
  }, include: { conversation: true } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const run = await f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } });
    const callId = crypto.randomUUID();
    await f.db.pluginInvocation.create({ data: {
      callId: `${callId}:completed`, connectionId: f.id, botId: bot.id, runId: run.id,
      toolName: "whoami", status: "completed", result: { verified: true }, completedAt: new Date(),
    } });
    f.provider.setBeforeToolReply(async () => { entered.release(); await release.promise; });
    await f.service.close();
    child = Bun.spawn([process.execPath, new URL("./fixtures/invoke-child.ts", import.meta.url).pathname, f.id, bot.id, run.id, callId], {
      env: { ...process.env, OPENTEAM_TEST_DATABASE_URL: databaseUrl! }, stdout: "ignore", stderr: "pipe",
    });
    const reached = await Promise.race([
      entered.promise.then(() => "accepted"),
      child.exited.then(async () => {
        const stderr = child!.stderr;
        throw new Error(`Invocation child exited early: ${typeof stderr === "object" ? await new Response(stderr).text() : "No diagnostics"}`);
      }),
    ]);
    expect(reached).toBe("accepted");
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).error).toBe("Executing");
    child.kill("SIGKILL"); await child.exited;
    release.release();
    const messaging = { enqueueWake: async () => {}, enqueueBootstrap: async () => {}, recoverRounds: async () => {} };
    await recover(f.db, { send: async () => {} } as never, messaging as never, async () => new Response());
    const receipt = await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
    expect(receipt.status).toBe("failed");
    expect(receipt.error).toContain("may have completed remotely");
    expect(receipt.completedAt).not.toBeNull();
    expect((await f.db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("interrupted");
    await recover(f.db, { send: async () => {} } as never, messaging as never, async () => new Response());
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).completedAt).toEqual(receipt.completedAt);
    expect(await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId: `${callId}:completed` } }))
      .toMatchObject({ status: "completed", result: { verified: true } });
    await expect(f.service.invoke({ connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} }))
      .rejects.toMatchObject({ code: "plugin_call_outcome_unknown" });
    expect(f.provider.observations.calls).toBe(1);
  } finally {
    release.release();
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await f.db.bot.deleteMany({ where: { id: bot.id } });
    await f.close();
  }
}, 15_000);

integration("cancellation reaches an in-flight HTTP invocation through the plugin service", async () => {
  const f = await setup();
  const entered = gate(), release = gate();
  const bot = await f.db.bot.create({ data: {
    name: "T3 cancelled invocation", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
  }, include: { conversation: true } });
  const controller = new AbortController();
  let pending: Promise<string> | undefined;
  try {
    const run = await f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } });
    const callId = crypto.randomUUID();
    f.provider.setBeforeToolReply(async () => { entered.release(); await release.promise; });
    pending = f.service.invoke({ connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} }, controller.signal)
      .then(() => "completed", () => "cancelled");
    await entered.promise;
    controller.abort();
    expect(await Promise.race([pending, Bun.sleep(500).then(() => "blocked")])).toBe("cancelled");
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).status).toBe("failed");
    expect(f.provider.observations.calls).toBe(1);
  } finally {
    release.release(); await pending;
    await f.db.bot.deleteMany({ where: { id: bot.id } }); await f.close();
  }
});

integration("HTTP disconnect cancellation propagates through the real internal tool and plugin services", async () => {
  const f = await setup();
  const entered = gate(), release = gate(), settled = gate();
  const bot = await f.db.bot.create({ data: {
    name: "T3 HTTP cancellation", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
  }, include: { conversation: true } });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const run = await f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } });
    const callId = crypto.randomUUID();
    const plugins = Object.create(f.service) as PluginService;
    plugins.invoke = (...args) => f.service.invoke(...args).finally(settled.release);
    const internal = new InternalToolService(f.db, {} as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins);
    f.provider.setBeforeToolReply(async () => { entered.release(); await release.promise; });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        // Same request/Effect cancellation adapter as main.ts's dynamic-tool route.
        return Response.json(await Effect.runPromise(internal.execute(await request.json()), { signal: request.signal }));
      } catch { return new Response(null, { status: 499 }); }
    } });
    const controller = new AbortController();
    const response = fetch(server.url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ runId: run.id, botId: bot.id, conversationId: bot.conversation!.id, channelId: null, deliveryId: null,
        callId, tool: "PluginCall", arguments: { connectionId: f.id, toolName: "whoami", arguments: {} } }),
    }).then(() => "responded", () => "aborted");
    await entered.promise;
    controller.abort();
    expect(await response).toBe("aborted");
    expect(await Promise.race([settled.promise.then(() => "cancelled"), Bun.sleep(1000).then(() => "blocked")])).toBe("cancelled");
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } })).status).toBe("failed");
    expect(f.provider.observations.calls).toBe(1);
  } finally {
    release.release(); server?.stop(true);
    await f.db.bot.deleteMany({ where: { id: bot.id } }); await f.close();
  }
});

for (const failure of ["before_commit", "after_commit"] as const) {
  integration(`result persistence failure ${failure} cannot replay or erase the remote outcome`, async () => {
    const f = await setup();
    const bot = await f.db.bot.create({ data: {
      name: "T3 persistence failure", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
    }, include: { conversation: true } });
    const transaction = f.db.$transaction.bind(f.db);
    let injected = false;
    try {
      const run = await f.db.run.create({ data: {
        botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
      } });
      const callId = crypto.randomUUID();
      const request = { connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} };
      const before = f.provider.observations.calls;
      (f.db as any).$transaction = async (...args: unknown[]) => {
        if (!injected && typeof args[0] === "function" && f.provider.observations.calls > before) {
          injected = true;
          if (failure === "after_commit") await (transaction as any)(...args);
          throw new Error("Injected lost database commit acknowledgement");
        }
        return (transaction as any)(...args);
      };
      const outcome = await f.service.invoke(request).then(result => ({ result }), error => ({ error }));
      expect(injected).toBe(true);
      const receipt = await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
      if (failure === "after_commit") {
        expect(receipt.status).toBe("completed");
        expect(JSON.stringify(outcome)).toContain("Account A");
        expect(JSON.stringify(await f.service.invoke(request))).toContain("Account A");
      } else {
        expect(outcome).toMatchObject({ error: { code: "plugin_call_outcome_unknown" } });
        expect(receipt.status).toBe("failed");
        expect(receipt.error).toContain("may have completed remotely");
        await expect(f.service.invoke(request)).rejects.toMatchObject({ code: "plugin_call_outcome_unknown" });
      }
      expect(f.provider.observations.calls).toBe(before + 1);
    } finally {
      (f.db as any).$transaction = transaction;
      await f.db.bot.deleteMany({ where: { id: bot.id } }); await f.close();
    }
  });
}

integration("a removed invocation cannot overwrite a replacement that reuses its call ID", async () => {
  const f = await setup();
  const entered = gate(), release = gate();
  const bot = await f.db.bot.create({ data: {
    name: "T3 receipt isolation", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
  }, include: { conversation: true } });
  let pending: Promise<unknown> | undefined;
  try {
    const runs = await Promise.all([0, 1].map(() => f.db.run.create({ data: {
      botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
    } })));
    const callId = crypto.randomUUID();
    f.provider.setBeforeToolReply(async () => { entered.release(); await release.promise; });
    pending = f.service.invoke({ connectionId: f.id, botId: bot.id, runId: runs[0]!.id, callId, toolName: "whoami", arguments: {} })
      .then(result => ({ result }), error => ({ error }));
    await entered.promise;
    const original = await f.db.pluginInvocation.findUniqueOrThrow({ where: { callId } });
    await f.db.pluginInvocation.delete({ where: { id: original.id } });
    const replacement = await f.db.pluginInvocation.create({ data: {
      callId, connectionId: f.id, botId: bot.id, runId: runs[1]!.id, toolName: "whoami",
      status: "completed", result: { marker: "other-run-receipt" }, completedAt: new Date(),
    } });
    release.release();
    expect(await pending).toMatchObject({ error: { code: "plugin_call_outcome_unknown" } });
    expect((await f.db.pluginInvocation.findUniqueOrThrow({ where: { id: replacement.id } })).result)
      .toEqual({ marker: "other-run-receipt" });
    expect(f.provider.observations.calls).toBe(1);
  } finally {
    release.release(); await pending;
    await f.db.bot.deleteMany({ where: { id: bot.id } }); await f.close();
  }
});

for (const phase of ["verifier", "tokens"] as const) {
  integration(`a failed ${phase} write cannot expose credentials that were never persisted`, async () => {
    const f = await setup();
    const transaction = f.db.$transaction.bind(f.db);
    let captured = "";
    let callback: URL | undefined;
    try {
      if (phase === "tokens") {
        const start = await f.client.authenticatePlugin(f.id, true);
        callback = new URL(await f.approve(start.authorizationUrl));
      }
      (f.db as any).$transaction = (operation: unknown, ...rest: unknown[]) => {
        if (typeof operation !== "function") return (transaction as any)(operation, ...rest);
        return (transaction as any)(async (tx: any) => operation(new Proxy(tx, { get(target, key) {
          if (key !== "pluginConnection") return Reflect.get(target, key);
          return new Proxy(target.pluginConnection, { get(delegate, method) {
            if (method !== "update") return Reflect.get(delegate, method);
            return (args: any) => {
              const oauth = args.data?.credentials?.oauth;
              const secret = phase === "tokens" ? oauth?.tokens?.access_token : oauth?.codeVerifier;
              if (secret && !captured) {
                captured = secret;
                throw new Error(`Injected persistence diagnostic containing ${secret}`);
              }
              return delegate.update(args);
            };
          } });
        } })), ...rest);
      };
      const operation = phase === "verifier"
        ? Effect.runPromise(f.service.authenticate(f.id, true))
        : Effect.runPromise(f.service.finishAuthentication(f.id, callback!.searchParams.get("code")!, callback!.searchParams.get("state")!));
      const error = await operation.then(() => null, error => error);
      expect(captured.length).toBeGreaterThan(4);
      expect(error).not.toBeNull();
      expect(String(error)).not.toContain(captured);
      expect((await f.row()).statusMessage).not.toContain(captured);
      expect(JSON.stringify(await f.client.pluginSettings())).not.toContain(captured);
    } finally {
      (f.db as any).$transaction = transaction;
      await f.close();
    }
  });
}

for (const action of ["reset_last_account", "remove_sibling_account", "uninstall"] as const) {
  integration(`active invocation cleanup during ${action} settles without replay or storage errors`, async () => {
    const f = await setup();
    const entered = gate(), release = gate();
    const bot = await f.db.bot.create({ data: {
      name: "T3 active cleanup", defaultDirectory: "/tmp", status: "active", onboardingStatus: "completed", conversation: { create: {} },
    }, include: { conversation: true } });
    let pending: Promise<unknown> | undefined;
    try {
      const run = await f.db.run.create({ data: {
        botId: bot.id, conversationId: bot.conversation!.id, userMessageId: crypto.randomUUID(), status: "running",
      } });
      if (action === "remove_sibling_account") await f.client.addPluginAccount(f.id, "other");
      const row = await f.row();
      const callId = crypto.randomUUID();
      const request = { connectionId: f.id, botId: bot.id, runId: run.id, callId, toolName: "whoami", arguments: {} };
      f.provider.setBeforeToolReply(async () => { entered.release(); await release.promise; });
      pending = f.service.invoke(request).then(() => null, error => error);
      await entered.promise;
      if (action === "uninstall") {
        const install = await f.db.pluginInstallation.findUniqueOrThrow({ where: { id: row.installationId } });
        await f.client.uninstallPlugin(install.pluginKey);
      } else await f.client.removePluginAccount(f.id);
      const error = await Promise.race([pending, Bun.sleep(1000).then(() => "blocked")]);
      expect(error).not.toBeNull();
      expect(error).not.toBe("blocked");
      expect(String(error)).not.toContain("P2025");
      expect(String(error)).not.toContain("PrismaClient");
      await expect(f.service.invoke(request)).rejects.toThrow();
      expect(f.provider.observations.calls).toBe(1);
      if (action === "reset_last_account") {
        expect((await f.row()).credentials).toEqual({});
        expect((await f.row()).status).toBe("needs_auth");
      } else expect(await f.db.pluginConnection.findUnique({ where: { id: f.id } })).toBeNull();
    } finally {
      release.release(); await pending;
      await f.db.bot.deleteMany({ where: { id: bot.id } }); await f.close();
    }
  });
}
