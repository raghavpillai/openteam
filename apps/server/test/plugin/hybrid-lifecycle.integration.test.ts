import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk/templates";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { createOAuthMcpFixture } from "./fixtures/oauth-mcp";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "hybrid skill sync and OAuth recover independently on one installation",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const fixture = createOAuthMcpFixture();
    let syncFails = true;
    const service = new PluginService(prisma, undefined, {
      syncPluginSkillCache: async () => {
        if (syncFails) throw new Error("Fixture skill storage offline");
      },
      writeConnectorSecret: async () => {},
    });
    const definition = createPluginTemplate("hybrid", `hybrid-recovery-${crypto.randomUUID()}`);
    definition.connections = [
      {
        key: "oauth",
        name: "OAuth fixture",
        transport: "http",
        auth: "oauth",
        endpoint: fixture.endpoint,
        tools: [],
      },
    ];
    let draftId = "";
    try {
      const draft = await Effect.runPromise(
        service.management.importFiles({ "plugin.json": JSON.stringify(definition) })
      );
      draftId = draft.id;
      await Effect.runPromise(service.management.installDraft(draft.id));
      const connection = await prisma.pluginConnection.findFirstOrThrow({
        where: { installation: { pluginKey: definition.key } },
      });
      const authorize = async (fail = false) => {
        const started = await Effect.runPromise(service.authenticate(connection.id));
        const approval = new URL(started.authorizationUrl);
        approval.pathname = "/approve";
        const response = await fetch(approval, {
          method: "POST",
          body: new URLSearchParams({ account: "Account A" }),
          redirect: "manual",
        });
        const callback = new URL(response.headers.get("location")!);
        return Effect.runPromise(
          service.finishAuthentication(
            connection.id,
            fail ? "invalid-code" : callback.searchParams.get("code")!,
            callback.searchParams.get("state")!
          )
        );
      };
      await authorize();
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).status
      ).toBe("ready");
      expect(
        (await Effect.runPromise(service.management.package(definition.key))).skillSyncStatus
      ).toBe("error");
      syncFails = false;
      await Effect.runPromise(service.management.retrySync());
      await expect(authorize(true)).rejects.toThrow();
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).status
      ).toBe("needs_auth");
      expect(
        (await Effect.runPromise(service.management.package(definition.key))).skillSyncStatus
      ).toBe("ready");
      await authorize();
      expect(
        (await prisma.pluginConnection.findUniqueOrThrow({ where: { id: connection.id } })).status
      ).toBe("ready");
      expect(await prisma.pluginInstallation.count({ where: { pluginKey: definition.key } })).toBe(
        1
      );
      expect(
        await prisma.pluginConnection.count({
          where: { installationId: connection.installationId },
        })
      ).toBe(1);
    } finally {
      await service.close();
      fixture.close();
      await prisma.pluginInstallation.deleteMany({ where: { pluginKey: definition.key } });
      if (draftId) await prisma.pluginDraft.deleteMany({ where: { id: draftId } });
      await prisma.$disconnect();
    }
  }
);
