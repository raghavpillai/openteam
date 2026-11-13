import { expect } from "bun:test";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { dbIt } from "../harness";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

dbIt("OAuth lifecycle covers DCR, PKCE, independent accounts, cancellation and live tool changes", async ({ db: prisma, onClose }) => {
  const service = new PluginService(prisma), fixture = createOAuthMcpFixture();
  let key = "";
  onClose(async () => { await service.close(); fixture.close(); if (key) await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } }); });
  const run = <T>(effect: Effect.Effect<T, unknown>) => Effect.runPromise(effect);
  const row = (id: string) => prisma.pluginConnection.findUniqueOrThrow({ where: { id } });
  const whoami = async (id: string) => JSON.stringify(await run(service.testTool(id, { toolName: "whoami", arguments: {} })));
  const authorize = async (id: string, account = "Account A") => {
    const approval = new URL((await run(service.authenticate(id))).authorizationUrl);
    approval.pathname = "/approve";
    const callback = new URL((await fetch(approval, { method: "POST", body: new URLSearchParams({ account }), redirect: "manual" })).headers.get("location")!);
    const code = callback.searchParams.get("code")!, state = callback.searchParams.get("state")!;
    if (account === "cancel") return run(service.cancelAuthentication(id, state));
    await expect(run(service.finishAuthentication(id, code, "wrong-state"))).rejects.toThrow("state");
    return run(service.finishAuthentication(id, code, state));
  };
  const added = await run(service.addCustomMcp({ name: "OAuth fixture", url: fixture.endpoint, auth: "oauth" }));
  key = added.pluginKey;
  await run(service.configuration.save(added.connectionId, { oauthCallbackMode: "server" }));
  await authorize(added.connectionId);
  let connection = await row(added.connectionId);
  expect(connection.status).toBe("ready");
  expect((connection.toolSnapshot as Array<{ name: string }>).map(tool => tool.name)).toEqual(["echo", "whoami"]);
  expect((connection.credentials as { oauth: { state?: string } }).oauth.state).toBeUndefined();
  expect(await whoami(added.connectionId)).toContain("Account A");
  // A second account signs in separately; both keep their own identity.
  const second = await run(service.addAccount(added.connectionId, "second-account"));
  await authorize(second.id, "Account B");
  expect(await whoami(second.id)).toContain("Account B");
  expect(await whoami(added.connectionId)).toContain("Account A");
  fixture.notifyToolsChanged();
  for (let attempt = 0; attempt < 60 && !JSON.stringify(connection.toolSnapshot).includes("new_tool"); attempt++) {
    await Bun.sleep(25);
    connection = await row(added.connectionId);
  }
  expect(JSON.stringify(connection.toolSnapshot)).toContain("new_tool");

  await authorize(second.id, "cancel");
  expect(await row(second.id)).toMatchObject({ status: "needs_auth", statusMessage: "Authorization was cancelled. You can try again when ready." });
  const abandonedState = new URL((await run(service.authenticate(second.id))).authorizationUrl).searchParams.get("state")!;
  await run(service.disconnect(second.id));
  await expect(run(service.finishAuthentication(second.id, "old-code", abandonedState))).rejects.toThrow("state");
  await expect(run(service.cancelAuthentication(second.id, abandonedState))).rejects.toThrow("state");
  expect((await row(second.id)).status).toBe("disconnected");

  // A manually registered client with the wrong secret fails validation; a public client then signs in.
  const view = await run(service.configuration.get(second.id));
  fixture.registerClient("manual-client", view.callbackUrl, "manual-client-secret");
  await run(service.configuration.save(second.id, { values: { clientId: "manual-client" }, secrets: { clientSecret: { action: "replace", value: "wrong-secret" } }, tokenEndpointAuthMethod: "client_secret_post" }));
  await expect(authorize(second.id)).rejects.toThrow();
  expect((await row(second.id)).status).toBe("error");
  expect((await run(service.pollConnectionStatuses([second.id]))).connections[0]?.setupPhase).toBe("validation_failed");
  fixture.registerClient("public-client", view.callbackUrl);
  await run(service.configuration.save(second.id, { values: { clientId: "public-client" }, secrets: { clientSecret: { action: "clear" } }, tokenEndpointAuthMethod: "none" }));
  await authorize(second.id, "Account B");
  expect(await whoami(second.id)).toContain("Account B");
}, 20_000);
