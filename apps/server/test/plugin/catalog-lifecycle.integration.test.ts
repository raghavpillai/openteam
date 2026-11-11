import { StdioMcpManager } from "../../../computer/src/mcp-manager";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { parsePluginRuntimeComponents, skillIsForAgent } from "@openteam/plugin-sdk";
import { importPackageArchive } from "@openteam/plugin-sdk/archive";
import { originalSkillMarkdown, parseSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";
import { Effect } from "effect";
import { pluginCatalog } from "@openteam/plugins";
import { PluginService } from "../../src/services/plugin-service";
import { pluginRuntimeContext } from "../../../worker/src/plugins";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
for (const catalog of pluginCatalog) {
  test.skipIf(
    !databaseUrl ||
      (catalog.upstream?.delivery === "install" &&
        process.env.OPENTEAM_TEST_UPSTREAM_SOURCES !== "1")
  )(
    `${catalog.key}: actual catalog package installs, exports, loads workflows, isolates accounts, and uninstalls`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), `openteam-catalog-${catalog.key}-`));
      const previousRoot = process.env.OPENTEAM_AGENT_DATA_ROOT;
      process.env.OPENTEAM_AGENT_DATA_ROOT = root;
      const prisma = createPrismaClient(databaseUrl!);
      const store = new AgentDataStore(prisma, { root, workspaceRoot: join(root, "workspace") });
      const computer = new StdioMcpManager(join(root, "plugin-runtimes"));
      const service = new PluginService(prisma, async (path, init) => {
        const id = path.split("/")[4]!;
        const generation = Number(new Headers(init?.headers).get("x-openteam-mcp-generation") ?? 0);
        if (init?.method === "DELETE") {
          if (path.endsWith("/state")) await computer.forget(id, generation);
          else await computer.close(id, generation);
          return Response.json({ ok: true });
        }
        if (init?.method === "GET") return Response.json(computer.status(id));
        throw new Error("Catalog lifecycle tests never launch provider runtimes");
      }, store);
      const botId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const contextSessionId = crypto.randomUUID();
      try {
        expect(
          await prisma.pluginInstallation.findUnique({ where: { pluginKey: catalog.key } })
        ).toBeNull();
        await prisma.bot.create({
          data: {
            id: botId,
            name: "Catalog QA",
            defaultDirectory: "/workspace",
            status: "active",
            onboardingStatus: "completed",
            conversation: { create: { id: conversationId } },
            contextSessions: { create: { id: contextSessionId, scope: "home", scopeId: conversationId } },
          },
        });
        await Effect.runPromise(service.install(catalog.key));
        const review = await Effect.runPromise(service.management.package(catalog.key));
        expect(review.skillSyncStatus).toBe("ready");
        expect(review.update).toBeNull();
        expect(review.definition.connections).toEqual(catalog.connections);
        expect(review.definition.skills).toHaveLength(catalog.skills.length);
        const archived = importPackageArchive(
          await Effect.runPromise(service.management.exportInstalled(catalog.key))
        ).definition;
        expect(archived.skills).toEqual(review.definition.skills);
        expect(archived.connections).toEqual(catalog.connections);
        const cache = JSON.parse(await readFile(join(root, "plugin-skills/cache.json"), "utf8"));
        for (const skill of review.definition.skills) {
          const record = cache.skills.find(
            (entry: any) => entry.pluginId === catalog.key && entry.name === skill.name
          );
          expect(record).toBeDefined();
          const markdown = await readFile(record.filePath, "utf8");
          expect(parseSkillMarkdown(markdown)).toEqual({
            name: skill.name, description: skill.description, body: skill.body,
          });
          const original = originalSkillMarkdown(skill, review.definition.files?.[`${skill.path}/SKILL.md`]);
          if (original !== undefined) expect(markdown).toBe(original);
        }
        const context = await pluginRuntimeContext(prisma, botId);
        const prompt = await store.promptContext(botId, contextSessionId);
        for (const skill of review.definition.skills.filter((skill) => skillIsForAgent(skill, "main"))) {
          const record = cache.skills.find((entry: any) => entry.pluginId === catalog.key && entry.name === skill.name);
          expect(prompt.skillRender).toContain(record.filePath);
          expect(context.skillInstructions).toContain("agent_skills catalog in user_info");
        }
        const components = parsePluginRuntimeComponents(review.definition.files ?? {});
        if (
          components.commands.length ||
          components.agents.length ||
          components.rules.length ||
          components.hooks.length
        ) {
          const runtime = context.pluginRuntimePackages.find((pkg) => pkg.key === catalog.key)!;
          expect(runtime).toBeDefined();
          expect(runtime.commands).toEqual(components.commands);
        }
        const accounts = await prisma.pluginConnection.findMany({
          where: { installation: { pluginKey: catalog.key } },
        });
        expect(accounts).toHaveLength(catalog.connections.length);
        expect(context.dynamicNamespaces).toEqual(await service.dynamicNamespaces(botId));
        expect(context.dynamicNamespaces).toHaveLength(accounts.filter((account) => ["ready", "needs_auth", "error"].includes(account.status)).length);
        for (const namespace of context.dynamicNamespaces) {
          expect(namespace.tools).toEqual([]);
          expect(["needsAuth", "error"]).toContain(namespace.namespaceStatus);
          expect(namespace.statusMessage).toBeTruthy();
        }
        const settings = await Effect.runPromise(service.settings());
        const installedView = settings.installs.find((entry) => entry.pluginKey === catalog.key)!;
        for (const account of accounts) {
          expect(
            installedView.connections.find((entry) => entry.id === account.id)!
              .manualCallbackSupported
          ).toBe(
            catalog.connections.find((entry) => entry.key === account.connectorKey)?.oauth
              ?.supportsLoopbackRedirect !== false
          );
          expect(account.credentials).toEqual({ values: {} });
          await expect(service.invoke({
            connectionId: account.id, botId, runId: crypto.randomUUID(),
            callId: crypto.randomUUID(), toolName: "add", arguments: { a: 19, b: 23 },
          })).rejects.toMatchObject({ code: "plugin_connection_not_ready" });
          if (account.transport === "builtin") {
            await Effect.runPromise(service.connect(account.id));
            const result = await Effect.runPromise(
              service.testTool(account.id, { toolName: "add", arguments: { a: 19, b: 23 } })
            );
            expect(JSON.stringify(result)).toContain("42");
          }
        }
        await Effect.runPromise(service.uninstall(catalog.key));
        expect(await pluginRuntimeContext(prisma, botId)).toEqual({
          dynamicNamespaces: [],
          pluginRuntimePackages: [],
          skillInstructions: "",
        });
        expect(
          await prisma.pluginInstallation.findUnique({ where: { pluginKey: catalog.key } })
        ).toBeNull();
        expect(
          await prisma.pluginConnection.count({
            where: { id: { in: accounts.map((account) => account.id) } },
          })
        ).toBe(0);
      } finally {
        await service.close();
        await computer.closeAll();
        await prisma.pluginInstallation.deleteMany({ where: { pluginKey: catalog.key } });
        await prisma.bot.deleteMany({ where: { id: botId } });
        await prisma.$disconnect();
        if (previousRoot === undefined) delete process.env.OPENTEAM_AGENT_DATA_ROOT;
        else process.env.OPENTEAM_AGENT_DATA_ROOT = previousRoot;
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000
  );
}
