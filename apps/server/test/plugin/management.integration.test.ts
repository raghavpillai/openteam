import { expect } from "bun:test";
import { Effect } from "effect";
import type { PluginDefinition } from "@openteam/plugin-sdk";
import { importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginRuntimeContext } from "../../../worker/src/plugins";
import { PluginService } from "../../src/services/plugin-service";
import { dbIt } from "../harness";
import { startUtilityMcp } from "./fixtures/utility-plugin";

const run = <T>(effect: Effect.Effect<T, unknown>) => Effect.runPromise(effect);

dbIt("management preserves accounts, direct tool execution and snapshots through configuration, discovery and upgrades", async h => {
  const prisma = h.db;
  let syncFails = true;
  const service = new PluginService(prisma, undefined, { syncPluginSkillCache: async () => { if (syncFails) throw new Error("Fixture volume unavailable"); }, writeConnectorSecret: async () => {} });
  const utility = startUtilityMcp();
  h.onClose(async () => utility.close());
  const key = `test-package-${crypto.randomUUID()}`, base = utility.definition();
  const definition = {
    ...base, key, name: "Parity test", components: ["mcp", "skills"] as Array<"mcp" | "skills">,
    connections: [base.connections[0]!, { ...base.connections[0]!, key: "second", name: "Second connector" }],
    skills: [{ name: "fixture-skill", description: "Test skill", body: "Use references/check.md", path: "skills/fixture" }],
    files: { "skills/fixture/references/check.md": "Preserved supporting file" },
  };
  let draftId = "";
  h.onClose(async () => { await service.close(); await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } }); if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } }); });
  const bot = await h.bot("Plugin management test", {}, { dm: false }), botId = bot.id;
  const runId = (await h.run(bot)).id;
  const draft = await run(service.management.importFiles({ "plugin.json": JSON.stringify(definition) }));
  draftId = draft.id;
  await run(service.management.installDraft(draft.id));
  // A failed skill-cache sync is reported and can be retried.
  expect((await run(service.management.package(key))).skillSyncStatus).toBe("error");
  syncFails = false;
  await run(service.management.retrySync());
  expect((await run(service.management.package(key))).skillSyncStatus).toBe("ready");
  const install = await prisma.pluginInstallation.findUniqueOrThrow({ where: { pluginKey: key }, include: { connections: true } });
  const first = install.connections.find(entry => entry.connectorKey === "utility")!;
  for (const connection of install.connections) await run(service.connect(connection.id));
  const names = async () => (await service.dynamicNamespaces(botId)).map(entry => entry.name);
  const initial = await names();
  expect(new Set(initial).size).toBe(2);
  await run(service.renameAccount(first.id, "renamed"));
  expect(await names()).not.toEqual(initial);
  expect((await service.dynamicNamespaces(botId)).find(entry => entry.tools.some(tool => tool.connectionId === first.id))?.name).toEndWith("--renamed");
  await run(service.connect(first.id));
  const hasEcho = (namespaces: Awaited<ReturnType<typeof service.dynamicNamespaces>>) => namespaces.flatMap(entry => entry.tools).some(tool => tool.connectionId === first.id && tool.name === "echo");
  expect(hasEcho(await service.dynamicNamespaces(botId))).toBe(true);
  expect(hasEcho((await pluginRuntimeContext(prisma, botId)).dynamicNamespaces)).toBe(true);
  expect(await service.invoke({ connectionId: first.id, botId, runId, callId: crypto.randomUUID(), toolName: "echo", arguments: { text: "direct read" } })).toMatchObject({ structuredContent: { text: "direct read" } });
  // A retried write with the same call id executes once; a disconnected account refuses new calls.
  const write = { connectionId: first.id, botId, runId, callId: crypto.randomUUID(), toolName: "remember_note", arguments: { note: "Direct write executes once" } };
  expect(await service.invoke(write)).toMatchObject({ structuredContent: { remembered: true } });
  expect(await service.invoke(write)).toMatchObject({ structuredContent: { remembered: true } });
  const notes = async () => utility.notes.length;
  expect(await notes()).toBe(1);
  await run(service.disconnect(first.id));
  await expect(service.invoke({ ...write, callId: crypto.randomUUID() })).rejects.toMatchObject({ code: "plugin_connection_not_ready" });
  expect(await notes()).toBe(1);
  await run(service.connect(first.id));
  // Updates apply only the reviewed digest, keep account aliases, and roll back.
  await run(service.management.saveDraft(draft.id, { ...definition, version: "1.1.0", skills: [{ ...definition.skills[0]!, body: "Updated instructions" }] }));
  const review = await run(service.management.package(key));
  expect(review.update?.changes).toContain("Change skill: fixture-skill");
  await expect(run(service.management.update(key, "stale"))).rejects.toThrow("review");
  await run(service.management.update(key, review.update!.digest));
  expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: first.id } })).alias).toBe("renamed");
  expect((await run(service.management.package(key))).definition.version).toBe("1.1.0");
  await run(service.management.update(key, "", true));
  expect((await run(service.management.package(key))).definition.version).toBe(base.version);
  // Applying a package invalidates discovery. Reconnect before using its new snapshot.
  expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("disconnected");
  await run(service.connect(first.id));
  const direct = await service.dynamicNamespaces(botId);
  expect(direct.length).toBeGreaterThan(0);
  expect(await service.dynamicNamespaces(botId)).toEqual(direct);
  expect(importPackageArchive(await run(service.management.exportInstalled(key))).definition.files?.["skills/fixture/references/check.md"]).toBe("Preserved supporting file");
});

