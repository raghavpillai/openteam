import { createUtilityPluginFixture } from "./fixtures/utility-plugin";
import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("plugin install, connection, discovery, direct call, and removal lifecycle", async () => {
  if (!databaseUrl) return;
  const prisma = createPrismaClient(databaseUrl);
  const service = new PluginService(prisma);
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const secondBotId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  let skillDraftId = "";
  let utilityDraftId = "";
  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "PluginInstallation", "Bot", "Event" CASCADE');
    await prisma.bot.create({
      data: {
        id: botId,
        name: "Plugin Tester",
        defaultDirectory: "/workspace/bots/plugin-tester",
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: conversationId } },
      },
    });
    await prisma.bot.create({
      data: {
        id: secondBotId,
        name: "No Skills",
        defaultDirectory: "/workspace/bots/no-skills",
        status: "active",
        onboardingStatus: "completed",
        conversation: { create: { id: crypto.randomUUID() } },
      },
    });
    await prisma.channel.create({ data: { id: channelId, kind: "bot_dm", name: "Plugin test" } });
    await prisma.run.create({
      data: {
        id: runId,
        botId,
        conversationId,
        channelId,
        userMessageId: crypto.randomUUID(),
        status: "running",
      },
    });

    const utilityDraft = await Effect.runPromise(service.management.importFiles({
      "plugin.json": JSON.stringify(createUtilityPluginFixture()),
    }));
    utilityDraftId = utilityDraft.id;
    await Effect.runPromise(service.management.installDraft(utilityDraft.id));
    const initial = await Effect.runPromise(service.settings());
    const connection = initial.installs[0]?.connections[0];
    if (!connection) throw new Error("Expected the installed plugin to expose a connection");
    expect(connection.status).toBe("disconnected");

    await Effect.runPromise(service.connect(connection.id));
    const namespaces = await service.dynamicNamespaces(botId);
    expect(namespaces[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "add", "remember_note"]);
    await Effect.runPromise(service.renameAccount(connection.id,"renamed"));
    const renamed = await service.dynamicNamespaces(botId);
    expect(renamed[0]!.name).not.toBe(namespaces[0]!.name);
    await expect(service.invoke({connectionId:connection.id,namespace:namespaces[0]!.name,botId,runId,callId:"stale-account",toolName:"echo",arguments:{text:"wrong namespace"},})).rejects.toMatchObject({code:"plugin_identifier_stale"});
    expect(await service.invoke({connectionId:connection.id,namespace:renamed[0]!.name,botId,runId,callId:"renamed-account",toolName:"echo",arguments:{text:"renamed namespace"},})).toEqual({text:"renamed namespace"});

    const result = await service.invoke({
      connectionId: connection.id,
      botId,
      runId,
      callId: "plugin-call-echo-1",
      toolName: "echo",
      arguments: { text: "through the gateway" },
    });
    expect(result).toEqual({ text: "through the gateway" });
    expect(
      await service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-echo-1",
        toolName: "echo",
        arguments: { text: "ignored replay body" },
      })
    ).toEqual({ text: "through the gateway" });

    const writeRequest = {connectionId:connection.id, botId, runId, callId:"direct-write",toolName:"remember_note",arguments:{note:"direct note"}};
    expect(await service.invoke(writeRequest)).toEqual({remembered:true});
    expect(await service.invoke(writeRequest)).toEqual({remembered:true});
    expect(await prisma.pluginInvocation.findUniqueOrThrow({where:{callId:"direct-write"}})).toMatchObject({status:"completed",result:{remembered:true}});
    expect((await Effect.runPromise(service.settings())).activity.length).toBeGreaterThan(0);

    const skillDraft = await Effect.runPromise(service.management.importFiles({
      "plugin.json": JSON.stringify(createPluginTemplate("skills", "lifecycle-skills-fixture")),
    }));
    skillDraftId = skillDraft.id;
    await Effect.runPromise(service.install("lifecycle-skills-fixture"));
    expect(await service.skillInstructions(botId)).toContain("my-skill");
    expect(await service.skillInstructions(secondBotId)).toContain("my-skill");

    await Effect.runPromise(service.uninstall("test-utility"));
    await Effect.runPromise(service.uninstall("lifecycle-skills-fixture"));
    expect((await Effect.runPromise(service.settings())).installs).toHaveLength(0);

    const actionRequest={runId,botId,callId:"plugin-action-install-1",action:"InstallPlugin",arguments:{pluginKey:"lifecycle-skills-fixture"}};
    expect(await service.requestAction(actionRequest)).toMatchObject({status:"completed",completed:true,actionResult:{installed:true}});
    expect(await service.requestAction(actionRequest)).toMatchObject({completed:true,detail:{installed:true}});
    await Effect.runPromise(service.uninstall("lifecycle-skills-fixture"));
  } finally {
    if (utilityDraftId) await prisma.pluginDraft.deleteMany({ where: { id: utilityDraftId } });
    if (skillDraftId) await prisma.pluginDraft.deleteMany({ where: { id: skillDraftId } });
    await service.close();
    await prisma.$disconnect();
  }
});
