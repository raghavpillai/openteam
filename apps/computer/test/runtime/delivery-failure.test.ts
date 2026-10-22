import { expect, test } from "bun:test";
import { CLOSING_SEND_NUDGE_PROMPT, ComputerRuntime, MAX_REPLY_NUDGES, REPLY_NUDGE_PROMPT } from "../../src/runtime";
import { routeEvent } from "../../src/runtime/events";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: unknown = {}) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, isError = false) => ({ role: "toolResult", toolCallId: id, isError, content: [] });
const ack = [call("ack", "SendToUser", { content: "On it." }), result("ack")];
const task = [call("task", "CallDynamicTool", { namespace: "cursor", toolName: "Task", arguments: { prompt: "x" } }), result("task")];

function fixture(options: { sent?: number; endTurn?: boolean; requestSource?: string; messages: any[]; onPrompt?: (prompt: string, active: any) => void }) {
  const runtime = new ComputerRuntime() as any;
  const events: any[] = [];
  const prompts: string[] = [];
  const active: any = {
    contextSessionId: "fixture", runId: "fixture", turnId: "fixture", botId: "fixture",
    runtimeProfile: "agent", subagentType: null, requestSource: options.requestSource ?? "turn",
    modelRef: { providerId: "fixture", modelId: "fixture" }, instructions: "fixture",
    sentMessageCount: options.sent ?? 0, endTurnRequested: options.endTurn, lastStopReason: "stop",
    attachmentTempDirectories: [], toolArgs: new Map(), pluginAbortController: new AbortController(),
    queue: { push: (event: any) => events.push(event), end() {} },
  };
  const messages = [user("<timestamp>now</timestamp>\n<user_query>do it</user_query>"), ...options.messages];
  active.session = {
    async prompt(prompt: string) {
      if (prompts.length || prompt !== "fixture") prompts.push(prompt);
      else prompts.push("turn");
      if (prompt !== "fixture") messages.push(user(prompt));
      options.onPrompt?.(prompt, active);
    },
    getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [], messages,
  };
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  return { runtime, active, events, prompts, messages };
}

test("a rejected attachment after end_turn settles the turn without a nudge or a failure", async () => {
  const { runtime, active, events, prompts } = fixture({
    messages: [],
    onPrompt: (_prompt, active) => {
      active.sentMessageCount = 1;
      active.endTurnRequested = true;
      routeEvent(undefined, active, { type: "tool_execution_start", toolCallId: "zip", toolName: "SendToUser", args: { type: "attachment", url: "file:///workspace/result.zip" } } as any);
      routeEvent(undefined, active, { type: "tool_execution_end", toolCallId: "zip", toolName: "SendToUser", isError: true, result: { content: [{ type: "text", text: "The turn has ended after delivery; wait for the next user message." }] } } as any);
    },
  });
  await runtime.execute(active, "fixture", []);
  expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "completed" });
  expect(prompts).toEqual(["turn"]);
});

test("a turn that never sends is nudged up to three times and still settles as completed", async () => {
  const { runtime, active, events, prompts } = fixture({ messages: [] });
  await runtime.execute(active, "fixture", []);
  expect(MAX_REPLY_NUDGES).toBe(3);
  expect(prompts).toEqual(["turn", REPLY_NUDGE_PROMPT, REPLY_NUDGE_PROMPT, REPLY_NUDGE_PROMPT]);
  expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "completed" });
});

test("reply nudges stop once something is delivered", async () => {
  const { runtime, active, prompts } = fixture({
    messages: [],
    onPrompt: (prompt, active) => { if (prompt === REPLY_NUDGE_PROMPT) { active.sentMessageCount = 1; active.endTurnRequested = true; } },
  });
  await runtime.execute(active, "fixture", []);
  expect(prompts).toEqual(["turn", REPLY_NUDGE_PROMPT]);
});

test("an acknowledgement followed only by unreported tool calls gets the closing nudge once", async () => {
  const { runtime, active, events, prompts } = fixture({ sent: 1, messages: [...ack, ...task, { role: "assistant", content: [] }] });
  await runtime.execute(active, "fixture", []);
  expect(prompts).toEqual(["turn", CLOSING_SEND_NUDGE_PROMPT]);
  expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "completed" });
});

for (const [name, messages] of [
  ["a later send reported the work", [...ack, ...task, call("started", "SendToUser", { content: "Started." }), result("started")]],
  ["the acknowledgement went out with the dispatch", [{ role: "assistant", content: [...ack[0]!.content, ...task[0]!.content] }, result("ack"), result("task")]],
  ["the first tool step was not an acknowledgement", [call("schema", "GetDynamicTools", { namespace: "cursor" }), result("schema"), ...ack, ...task]],
] as const) {
  test(`no closing nudge when ${name}`, async () => {
    const { runtime, active, prompts } = fixture({ sent: 1, messages: [...messages] });
    await runtime.execute(active, "fixture", []);
    expect(prompts).toEqual(["turn"]);
  });
}

test("routine runs and cancelled turns get no nudge", async () => {
  for (const variant of ["automation", "cancelled"] as const) {
    const { runtime, active, events, prompts } = fixture({
      requestSource: variant === "automation" ? "automation" : "turn",
      messages: [...ack, ...task],
      sent: 1,
      onPrompt: (_prompt, active) => { if (variant === "cancelled") active.pluginAbortController.abort(); },
    });
    await runtime.execute(active, "fixture", []);
    expect(prompts).toEqual(["turn"]);
    expect(events.find((event) => event.type === "turn.completed").status).toBe(variant === "cancelled" ? "interrupted" : "completed");
  }
});

test("a provider failure still fails the turn", async () => {
  const { runtime, active, events } = fixture({ messages: [], onPrompt: () => { throw new Error("Provider unavailable"); } });
  await runtime.execute(active, "fixture", []);
  const completion = events.find((event) => event.type === "turn.completed");
  expect(completion.status).toBe("failed");
  expect(completion.error.message).toContain("Provider unavailable");
});
