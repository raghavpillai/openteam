import { expect, test } from "bun:test";
import { createPrismaClient } from "@openbot/db";
import { Effect } from "effect";
import { PluginService } from "../src/services/plugin-service";
import { RunService } from "../src/services/run-service";

const databaseUrl = process.env.OPENBOT_TEST_DATABASE_URL;

test("plugin install, connection, grant, policy, discovery, call, and removal lifecycle", async () => {
  if (!databaseUrl) return;
  const prisma = createPrismaClient(databaseUrl);
  const service = new PluginService(prisma);
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const secondBotId = crypto.randomUUID();
  const runId = crypto.randomUUID();
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
    await prisma.run.create({
      data: {
        id: runId,
        botId,
        conversationId,
        userMessageId: crypto.randomUUID(),
        status: "running",
      },
    });

    await Effect.runPromise(service.install("openbot-utility-lab"));
    const initial = await Effect.runPromise(service.settings());
    const connection = initial.connections[0]!;
    expect(connection.status).toBe("disconnected");

    await Effect.runPromise(service.connect(connection.id));
    await Effect.runPromise(service.setGrant(connection.id, botId, true));
    const namespaces = await service.dynamicNamespaces(botId);
    expect(namespaces[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "add", "remember_note"]);

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

    await expect(
      service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-note-1",
        toolName: "remember_note",
        arguments: { note: "requires approval" },
      })
    ).rejects.toMatchObject({ code: "plugin_approval_required" });
    const approval = await prisma.approval.findFirstOrThrow({
      where: { upstreamRequestId: "plugin:plugin-call-note-1" },
    });
    const runs = new RunService(prisma, async () => {
      throw new Error("Plugin approvals must not call the computer runtime");
    });
    expect(await Effect.runPromise(runs.resolveApproval(approval.id, "accept"))).toMatchObject({
      status: "accepted",
    });
    expect(
      await service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-note-2",
        toolName: "remember_note",
        arguments: { note: "approved note" },
      })
    ).toEqual({ remembered: true });
    expect((await Effect.runPromise(service.settings())).activity.length).toBeGreaterThan(0);

    await Effect.runPromise(service.install("research-playbook"));
    expect(await service.skillInstructions(botId)).toBe("");
    await Effect.runPromise(service.setEnablement("research-playbook", botId, true, true));
    expect(await service.skillInstructions(botId)).toContain("source-led-research");
    expect(await service.skillInstructions(secondBotId)).toBe("");

    await Effect.runPromise(service.uninstall("openbot-utility-lab"));
    await Effect.runPromise(service.uninstall("research-playbook"));
    expect((await Effect.runPromise(service.settings())).installs).toHaveLength(0);
  } finally {
    await prisma.$disconnect();
  }
});
