import { expect, test } from "bun:test";
import { Effect } from "effect";
import { dispatchTaskContinuations } from "@openteam/messaging";
import { databaseUrl, startStack, type Call, type Turn } from "./fixtures/stack";

const final = (input: Turn, text: string) => ({ events: [{ type: "item.completed", turnId: input.runId, item: { id: `final-${input.runId}`, type: "agentMessage", text } }] });
const replies: Array<[string, string]> = [
  ["EXPORT_FINISHED", "Export workflow finished."],
  ["DOCUMENT_FINISHED", "Document workflow finished."],
  ["UNRELATED", "Unrelated question answered."],
];

test.skipIf(!databaseUrl)("real queue preserves delayed work across host recreation and reconciles an accepted action after lost completion", async () => {
  let exportAccepted = false, documentActions = 0, documentReady = false, parentId = "";
  async function subagent(input: Turn, call: Call) {
    if (input.content.includes("EXPORT_WORKFLOW")) {
      // The external service accepted the action, but the host never got an authoritative
      // completion or a progress checkpoint.
      if (!exportAccepted) return (exportAccepted = true), { complete: false };
      expect(input.instructions).toContain("reconciliationRequired");
      expect(input.content).toContain("before repeating");
      await call("ReportTaskProgress", { key: "export-confirmed", state: "complete", summary: "Export receipt independently verified", evidence: ["/exports/receipt"], remaining: [] });
      return final(input, "Status: done\nEXPORT_FINISHED: service receipt verified; no duplicate submission.");
    }
    if (!input.content.includes("DOCUMENT_WORKFLOW")) return;
    if (!documentReady) {
      documentActions++;
      const wait = {
        key: "document-pending", state: "waiting", summary: "Submission accepted; required document pending",
        evidence: ["/requests/receipt"], remaining: ["Supply the requested document and verify final acceptance"],
        nextAction: "Read the request and provide the authorized document, with no additional fee",
        checkAt: new Date(Date.now() + 3600_000).toISOString(), deadline: new Date(Date.now() + 7200_000).toISOString(),
      };
      await call("ReportTaskProgress", wait);
      await call("ReportTaskProgress", wait);
      return;
    }
    expect(input.instructions).toContain("Supply the requested document");
    expect(input.content).toContain("no additional fee");
    await call("ReportTaskProgress", { key: "document-confirmed", state: "complete", summary: "Required document accepted and final outcome verified", evidence: ["/requests/final-receipt"], remaining: [] });
    return final(input, "Status: done\nDOCUMENT_FINISHED: final acceptance verified.");
  }
  const stack = await startStack({
    streaming: true,
    async turn(input, call) {
      if (input.runtimeProfile === "subagent") return subagent(input, call);
      const task = (description: string, subagent_type: string, prompt: string, resume?: string) =>
        call("Task", { description, subagent_type, prompt, ...(resume ? { resume } : {}) });
      if (input.content.includes("START_EXPORT"))
        return void (await task("Export reconciliation", "executor", "EXPORT_WORKFLOW: Generate the approved export once. Verify its receipt; do not publish it elsewhere or incur fees."));
      if (input.content.includes("START_DOCUMENT"))
        return void (await task("Document acceptance", "executor", "DOCUMENT_WORKFLOW: Finish the approved request, including its later document question. Do not accept any additional fee."));
      const reply = replies.find(([marker]) => input.content.includes(marker))?.[1] ?? "Fixture ready.";
      await call("SendToUser", { content: reply, end_turn: true });
    },
  });
  try {
    const db = () => stack.app.prisma;
    const bot = await Effect.runPromise(stack.app.createBot({ clientRequestId: crypto.randomUUID(), name: "Durable work fixture" }));
    parentId = bot.id;
    const send = (content: string) => Effect.runPromise(stack.app.sendMessage(bot.conversationId, { clientId: crypto.randomUUID(), content }));
    const replied = (content: string) => stack.until(async () => (await db().channelMessage.count({ where: { senderBotId: parentId, content } })) === 1, content);
    const task = (description: string) => db().subagent.findFirstOrThrow({ where: { parentBotId: parentId, description } });
    const lateCompletion = (row: { childBotId: string; currentRunId: string | null }) =>
      db().$transaction((tx) => (stack.worker as any).completeSubagent(tx, { botId: row.childBotId, runId: row.currentRunId }));
    const continuations = () => dispatchTaskContinuations(db(), stack.app.messaging, new Date(Date.now() + 3600_000));
    await stack.until(async () => (await db().bot.findUnique({ where: { id: parentId } }))?.onboardingStatus === "completed", "onboarding");

    await send("START_EXPORT");
    await stack.until(async () => (await db().subagent.count({ where: { parentBotId: parentId, description: "Export reconciliation", status: "waiting" } })) === 1, "export fenced");
    // A late callback cannot close a task already fenced for reconciliation.
    await lateCompletion(await task("Export reconciliation"));
    expect((await task("Export reconciliation")).status).toBe("waiting");
    await replied("Export workflow finished.");
    expect(await task("Export reconciliation")).toMatchObject({ status: "completed", recoveryAttempts: 1 });

    await send("START_DOCUMENT");
    await stack.until(async () => (await db().subagent.count({ where: { parentBotId: parentId, status: "waiting" } })) === 1, "document waiting");
    expect((await task("Document acceptance")).nextCheckAt).not.toBeNull();
    await send("UNRELATED question while the document is pending");
    await replied("Unrelated question answered.");
    expect((await task("Document acceptance")).status).toBe("waiting");
    await stack.shutdown();
    documentReady = true;
    await stack.boot();
    expect(await continuations()).toBe(1);
    await replied("Document workflow finished.");
    expect(documentActions).toBe(1);
    const document = await task("Document acceptance");
    expect(document.status).toBe("completed");
    expect(await db().subagentAttempt.count({ where: { subagentId: document.id } })).toBe(2);

    expect(stack.errors).toEqual([]);
  } finally {
    await stack.close();
  }
}, 180_000);
