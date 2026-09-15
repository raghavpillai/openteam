import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "reviewed authentication retries reuse the exact newly created account",
  async () => {
    const db = createPrismaClient(databaseUrl!);
    const service = new PluginService(db);
    const botId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    let installationId: string | undefined;
    let addedInstallationId: string | undefined;
    let attempts = 0;
    Object.assign(service, {
      authenticate: (id: string) =>
        ++attempts === 1
          ? Effect.fail(new Error("Fixture authentication interrupted"))
          : Effect.succeed({ id, authenticated: true }),
    });
    try {
      await db.bot.create({
        data: {
          id: botId,
          name: "MCP account review fixture",
          defaultDirectory: "/tmp",
          status: "active",
          conversation: { create: { id: conversationId } },
        },
      });
      await db.run.create({
        data: {
          id: runId,
          botId,
          conversationId,
          userMessageId: crypto.randomUUID(),
          status: "running",
        },
      });
      const source = await Effect.runPromise(
        service.addCustomMcp({
          name: "Fixture",
          url: "https://fixture.example.test/mcp",
          auth: "oauth",
        })
      );
      installationId = source.installationId;
      const callId = crypto.randomUUID();
      const request = {
        botId,
        runId,
        callId,
        action: "AuthenticateMcpServer",
        arguments: { server_id: source.pluginKey, account_label: "work" },
      };
      await expect(service.requestAction(request)).rejects.toThrow("waiting for user confirmation");
      const approval = await db.approval.findUniqueOrThrow({
        where: { upstreamRequestId: `plugin-action:${callId}` },
      });
      await expect(service.resolveAction(approval.details, "accept")).rejects.toThrow(
        "interrupted"
      );
      await expect(service.requestAction(request)).rejects.toThrow("waiting for user confirmation");
      const pinnedId = (approval.details as any).rawArguments.createAccountId;
      expect(await service.resolveAction(approval.details, "accept")).toEqual({
        id: pinnedId,
        authenticated: true,
      });
      expect(await db.pluginConnection.count({ where: { installationId } })).toBe(2);
      await expect(
        service.requestAction({ ...request, action: "UninstallMcpServer" })
      ).rejects.toThrow("another action");
      await expect(
        service.resolveToolArguments("AuthenticateMcpServer", { createAccountId: pinnedId })
      ).rejects.toThrow("assigned by the approval service");
      await db.approval.update({
        where: { id: approval.id },
        data: { status: "accepted", decision: "accept" },
      });
      expect(await service.requestAction(request)).toMatchObject({ status: "accepted", completed: false }); // An old approval without an operation receipt is not proof of success.
      const serverArgs = await service.resolveToolArguments("AddMcpServer", {
        name: "Reviewed fixture",
        url: "https://fixture.example.test/mcp",
      });
      const serverAction = { action: "AddMcpServer", rawArguments: serverArgs };
      const created = (await service.resolveAction(serverAction, "accept")) as {
        installationId: string;
      };
      addedInstallationId = created.installationId;
      expect(await service.resolveAction(serverAction, "accept")).toEqual(created);
      expect(await db.pluginInstallation.count({ where: { id: addedInstallationId } })).toBe(1);
    } finally {
      await service.close();
      if (installationId) await db.pluginInstallation.deleteMany({ where: { id: installationId } });
      if (addedInstallationId)
        await db.pluginInstallation.deleteMany({ where: { id: addedInstallationId } });
      await db.bot.deleteMany({ where: { id: botId } });
      await db.$disconnect();
    }
  }
);
