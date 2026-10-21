import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createPrismaClient } from "@openteam/db";
import { InternalToolService } from "../../src/services/internal-tool-service";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;
test.skipIf(!databaseUrl)(
  "a routine run manages installed plugins with nobody watching",
  async () => {
    const prisma = createPrismaClient(databaseUrl!);
    const plugins = new PluginService(prisma);
    const restarted: string[] = [];
    // A reconnect would dial the fixture URL; record it instead.
    Object.assign(plugins, {
      restart: (connectionId: string) => (restarted.push(connectionId), Effect.succeed({ id: connectionId, status: "ready" })),
    });
    const botId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const installations: string[] = [];
    let channelId: string | undefined;
    try {
      await prisma.bot.create({
        data: {
          id: botId,
          name: "Routine plugin fixture",
          status: "active",
          onboardingStatus: "completed",
          defaultDirectory: "/tmp",
          conversation: { create: { id: conversationId } },
        },
      });
      channelId = (await prisma.channel.create({
        data: { kind: "bot_dm", name: "Routine DM", members: { create: { botId, ordinal: 0 } } },
      })).id;
      const run = await prisma.run.create({
        data: { botId, conversationId, channelId, origin: "routine", userMessageId: crypto.randomUUID(), status: "running" },
      });
      const service = new InternalToolService(
        prisma, {} as never, {} as never, async () => {}, {} as never, {} as never, {} as never, plugins
      );
      const call = (tool: string, args: Record<string, unknown>) =>
        Effect.runPromise(service.execute({
          botId, conversationId, channelId: channelId!, deliveryId: null, runId: run.id, tool, arguments: args, callId: crypto.randomUUID(),
        })) as Promise<Record<string, any>>;
      const add = async (name: string) => {
        const added = await Effect.runPromise(plugins.addCustomMcp({ name, url: "https://fixture.example.test/mcp", auth: "none" }));
        installations.push(added.installationId);
        return added;
      };
      const kept = await add("Routine fixture");
      const removed = await add("Routine leftover");

      expect(await call("SetMcpInstructions", { server_id: kept.pluginKey, instructions: "Reply in threads." })).toMatchObject({ completed: true });
      expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: kept.connectionId } })).instructions).toBe("Reply in threads.");
      await call("RenameMcpAccount", { server_id: kept.pluginKey, account_label: "default", new_account_label: "work" });
      expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: kept.connectionId } })).alias).toBe("work");
      expect(await call("RestartMcpServers", {})).toMatchObject({ completed: true });
      expect(restarted).toEqual(expect.arrayContaining([kept.connectionId, removed.connectionId]));
      // The only account is reset rather than deleted, so the server stays installed.
      expect(await call("RemoveMcpAccount", { server_id: kept.pluginKey, account_label: "work" })).toMatchObject({ actionResult: { removed: true, reset: true } });
      expect((await prisma.pluginConnection.findUniqueOrThrow({ where: { id: kept.connectionId } })).alias).toBe("default");
      await call("UninstallMcpServer", { server_id: kept.pluginKey });
      await call("UninstallPlugin", { plugin_id: removed.pluginKey });
      const installed = await prisma.pluginInstallation.findMany({ where: { id: { in: installations } }, select: { status: true } });
      expect(installed.every((installation) => installation.status !== "installed")).toBe(true);

      // None of them posted a card or a message into the chat.
      expect(await prisma.channelMessage.count({ where: { channelId } })).toBe(0);
      await expect(call("InstallPlugin", { plugin_id: "linear" })).rejects.toThrow("Automation runs cannot mutate the visible transcript.");
    } finally {
      await plugins.close();
      await prisma.idempotencyRecord.deleteMany({ where: { scope: "plugin-action" } });
      await prisma.pluginInstallation.deleteMany({ where: { id: { in: installations } } });
      await prisma.bot.deleteMany({ where: { id: botId } });
      if (channelId) await prisma.channel.deleteMany({ where: { id: channelId } });
      await prisma.$disconnect();
    }
  },
  30_000
);
