import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "direct authentication replays the exact newly created account",
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
      authenticateFromAgent: (id: string) =>
        (++attempts, Effect.succeed({ id, authenticated: true })),
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
        origin: "user" as const,
      };
      const result=await service.requestAction(request) as any;
      const pinnedId=result.actionResult.id;
      expect(result).toMatchObject({completed:true,actionResult:{authenticated:true}});
      expect(await service.requestAction(request)).toMatchObject({actionResult:{id:pinnedId}});
      expect(attempts).toBe(1);
      expect(await db.pluginConnection.count({where:{installationId}})).toBe(2);
      await expect(service.requestAction({...request,action:"UninstallMcpServer"})).rejects.toThrow("another action");
      await expect(service.resolveToolArguments("AuthenticateMcpServer",{createAccountId:pinnedId})).rejects.toThrow("assigned by the action service");
      const serverArgs = {
        name: "Reviewed fixture",
        url: "https://fixture.example.test/mcp",
      };
      const serverAction={...request,callId:crypto.randomUUID(),action:"AddMcpServer",arguments:serverArgs};
      const created = ((await service.requestAction(serverAction)) as any).actionResult as {
        installationId: string;
      };
      addedInstallationId = created.installationId;
      expect(await service.requestAction(serverAction)).toMatchObject({actionResult:created});
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

test.skipIf(!databaseUrl)("account labels match case-insensitively and unknown names get the reference texts", async () => {
  const db = createPrismaClient(databaseUrl!);
  const service = new PluginService(db);
  let installationId: string | undefined;
  try {
    const source = await Effect.runPromise(service.addCustomMcp({ name: "Fixture", url: "https://fixture.example.test/mcp", auth: "oauth", alias: "work" }));
    installationId = source.installationId;
    const [connection] = await db.pluginConnection.findMany({ where: { installationId } });
    // "Work" re-authenticates the existing "work" account instead of creating a second one.
    const resolved = await service.resolveToolArguments("AuthenticateMcpServer", { server_id: source.pluginKey, account_label: "Work" });
    expect(resolved.connectionId).toBe(connection!.id);
    expect(resolved).not.toHaveProperty("createAccountLabel");
    expect(await service.resolveToolArguments("AuthenticateMcpServer", { server_id: source.pluginKey, account_label: "Personal" })).toMatchObject({ createAccountLabel: "personal" });
    expect((await service.resolveToolArguments("RemoveMcpAccount", { server_id: source.pluginKey, account_label: 'account="WORK"' })).connectionId).toBe(connection!.id);
    await expect(service.resolveToolArguments("SetMcpInstructions", { server_id: "slack", instructions: "x" })).rejects.toThrow(
      'No installed MCP server "slack". Run GetMcpServerStatus to list every server with its identifier.'
    );
    if (!(await db.pluginInstallation.findUnique({ where: { pluginKey: "linear" } })))
      await expect(service.resolveToolArguments("UninstallPlugin", { pluginId: "linear" })).rejects.toThrow(
        "Linear (plugin linear) is not installed, so there is nothing to uninstall."
      );
    await expect(service.resolveToolArguments("InstallPlugin", { id: "no-such-plugin" })).rejects.toThrow(
      'No plugin with id "no-such-plugin". Ids come from SearchPlugins. Run it and use the id it lists.'
    );
  } finally {
    await service.close();
    if (installationId) await db.pluginInstallation.deleteMany({ where: { id: installationId } });
    await db.$disconnect();
  }
});
