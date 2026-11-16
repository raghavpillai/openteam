import { expect } from "bun:test";
import { Effect } from "effect";
import { AUTOMATION_PARENT_ONLY_TOOLS } from "@openteam/contracts";
import { AgentMessaging, saveSilentAutomationResult } from "@openteam/messaging";
import { InternalToolService } from "../src/services/internal-tool-service";
import { dbIt } from "./harness";

dbIt("WakeParent atomically queues once; silent results survive restart and acknowledge only delivered audience receipts", async h => {
  const scheduled: unknown[] = [];
  const messaging = new AgentMessaging(h.db, { send: async (...args: unknown[]) => { scheduled.push(args); } } as never, h.store);
  const tools = (host = messaging) => new InternalToolService(h.db, host, {} as never, async () => {}, {} as never, {} as never, {} as never, {} as never);
  const bot = await h.bot("Automation parent");
  const { id: botId, conversationId } = bot, channelId = bot.channelId!;
  const room = await h.channel({ kind: "group", name: "Different room", members: { create: { botId, ordinal: 0 } } });
  const createRun = async (origin: "routine" | "user" = "routine") => h.run(bot, { origin });
  const call = (runId: string, tool: string, args: unknown, service = tools()) => Effect.runPromise(service.execute({ botId, conversationId, channelId, deliveryId: null, runId, tool, arguments: args, callId: crypto.randomUUID() }));
  const handoffMessage = async (runId: string) => (await h.db.automationResult.findUniqueOrThrow({ where: { runId } })).message;

  const run = await createRun();
  for (const tool of AUTOMATION_PARENT_ONLY_TOOLS) await expect(call(run.id, tool, {})).rejects.toThrow("Automation runs cannot mutate the visible transcript.");
  // Routine runs move files through connectors, like their parent, until they hand off.
  const transfers = tools();
  (transfers as unknown as { plugins: unknown }).plugins = { fileTransfers: { prepare: async (_context: unknown, args: { tool: string }) => ({ prepared: args.tool }) } };
  for (const tool of ["UploadFile", "DownloadFile"]) expect(await call(run.id, "PrepareConnectorTransfer", { tool, input: {} }, transfers)).toEqual({ prepared: tool });
  await expect(call((await createRun("user")).id, "WakeParent", { message: "Wrong mode" })).rejects.toThrow("active automation");
  for (const message of ["", "  "]) await expect(call(run.id, "WakeParent", { message })).rejects.toThrow();
  expect(await h.db.automationResult.count({ where: { run: { botId } } })).toBe(0);

  const handoff = "Deployment failed in staging. Tell the user that tests failed; do not deploy.";
  const receipts = await Promise.all(Array.from({ length: 4 }, () => call(run.id, "WakeParent", { message: handoff })));
  for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
  expect(receipts[0]).toMatchObject({ woken: true });
  expect(scheduled).toHaveLength(1);
  expect(await h.db.inboxEvent.count({ where: { type: "automation.wake_parent", botId } })).toBe(1);
  const result = await h.db.automationResult.findUniqueOrThrow({ where: { runId: run.id } });
  expect(result.message).toBe(handoff);
  const wake = await h.db.run.findUniqueOrThrow({ where: { id: result.wakeRunId! }, include: { inboxEvents: true } });
  expect(wake).toMatchObject({ botId, channelId, origin: "background_revival", status: "queued" });
  const payload = JSON.stringify(wake.inboxEvents[0]?.payload);
  expect(payload).toContain(handoff);
  // The parent writes the outward message itself, and the handoff stays owed past new user messages.
  expect(payload).toContain("Treat the handoff text as private context and write the outward message yourself.");
  expect(payload).toContain("This handoff is still owed even if the user has sent you something new since it arrived");
  expect(await h.db.channelMessage.count({ where: { sourceRunId: run.id } })).toBe(0);
  // A new service instance and a changed call id/body must not redeliver or rewrite the committed handoff.
  expect(await call(run.id, "WakeParent", { message: "Do not replace the original" }, tools(new AgentMessaging(h.db, messaging.boss, h.store)))).toEqual(receipts[0]);
  expect(await handoffMessage(run.id)).toBe(handoff);
  await expect(call(run.id, "TodoWrite", { todos: [] })).rejects.toThrow("already handed control");
  await expect(call(run.id, "PrepareConnectorTransfer", { tool: "UploadFile", input: {} }, transfers)).rejects.toThrow("already handed control");

  const addFinal = async (runId: string, content: string) => {
    const at = new Date("2026-09-14T12:00:00Z");
    const message = await h.db.message.create({ data: { botId, conversationId, runId, role: "assistant", status: "completed", content, createdAt: at, updatedAt: at } });
    await h.db.event.create({ data: { topic: "run_item.completed", entityId: runId, payload: { runId, item: { id: message.id, type: "agentMessage", text: content } } } });
  };
  const saveSilent = (runId: string) => h.db.$transaction(tx => saveSilentAutomationResult(tx, runId));
  await addFinal(run.id, "Do not overwrite the explicit handoff");
  await saveSilent(run.id);
  expect(await handoffMessage(run.id)).toBe(handoff);

  const silent = await createRun();
  await addFinal(silent.id, "Earlier progress is private scratch space.");
  await addFinal(silent.id, "All systems unchanged; record the check silently.");
  await saveSilent(silent.id);
  expect(scheduled).toHaveLength(1);
  const home = await h.db.contextSession.create({ data: { botId, scope: "home", scopeId: conversationId } });
  const automation = await h.db.contextSession.create({ data: { botId, scope: "automation", scopeId: silent.id } });
  const restarted = new AgentMessaging(h.db, messaging.boss, h.store);
  const prompt = await restarted.platformPrompt(botId, home.id, "", channelId);
  expect(prompt.ambientContext).toContain("All systems unchanged");
  expect(prompt.ambientContext).not.toContain("Earlier progress");
  expect(prompt.ambientContext).not.toContain(handoff);
  expect((await restarted.platformPrompt(botId, home.id, "", room.id)).ambientContext ?? "").not.toContain("All systems unchanged");
  const routinePrompt = await restarted.platformPrompt(botId, automation.id, "", channelId);
  expect(routinePrompt.instructions).toContain("WakeParent is the only way to reach the user or another agent from this run");
  expect(routinePrompt.instructions).not.toContain("## How a turn works");
  expect(routinePrompt.ambientContext).toBeNull();
  await restarted.acknowledgePlatformPrompt(botId, automation.id, routinePrompt);
  expect((await h.db.automationResult.findUniqueOrThrow({ where: { runId: silent.id } })).acknowledgedAt).toBeNull();
  const later = await createRun();
  await addFinal(later.id, "A newer silent result arrived after the prompt was built.");
  await saveSilent(later.id);
  await restarted.acknowledgePlatformPrompt(botId, home.id, prompt);
  const refreshed = await restarted.platformPrompt(botId, home.id, "", channelId);
  expect(refreshed.ambientContext).not.toContain("All systems unchanged");
  expect(refreshed.ambientContext).toContain("A newer silent result");

  // A scheduling failure rolls back both result and parent inbox, allowing a safe retry.
  const failed = await createRun();
  const failing = new AgentMessaging(h.db, { send: async () => { throw new Error("queue fixture failed"); } } as never, h.store);
  await expect(call(failed.id, "WakeParent", { message: "Retry after storage recovers" }, tools(failing))).rejects.toThrow("queue fixture failed");
  expect(await h.db.automationResult.findUnique({ where: { runId: failed.id } })).toBeNull();
  expect(await h.db.inboxEvent.findUnique({ where: { idempotencyKey: `automation:${failed.id}:wake-parent` } })).toBeNull();
  expect(await call(failed.id, "WakeParent", { message: "Retry after storage recovers" })).toMatchObject({ woken: true });

  // Background shells resume the original automation context, including after restart.
  const shellRun = await createRun();
  const completion = { id: "shell-fixture", scope: botId, automationRunId: shellRun.id, channelId, outputPath: "/tmp/fixture.log", exitCode: 0 };
  await restarted.completeShell(completion);
  const shellWake = await h.db.inboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `shell-completion:${botId}:shell-fixture` }, include: { run: true } });
  expect(shellWake.run.origin).toBe("routine");
  expect(shellWake.payload).toMatchObject({ automationContextRunId: shellRun.id });
  expect(await restarted.completeShell(completion)).toMatchObject({ duplicate: true });
  // A continuation hands off once for the whole automation, not once per callback.
  await h.db.run.update({ where: { id: shellWake.runId }, data: { status: "running" } });
  const continued = await call(shellWake.runId, "WakeParent", { message: "Shell completed; notify the user." });
  expect(continued).toMatchObject({ woken: true });
  expect(await handoffMessage(shellRun.id)).toBe("Shell completed; notify the user.");
  expect(await call(shellRun.id, "WakeParent", { message: "Duplicate from original turn" })).toEqual(continued);
  await expect(call(shellWake.runId, "TodoWrite", { todos: [] })).rejects.toThrow("already handed control");
  // After the handoff, the automation's background work no longer wakes anyone.
  expect(await restarted.completeShell({ ...completion, id: "shell-after-handoff" })).toEqual({ delivered: false, ignored: true });
  expect(await h.db.inboxEvent.findUnique({ where: { idempotencyKey: `shell-completion:${botId}:shell-after-handoff` } })).toBeNull();
}, 30_000);
