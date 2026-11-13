import { expect, test } from "bun:test";
import { checkDraftFollowupDelivery } from "../../src/runtime/draft-followup";
import type { ActiveTurn } from "../../src/runtime/types";

const activeTurn = (extra: Partial<ActiveTurn> = {}) => ({
  requestSource: "event", draftStatusAcknowledged: true, sentMessageCount: 0,
  lastStopReason: "stop", ...extra,
}) as ActiveTurn;
const sessionWithText = (text: string, prompt: (text: string) => Promise<void>) => ({
  messages: [{ role: "assistant", content: [{ type: "text", text }] }], prompt,
}) as unknown as Parameters<typeof checkDraftFollowupDelivery>[1];

test("an internal draft follow-up gets a conditional chance to call SendToUser", async () => {
  for (const text of ["Would you like revisions?", "Disk check failed. Please pause downloads."]) {
    const active = activeTurn(), delivered: string[] = [];
    await checkDraftFollowupDelivery(active, sessionWithText(text, async reminder => {
      expect(reminder).toContain("actually invoke SendToUser");
      expect(reminder).toContain("finish silently");
      delivered.push(text); active.sentMessageCount++;
    }));
    expect(delivered).toEqual([text]);
  }
});

test("a status-only continuation can finish silently after one conditional check", async () => {
  const active = activeTurn(); let prompts = 0;
  await checkDraftFollowupDelivery(active, sessionWithText("The platform already acknowledged this.", async () => { prompts++; }));
  expect(prompts).toBe(1);
  expect(active.sentMessageCount).toBe(0);
});

test("delivered, cancelled, failed, ordinary events and empty outputs do not get a draft follow-up prompt", async () => {
  const aborted = new AbortController(); aborted.abort();
  for (const state of [
    { sentMessageCount: 1 }, { endTurnRequested: true }, { lastStopReason: "aborted" },
    { lastStopReason: "error" }, { pluginAbortController: aborted },
    { draftStatusAcknowledged: false }, { requestSource: "turn" as const },
  ]) {
    await checkDraftFollowupDelivery(activeTurn(state), sessionWithText("Question?", async () => { throw new Error("Unexpected prompt"); }));
  }
  await checkDraftFollowupDelivery(activeTurn(), sessionWithText("", async () => { throw new Error("Unexpected empty-output prompt"); }));
});
