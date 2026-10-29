import { createUtilityPluginFixture } from "./fixtures/utility-plugin";
import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import type { PluginDefinition } from "@openteam/plugin-sdk";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
const integration = test.skipIf(!databaseUrl);

integration(
  "plugins shipped with a release update with it and reconnect",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const service = new PluginService(prisma, undefined, {
      syncPluginSkillCache: async () => {},
      writeConnectorSecret: async () => {},
    });
    const key = `released-${crypto.randomUUID()}`;
    const release = (version: string, extra: Partial<PluginDefinition> = {}): PluginDefinition => ({
      ...createUtilityPluginFixture(key),
      version,
      description: `Release ${version}`,
      ...extra,
    });
    let catalog: PluginDefinition[] = [release("1.0.0")];
    // The bundled catalog is the release's package list.
    (service as unknown as { marketplace: { plugins: () => Promise<PluginDefinition[]> } }).marketplace = {
      plugins: async () => catalog,
    };
    const installation = () => prisma.pluginInstallation.findUniqueOrThrow({ where: { pluginKey: key } });
    try {
      await Effect.runPromise(service.install(key));
      const [connection] = await prisma.pluginConnection.findMany({ where: { installation: { pluginKey: key } } });
      await prisma.pluginConnection.update({ where: { id: connection!.id }, data: { status: "ready" } });

      // Same version or older: never an automatic change, even when the bytes differ.
      for (const version of ["1.0.0", "0.9.9", "1.1"]) {
        catalog = [release(version, { description: `Rebuilt ${version}` })];
        expect(await service.updateReleasedPlugins()).toEqual([]);
        expect((await installation()).version).toBe("1.0.0");
      }

      catalog = [release("1.1.0")];
      expect(await service.updateReleasedPlugins()).toEqual([connection!.id]);
      expect((await installation()).version).toBe("1.1.0");
      const activity = await prisma.pluginActivity.findFirst({
        where: { installation: { pluginKey: key }, kind: "plugin.updated" },
        orderBy: { createdAt: "desc" },
      });
      expect(activity?.summary).toContain("1.1.0 with OpenTeam");
      // An uploaded draft of the same plugin is the administrator's choice: no automatic update.
      const draft = await prisma.pluginDraft.create({
        data: { name: "Uploaded copy", definition: JSON.parse(JSON.stringify(release("1.1.0"))) },
      });
      catalog = [release("1.2.0")];
      expect(await service.updateReleasedPlugins()).toEqual([]);
      await prisma.pluginDraft.delete({ where: { id: draft.id } });

      // Packages fetched from upstream at install time still need a reviewed update.
      catalog = [
        release("1.2.0", {
          upstream: { repository: "example/plugins", revision: "main", directory: "x", delivery: "install", license: null, files: {} },
        }),
      ];
      expect(await service.updateReleasedPlugins()).toEqual([]);
      expect((await installation()).version).toBe("1.1.0");
    } finally {
      await prisma.pluginInstallation.deleteMany({ where: { pluginKey: key } });
      await prisma.$disconnect();
    }
  },
  30_000
);