dbIt("saved secrets never leave configuration or export and new accounts do not copy account credentials", async ({ db: prisma, onClose }) => {
  const service = new PluginService(prisma);
  let key = "";
  onClose(async () => { if (key) await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } }); await service.close(); });
  const added = await run(service.addCustomMcp({ name: "Credential test", url: "https://example.com/mcp", auth: "oauth", headers: { "X-Account-Key": "account-header-secret" } }));
  key = added.pluginKey;
  await run(service.configure(added.connectionId, { clientId: "first-client", clientSecret: "first-secret", scope: "read" }));
  await prisma.pluginConnection.update({ where: { id: added.connectionId }, data: { credentials: {
    clientSecret: "first-secret", headers: { "X-Account-Key": "account-header-secret" }, oauth: { clientInformation: { client_id: "stale-client" }, tokens: { access_token: "old-oauth-token" } },
  } } });
  // A new client discards the old client's OAuth state.
  await run(service.configure(added.connectionId, { clientId: "new-client", clientSecret: "new-client-secret" }));
  expect(((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: added.connectionId } })).credentials as Record<string, unknown>).oauth).toBeUndefined();
  const view = await run(service.configuration.get(added.connectionId));
  expect(view.values.clientId).toBe("new-client");
  expect(view.configuredSecrets).toContain("clientSecret");
  for (const secret of ["new-client-secret", "account-header-secret"]) expect(JSON.stringify(view)).not.toContain(secret);
  const account = await run(service.addAccount(added.connectionId, "second"));
  const second = await prisma.pluginConnection.findUniqueOrThrow({ where: { id: account.id } });
  expect(second.credentials).toEqual({});
  expect(JSON.stringify(second.configuration)).not.toContain("account-header-secret");
  const bundle = JSON.stringify(importPackageArchive(await run(service.management.exportInstalled(key))));
  for (const secret of ["new-client-secret", "account-header-secret"]) expect(bundle).not.toContain(secret);
  await run(service.configuration.save(added.connectionId, { secrets: { clientSecret: { action: "clear" } }, headers: {} }));
  expect((await run(service.configuration.get(added.connectionId))).configuredSecrets).not.toContain("clientSecret");
});

