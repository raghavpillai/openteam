import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrismaClient } from "@openteam/db";
import { AgentDataStore } from "@openteam/messaging";
import { parsePluginRuntimeComponents } from "@openteam/plugin-sdk";
import { importPackageArchive } from "@openteam/plugin-sdk/archive";
import { Effect } from "effect";
import { pluginCatalog } from "../../src/plugins/catalog";
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
      const service = new PluginService(prisma, undefined, store);
      const botId = crypto.randomUUID();
      try {
        expect(
          await prisma.pluginInstallation.findUnique({ where: { pluginKey: catalog.key } })
        ).toBeNull();
        await prisma.bot.create({
          data: {
            id: botId,
            name: "Catalog QA",
            defaultDirectory: "/workspace",
            conversation: { create: {} },
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
          expect(await readFile(record.filePath, "utf8")).toBe(
            review.definition.files![`${skill.path}/SKILL.md`]!
          );
        }
        await Effect.runPromise(service.setEnablement(catalog.key, botId, true, true));
        const context = await pluginRuntimeContext(prisma, botId);
        for (const skill of review.definition.skills)
          expect(context.skillInstructions).toContain(skill.name);
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
          if (catalog.key === "1password")
            expect(runtime.hooksUnavailableReason).toContain("desktop filesystem");
        }
        expect(context.dynamicNamespaces).toEqual([]);
        const accounts = await prisma.pluginConnection.findMany({
          where: { installation: { pluginKey: catalog.key } },
        });
        expect(accounts).toHaveLength(catalog.connections.length);
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
          expect(
            await prisma.botPluginConnectionGrant.count({ where: { connectionId: account.id } })
          ).toBe(0);
          if (account.transport === "builtin") {
            await Effect.runPromise(service.connect(account.id));
            const result = await Effect.runPromise(
              service.testTool(account.id, { toolName: "add", arguments: { a: 19, b: 23 } })
            );
            expect(JSON.stringify(result)).toContain("42");
          }
        }
        await Effect.runPromise(service.setEnablement(catalog.key, botId, false, false));
        expect(await pluginRuntimeContext(prisma, botId)).toEqual({
          dynamicNamespaces: [],
          pluginRuntimePackages: [],
          skillInstructions: "",
        });
        await Effect.runPromise(service.uninstall(catalog.key));
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
