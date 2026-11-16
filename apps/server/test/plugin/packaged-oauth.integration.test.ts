import { expect } from "bun:test";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { dbIt } from "../harness";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

dbIt("packaged OAuth keeps account tokens isolated, serializes refresh, and passes only access tokens to the computer", async ({ db: prisma, onClose }) => {
  const fixture = createOAuthMcpFixture();
  const origin = fixture.server.url.origin;
  const definition = createPluginTemplate("packaged-mcp", `packaged-oauth-${crypto.randomUUID()}`);
  const connector = definition.connections[0]!;
  connector.auth = "oauth";
  connector.oauth = {
    clientType: "confidential", registration: "manual", tokenEndpointAuthMethod: "client_secret_post", shareClientCredentials: true,
    authorizationServer: { issuer: origin, authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token` }, accessTokenEnv: "PROVIDER_ACCESS_TOKEN",
  };
  connector.configuration = { oauthCallbackMode: "server", command: "bun", args: ["${PLUGIN_ROOT}/connector/server.mjs"] };
  definition.setup = {
    kind: "oauth_client", connectionKey: connector.key, title: "Connect", description: "Test", documentationUrl: null, steps: [], requiredScopes: ["read"],
    fields: [{ key: "clientId", label: "Client ID", required: true, secret: false }, { key: "clientSecret", label: "Client secret", required: true, secret: true }],
  };
  let draftId = "", discoveryFailure = false;
  const configurations: Array<Record<string, any>> = [];
  // The computer stub checks it only ever receives the access token, then calls the provider with it.
  const service = new PluginService(prisma, async (path, init) => {
    if (init?.method === "DELETE") return Response.json({});
    if (init?.method === "GET") return Response.json({ state: "stopped", tools: [] });
    const { configuration, toolName, arguments: args } = JSON.parse(String(init?.body));
    configurations.push(configuration);
    expect(Object.keys(configuration).sort()).toEqual(["args", "command", "env", "packageBinaryFiles", "packageFiles"]);
    expect(Object.keys(configuration.env)).toEqual(["PROVIDER_ACCESS_TOKEN", "OPENTEAM_PLUGIN_ACCOUNT_ID"]);
    expect(configuration.env.OPENTEAM_PLUGIN_ACCOUNT_ID).toBeTruthy();
    expect(JSON.stringify(configuration)).not.toContain("fixture-client-secret");
    if (path.endsWith("/discover") && discoveryFailure) throw new Error("Enable provider MCP access. fixture-client-secret");
    if (path.endsWith("/discover")) return Response.json({ tools: [{ name: "whoami", description: "Identity", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
    const response = await fetch(fixture.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${configuration.env.PROVIDER_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    });
    return Response.json({ result: (await response.json()).result });
  });
  onClose(async () => {
    await service.close(); fixture.close();
    await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
    if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
  });
  const run = <T>(effect: Effect.Effect<T, unknown>) => Effect.runPromise(effect);
  const row = (id: string) => prisma.pluginConnection.findUniqueOrThrow({ where: { id } });
  const read = async (id: string) => JSON.stringify(await run(service.testTool(id, { toolName: "whoami", arguments: {} })));
  const draft = await run(service.management.importFiles({ "plugin.json": JSON.stringify(definition) }));
  draftId = draft.id;
  await run(service.management.installDraft(draft.id));
  const first = await prisma.pluginConnection.findFirstOrThrow({ where: { installation: { pluginKey: definition.key } } });
  const desktop = { redirectUrl: "http://127.0.0.1:55432/callback", sessionId: "desktop-test-session" };
  const configure = async (id: string, basic = false, redirectUrl?: string) => {
    // The fixture registers a separate application per callback, as a real provider can do.
    fixture.registerClient(id, redirectUrl ?? (await run(service.configuration.get(id))).callbackUrl, "fixture-client-secret");
    // The compact desktop setup form previously submitted an empty scope.
    await run(service.configuration.save(id, { values: { clientId: id, scope: "  " }, secrets: { clientSecret: { action: "replace", value: "fixture-client-secret" } }, ...(basic ? { tokenEndpointAuthMethod: "client_secret_basic" as const } : {}) }));
    expect((await run(service.configuration.get(id))).values.scope).toBe("read");
  };
  const authorize = async (id: string, account: string, expectDiscoveryFailure = false, context?: typeof desktop) => {
    const url = new URL((await run(service.authenticate(id, false, context))).authorizationUrl);
    if (context) expect(url.searchParams.get("redirect_uri")).toBe(context.redirectUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read");
    url.pathname = "/approve";
    const callback = new URL((await fetch(url, { method: "POST", body: new URLSearchParams({ account }), redirect: "manual" })).headers.get("location")!);
    const code = callback.searchParams.get("code")!, state = callback.searchParams.get("state")!;
    await expect(run(service.finishAuthentication(id, code, "wrong", context))).rejects.toThrow("state");
    if (expectDiscoveryFailure) return expect(run(service.finishAuthentication(id, code, state, context))).rejects.toThrow("Enable provider MCP access");
    await run(service.finishAuthentication(id, code, state, context));
    await expect(run(service.finishAuthentication(id, code, state, context))).rejects.toThrow();
  };
  await configure(first.id, false, desktop.redirectUrl);
  await authorize(first.id, "Account A", false, desktop);
  const second = await run(service.addAccount(first.id, "second"));
  expect(((await row(second.id)).credentials as any).oauth?.tokens).toBeUndefined();
  await configure(second.id, true);
  await authorize(second.id, "Account B");
  expect(fixture.observations.authMethods).toEqual(expect.arrayContaining(["client_secret_basic", "client_secret_post"]));
  expect(await read(first.id)).toContain("Account A");
  expect(await read(second.id)).toContain("Account B");
  // Rollback uses the same compatible-package replacement path as an update.
  await prisma.pluginInstallation.update({ where: { pluginKey: definition.key }, data: { previousManifest: JSON.parse(JSON.stringify({ ...definition, version: "1.0.1" })) } });
  await run(service.management.update(definition.key, "", true));
  const updated = (await run(service.settings())).installs.find(entry => entry.pluginKey === definition.key)!;
  expect(updated.connections.every(account => account.setupPhase === "ready_to_connect")).toBe(true);
  await run(service.connect(first.id));
  await run(service.connect(second.id));
  expect(await read(first.id)).toContain("Account A");
  expect(await read(second.id)).toContain("Account B");
  // Concurrent reads behind an expired token share one refresh.
  const credentials = (await row(first.id)).credentials as any;
  await prisma.pluginConnection.update({ where: { id: first.id }, data: { credentials: { ...credentials, oauth: { ...credentials.oauth, tokensExpireAt: 1 } } } });
  const count = fixture.observations.refreshes;
  expect((await Promise.all([read(first.id), read(first.id), read(first.id)])).every(value => value.includes("Account A"))).toBe(true);
  expect(fixture.observations.refreshes - count).toBe(1);
  expect(await read(second.id)).toContain("Account B");
  const after = (await row(first.id)).credentials as any;
  expect(after.oauth.tokens.refresh_token).not.toBe(credentials.oauth.tokens.refresh_token);
  expect(after.oauth.tokensExpireAt).toBeGreaterThan(Date.now());
  discoveryFailure = true;
  await authorize(second.id, "Account B", true);
  const failed = await row(second.id);
  expect(failed.status).toBe("error");
  expect(failed.statusMessage).toContain("Enable provider MCP access");
  expect(failed.statusMessage).not.toContain("fixture-client-secret");
  discoveryFailure = false;
  await run(service.connect(second.id));
  expect(await read(second.id)).toContain("Account B");
  await run(service.disconnect(first.id));
  expect(JSON.stringify(await run(service.configuration.get(first.id)))).not.toContain("fixture-client-secret");
  expect(configurations.length).toBeGreaterThan(5);
}, 30_000);