dbIt("plugins shipped with a release update with it and reconnect", async ({ db: prisma, onClose }) => {
  const service = new PluginService(prisma, undefined, { syncPluginSkillCache: async () => {}, writeConnectorSecret: async () => {} });
  const key = `released-${crypto.randomUUID()}`;
  onClose(() => prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } }));
  const utility = startUtilityMcp();
  onClose(async () => utility.close());
  const release = (version: string, extra: Partial<PluginDefinition> = {}): PluginDefinition => ({ ...utility.definition(key), version, description: `Release ${version}`, ...extra });
  let catalog: PluginDefinition[] = [release("1.0.0")];
  // The bundled catalog is the release's package list.
  (service as unknown as { marketplace: { plugins: () => Promise<PluginDefinition[]> } }).marketplace = { plugins: async () => catalog };
  const version = async () => (await prisma.pluginInstallation.findUniqueOrThrow({ where: { pluginKey: key } })).version;
  await run(service.install(key));
  const [connection] = await prisma.pluginConnection.findMany({ where: { installation: { pluginKey: key } } });
  await prisma.pluginConnection.update({ where: { id: connection!.id }, data: { status: "ready" } });
  // Same version or older: never an automatic change, even when the bytes differ.
  for (const same of ["1.0.0", "0.9.9", "1.1"]) {
    catalog = [release(same, { description: `Rebuilt ${same}` })];
    expect(await service.updateReleasedPlugins()).toEqual([]);
    expect(await version()).toBe("1.0.0");
  }
  catalog = [release("1.1.0")];
  expect(await service.updateReleasedPlugins()).toEqual([connection!.id]);
  expect(await version()).toBe("1.1.0");
  const activity = await prisma.pluginActivity.findFirst({ where: { installation: { pluginKey: key }, kind: "plugin.updated" }, orderBy: { createdAt: "desc" } });
  expect(activity?.summary).toContain("1.1.0 with OpenTeam");
  // An uploaded draft of the same plugin is the administrator's choice: no automatic update.
  const draft = await prisma.pluginDraft.create({ data: { name: "Uploaded copy", definition: JSON.parse(JSON.stringify(release("1.1.0"))) } });
  catalog = [release("1.2.0")];
  expect(await service.updateReleasedPlugins()).toEqual([]);
  await prisma.pluginDraft.delete({ where: { id: draft.id } });
  // Packages fetched from upstream at install time still need a reviewed update.
  catalog = [release("1.2.0", { upstream: { repository: "example/plugins", revision: "main", directory: "x", delivery: "install", license: null, files: {} } })];
  expect(await service.updateReleasedPlugins()).toEqual([]);
  expect(await version()).toBe("1.1.0");
}, 30_000);

dbIt("agent plugin actions replay their exact result: a new account is authenticated once and a server is added once", async h => {
  const service = new PluginService(h.db);
  const installations: string[] = [];
  h.onClose(async () => { await service.close(); await h.db.pluginInstallation.deleteMany({ where: { id: { in: installations } } }); });
  let attempts = 0;
  Object.assign(service, { authenticateFromAgent: (id: string) => (++attempts, Effect.succeed({ id, authenticated: true })) });
  const bot = await h.bot("MCP account review fixture", {}, { dm: false });
  const runId = (await h.run(bot)).id;
  const source = await run(service.addCustomMcp({ name: "Fixture", url: "https://fixture.example.test/mcp", auth: "oauth" }));
  installations.push(source.installationId);
  const request = { botId: bot.id, runId, callId: crypto.randomUUID(), action: "AuthenticateMcpServer", arguments: { server_id: source.pluginKey, account_label: "work" }, origin: "user" as const };
  const result = await service.requestAction(request) as any;
  const pinnedId = result.actionResult.id;
  expect(result).toMatchObject({ completed: true, actionResult: { authenticated: true } });
  expect(await service.requestAction(request)).toMatchObject({ actionResult: { id: pinnedId } });
  expect(attempts).toBe(1);
  expect(await h.db.pluginConnection.count({ where: { installationId: source.installationId } })).toBe(2);
  await expect(service.requestAction({ ...request, action: "UninstallMcpServer" })).rejects.toThrow("another action");
  await expect(service.resolveToolArguments("AuthenticateMcpServer", { createAccountId: pinnedId })).rejects.toThrow("assigned by the action service");
  const serverAction = { ...request, callId: crypto.randomUUID(), action: "AddMcpServer", arguments: { name: "Reviewed fixture", url: "https://fixture.example.test/mcp" } };
  const created = ((await service.requestAction(serverAction)) as any).actionResult as { installationId: string };
  installations.push(created.installationId);
  expect(await service.requestAction(serverAction)).toMatchObject({ actionResult: created });
  expect(await h.db.pluginInstallation.count({ where: { id: created.installationId } })).toBe(1);
});
