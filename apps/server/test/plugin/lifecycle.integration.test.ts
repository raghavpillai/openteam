import { createUtilityPluginFixture } from "./fixtures/utility-plugin";
import { expect, test } from "bun:test";
import { createPrismaClient } from "@openteam/db";
import { createPluginTemplate } from "@openteam/plugin-sdk";
import { Effect } from "effect";
import { PluginService } from "../../src/services/plugin-service";
import { renderControlResult } from "@openteam/contracts/tool-results";
import { RunService } from "../../src/services/run-service";

const databaseUrl = process.env.OPENTEAM_TEST_DATABASE_URL;

test("plugin install, connection, grant, policy, discovery, call, and removal lifecycle", async () => {
  if (!databaseUrl) return;
  const prisma = createPrismaClient(databaseUrl);
  const service = new PluginService(prisma);
  const botId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const secondBotId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const wakes: Array<Record<string, any>> = [];
  let failApprovedCall = false;
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
    await Effect.runPromise(service.setGrant(connection.id, botId, true));
    const namespaces = await service.dynamicNamespaces(botId);
    expect(namespaces[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "add", "remember_note"]);
    await Effect.runPromise(service.renameAccount(connection.id,"renamed"));
    const renamed = await service.dynamicNamespaces(botId);
    expect(renamed[0]!.name).not.toBe(namespaces[0]!.name);
    await expect(service.invoke({connectionId:connection.id,namespace:namespaces[0]!.name,botId,runId,callId:"stale-account",toolName:"echo",arguments:{text:"wrong namespace"},allowReviewUI:false})).rejects.toMatchObject({code:"plugin_identifier_stale"});
    expect(await service.invoke({connectionId:connection.id,namespace:renamed[0]!.name,botId,runId,callId:"renamed-account",toolName:"echo",arguments:{text:"renamed namespace"},allowReviewUI:false})).toEqual({text:"renamed namespace"});

    const result = await service.invoke({
      connectionId: connection.id,
      botId,
      runId,
      callId: "plugin-call-echo-1",
      toolName: "echo",
      arguments: { text: "through the gateway" },
      allowReviewUI: false,
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

    await expect(service.invoke({
      connectionId: connection.id, botId, runId, callId: "automation-needs-review",
      toolName: "remember_note", arguments: { note: "needs parent review" }, allowReviewUI: false,
    })).rejects.toMatchObject({ code: "automation_parent_review_required" });
    expect(await prisma.approval.count({ where: { runId } })).toBe(0);
    expect(await prisma.pluginInvocation.findUnique({ where: { callId: "automation-needs-review" } })).toBeNull();
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
    await expect(
      service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-note-duplicate",
        toolName: "remember_note",
        arguments: { note: "requires approval" },
      })
    ).rejects.toMatchObject({ code: "plugin_approval_required" });
    expect(
      await prisma.approval.count({
        where: { runId, requestMethod: "plugin/tool", status: "pending" },
      })
    ).toBe(1);
    expect(
      await prisma.pluginInvocation.findUnique({
        where: { callId: "plugin-call-note-duplicate" },
      })
    ).toBeNull();
    const approval = await prisma.approval.findFirstOrThrow({
      where: { upstreamRequestId: "plugin:plugin-call-note-1" },
    });
    expect(await prisma.event.count({ where: { topic: "plugin.approval.requested", entityId: approval.id } })).toBe(1);
    // The assistant may end its turn while the user reviews the approval.
    await prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
    const runs = new RunService(
      prisma,
      async () => {
        throw new Error("Plugin approvals must not call the computer runtime");
      },
      async (callId, decision) => {
        if (failApprovedCall) {
          await prisma.pluginInvocation.update({ where: { callId }, data: { status: "failed", error: "Synthetic provider disconnect", completedAt: new Date() } });
          throw new Error("Synthetic provider disconnect");
        }
        return service.resolveInvocation(callId, decision);
      },
      (details, decision) => service.resolveAction(details, decision),
      (connectionId, approvedBotId, toolName) =>
        Effect.runPromise(
          service.setPolicy(connectionId, {
            botId: approvedBotId,
            toolName,
            decision: "allow",
          })
        ),
      { enqueueWake: async (_tx, input) => { wakes.push(input); return {} as never; } }
    );
    expect(await Effect.runPromise(runs.resolveApproval(approval.id, "accept"))).toMatchObject({
      status: "accepted",
      result: { remembered: true },
    });
    expect(
      await prisma.pluginInvocation.findUniqueOrThrow({ where: { callId: "plugin-call-note-1" } })
    ).toMatchObject({ status: "completed", result: { remembered: true } });
    expect(
      await prisma.pluginToolPolicy.findFirst({
        where: { connectionId: connection.id, botId, toolName: "remember_note" },
      })
    ).toBeNull();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ botId, channelId, origin: "handoff_resume", clientId: `plugin-approval:${approval.id}`, wrapUserContent: false });
    expect(wakes[0]!.content).toContain('"remembered":true');
    expect(wakes[0]!.content).toContain("not a request to repeat it");
    await Effect.runPromise(runs.resolveApproval(approval.id, "accept"));
    expect(wakes).toHaveLength(1);
    await expect(
      service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-note-2",
        toolName: "remember_note",
        arguments: { note: "always approved note" },
      })
    ).rejects.toMatchObject({ code: "plugin_approval_required" });
    const alwaysApproval = await prisma.approval.findFirstOrThrow({
      where: { upstreamRequestId: "plugin:plugin-call-note-2" },
    });
    expect(
      await Effect.runPromise(runs.resolveApproval(alwaysApproval.id, "always_allow"))
    ).toMatchObject({ status: "accepted", result: { remembered: true } });
    expect(
      await prisma.pluginToolPolicy.findFirstOrThrow({
        where: { connectionId: connection.id, botId, toolName: "remember_note" },
      })
    ).toMatchObject({ decision: "allow" });
    expect(
      await service.invoke({
        connectionId: connection.id,
        botId,
        runId,
        callId: "plugin-call-note-3",
        toolName: "remember_note",
        arguments: { note: "approved note" },
      })
    ).toEqual({ remembered: true });
    expect((await Effect.runPromise(service.settings())).activity.length).toBeGreaterThan(0);
    await Effect.runPromise(service.setPolicy(connection.id, { botId, toolName: "remember_note", decision: "prompt" }));
    await expect(service.invoke({ connectionId: connection.id, botId, runId, callId: "plugin-failed-approval", toolName: "remember_note", arguments: { note: "failure fixture" } })).rejects.toMatchObject({ code: "plugin_approval_required" });
    const failureApproval = await prisma.approval.findUniqueOrThrow({ where: { upstreamRequestId: "plugin:plugin-failed-approval" } });
    failApprovedCall = true;
    expect(await Effect.runPromise(runs.resolveApproval(failureApproval.id, "accept"))).toMatchObject({ status: "accepted", result: { status: "failed" } });
    expect(wakes.at(-1)!.content).toContain("outcome is uncertain");
    const wakeCount = wakes.length;
    await Effect.runPromise(runs.resolveApproval(failureApproval.id, "accept"));
    expect(wakes).toHaveLength(wakeCount);

    const skillDraft = await Effect.runPromise(service.management.importFiles({
      "plugin.json": JSON.stringify(createPluginTemplate("skills", "lifecycle-skills-fixture")),
    }));
    skillDraftId = skillDraft.id;
    await Effect.runPromise(service.install("lifecycle-skills-fixture"));
    expect(await service.skillInstructions(botId)).toBe("");
    await Effect.runPromise(service.setEnablement("lifecycle-skills-fixture", botId, true, true));
    expect(await service.skillInstructions(botId)).toContain("my-skill");
    expect(await service.skillInstructions(secondBotId)).toBe("");

    await Effect.runPromise(service.uninstall("test-utility"));
    await Effect.runPromise(service.uninstall("lifecycle-skills-fixture"));
    expect((await Effect.runPromise(service.settings())).installs).toHaveLength(0);

    await expect(
      service.requestAction({
        runId,
        botId,
        callId: "plugin-action-install-1",
        action: "InstallPlugin",
        arguments: { pluginKey: "lifecycle-skills-fixture" },
      })
    ).rejects.toMatchObject({ code: "plugin_action_required" });
    const actionApproval = await prisma.approval.findFirstOrThrow({
      where: { upstreamRequestId: "plugin-action:plugin-action-install-1" },
    });
    let actionSettled = false;
    const awaitingAction = service.waitForAction({runId,botId,callId:"plugin-action-install-1",action:"InstallPlugin",arguments:{pluginKey:"lifecycle-skills-fixture"}}).then(result=>{actionSettled=true;return result;});
    await Bun.sleep(20);expect(actionSettled).toBe(false);
    expect(
      await Effect.runPromise(runs.resolveApproval(actionApproval.id, "accept"))
    ).toMatchObject({ status: "accepted", result: { installed: true } });
    expect((await Effect.runPromise(service.settings())).installs[0]?.pluginKey).toBe(
      "lifecycle-skills-fixture"
    );
    expect(await awaitingAction).toMatchObject({completed:true,actionResult:{installed:true}});
    const replay = await service.requestAction({runId,botId,callId:"plugin-action-install-1",action:"InstallPlugin",arguments:{plugin_id:"lifecycle-skills-fixture"}});
    expect(replay).toMatchObject({status:"accepted",completed:true,actionResult:{installed:true},detail:{installed:true}});
    expect(renderControlResult("InstallPlugin", replay, {plugin_id:"lifecycle-skills-fixture"})).toStartWith("Installed ");
    expect(renderControlResult("InstallPlugin", replay, {plugin_id:"lifecycle-skills-fixture"})).toContain("(plugin lifecycle-skills-fixture).");
    const savedApproval = await prisma.approval.findUniqueOrThrow({where:{id:actionApproval.id}});
    expect(savedApproval.details).toMatchObject({actionResult:{installed:true}});
    await Effect.runPromise(service.uninstall("lifecycle-skills-fixture"));
  } finally {
    if (utilityDraftId) await prisma.pluginDraft.deleteMany({ where: { id: utilityDraftId } });
    if (skillDraftId) await prisma.pluginDraft.deleteMany({ where: { id: skillDraftId } });
    await service.close();
    await prisma.$disconnect();
  }
});
