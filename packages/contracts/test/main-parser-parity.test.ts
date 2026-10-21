import {expect,test} from "bun:test";
import {describeTrigger,normalizeMainToolArguments} from "../src/reference-main-parsers";
import {parseHostAwaitShellRequest} from "../src/service-protocol";
import {ShellToolInput, UPDATE_ROUTINE_TOOL} from "../src";
import {Schema} from "effect";

test("shell waits accept captured numeric spellings and preserve the delivery envelope",()=>{
  expect(normalizeMainToolArguments("Shell",{command:"true",block_until_ms:" 12.9 "})).toMatchObject({block_until_ms:12});
  expect(parseHostAwaitShellRequest({shell_id:12,block_until_ms:" 0 "})).toEqual({shell_id:"12",block_until_ms:0});
  expect(parseHostAwaitShellRequest({block_until_ms:"-1"})).toEqual({block_until_ms:30_000});
  expect(()=>parseHostAwaitShellRequest({block_until_ms:""})).toThrow();
  expect(()=>parseHostAwaitShellRequest({block_until_ms:"7140001"})).toThrow();
  expect(normalizeMainToolArguments("SendToUser",{type:"text",content:"done",end_turn:true})).toMatchObject({end_turn:true});
  expect(Schema.decodeUnknownSync(ShellToolInput)(normalizeMainToolArguments("Shell",{command:"true",block_until_ms:"8000000"}))).toMatchObject({block_until_ms:8_000_000});
});
test("email routine triggers parse, describe, and validate against the model-facing schema", async () => {
  const { createToolValidator } = await import("@openteam/plugin-sdk/json-schema");
  const validate = createToolValidator(UPDATE_ROUTINE_TOOL.inputSchema);
  const trigger = { type: "email", inbox: "bot@raghav.sh", from: ["me@raghav.sh", "@partner.com"] };
  const input = { action: "create", name: "Reply to mail", prompt: "Answer the sender.", trigger };
  expect(validate(input).valid).toBe(true);
  expect(validate({ ...input, trigger: [{ type: "cron", schedule: "0 9 * * 1-5" }, trigger] }).valid).toBe(true);
  expect(validate({ ...input, trigger: { type: "group", listeners: [{ type: "cron", schedule: "0 9 * * 1-5" }, trigger] } }).valid).toBe(true);
  expect(validate({ ...input, trigger: { type: "email" } }).valid).toBe(false);
  expect(normalizeMainToolArguments("UpdateRoutine", input).trigger).toEqual(trigger);
  expect(() => normalizeMainToolArguments("UpdateRoutine", { ...input, trigger: { type: "group", listeners: [{ type: "origin", repo: "o/r", events: ["pr-opened"] }, trigger] } })).toThrow("Origin can't be grouped with email");
  expect(describeTrigger(trigger)).toBe("When email arrives at bot@raghav.sh");
  expect(describeTrigger({ ...trigger, requireAuthPass: false })).toBe("When email arrives at bot@raghav.sh, including unauthenticated senders");
  expect(describeTrigger({ type: "group", listeners: [{ type: "cron", schedule: "0 9 * * 1-5" }, trigger] })).toContain("or when email arrives at bot@raghav.sh");
});
test("parsers keep the reference arguments OpenTeam supports", async () => {
  const { renderControlResult } = await import("../src/tool-results");
  expect(normalizeMainToolArguments("ReactToMessage", { message_address: "t3u", emoji: "👍", end_turn: true })).toEqual({ message_address: "t3u", emoji: "👍", end_turn: true });
  const handoff = { instruction: "Sign in", domain: "example.com", idp_domain: "accounts.example.com", url: "https://app.example.com/login" };
  expect(normalizeMainToolArguments("request_box_help", handoff)).toEqual(handoff);
  expect(normalizeMainToolArguments("StopSubagent", { all: true })).toEqual({ all: true });
  expect(normalizeMainToolArguments("StopSubagent", { subagent_id: " sand-subagent-1 " })).toEqual({ subagent_id: "sand-subagent-1" });
  for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
    expect(() => normalizeMainToolArguments("StopSubagent", invalid), JSON.stringify(invalid)).toThrow("exactly one");
  const entry = (id: string) => ({ subagent_id: `sand-subagent-${id}`, subagent_type: "executor", title: `Worker ${id}` });
  const receipt = renderControlResult("StopSubagent", {
    stopped_all: true, stopped: [entry("a")], already_finished: [entry("b")], failed: [{ ...entry("c"), error: "timeout" }],
  }, { all: true }).split("\n");
  expect(receipt).toEqual([
    "Stopped 1 of 3 running subagent(s). They are torn down and will not report back:",
    '- sand-subagent-a [executor] "Worker a"',
    "1 had already finished before the stop reached them (you are revived with a finished subagent's result separately):",
    '- sand-subagent-b [executor] "Worker b"',
    "1 could NOT be stopped and may still be running. Retry each with StopSubagent and its id; if it still fails, tell the user which work may still be running:",
    '- sand-subagent-c [executor] "Worker c": timeout',
    expect.stringContaining("Peer agents you handed work to are not reached from here"),
    expect.stringContaining("Do not resume, redispatch, or continue the stopped work"),
  ]);
  expect(renderControlResult("StopSubagent", { stopped_all: true, stopped: [], already_finished: [], failed: [] }, { all: true }))
    .toStartWith("No background subagents are running, so there was nothing of your own to stop.");
});

test("the subagent tools take the reference's other names for subagent_id and refuse names that disagree", () => {
  for (const alias of ["agentId", "agent_id", "subagentId", "target", "target_id", "id", "to"])
    expect(normalizeMainToolArguments("CheckSubagent", { [alias]: "sand-subagent-1" }), alias).toEqual({ subagent_id: "sand-subagent-1" });
  expect(normalizeMainToolArguments("MessageSubagent", { agent_id: "sand-subagent-1", message: "Try the second tab." }))
    .toEqual({ subagent_id: "sand-subagent-1", message: "Try the second tab." });
  expect(normalizeMainToolArguments("StopSubagent", { id: "sand-subagent-1" })).toEqual({ subagent_id: "sand-subagent-1" });
  expect(normalizeMainToolArguments("StopSubagent", { subagent_id: "sand-subagent-1", id: "sand-subagent-2" })).toEqual({ subagent_id: "sand-subagent-1" });
  expect(() => normalizeMainToolArguments("MessageSubagent", { agentId: "sand-subagent-1", to: "sand-subagent-2", message: "x" }))
    .toThrow("Pass the subagent's id once, as subagent_id (from the Task result that dispatched it).");
});

test("Computer takes other tools' action names for the action they mean, also in then", async () => {
  const { applyComputerActionAliases, computerArgumentsWithAliases } = await import("../src/computer-action-aliases");
  expect(normalizeMainToolArguments("Computer", { action: "left_click", x: 4, y: 5 })).toMatchObject({ action: "click", button: "left", x: 4, y: 5 });
  expect(normalizeMainToolArguments("Computer", { action: "double_click", x: 4, y: 5 })).toMatchObject({ action: "click", count: 2 });
  expect(normalizeMainToolArguments("Computer", { action: "screenshot", then: [{ action: "mouse_move", x: 1, y: 2 }, { action: "type", text: "hi" }] }).then)
    .toEqual([{ action: "move", x: 1, y: 2 }, { action: "type", text: "hi" }]);
  expect(applyComputerActionAliases({ action: "triple_click", count: 3 })).toEqual({ kind: "value", value: { action: "click", count: 3 } });
  expect(() => normalizeMainToolArguments("Computer", { action: "double_click", count: 3, x: 1, y: 1 }))
    .toThrow("Computer has no double_click action, and it would mean count 2, not 3.");
  expect(() => computerArgumentsWithAliases({ action: "click", x: 1, y: 1, then: [{ action: "left_click", text: "a" }] })).toThrow(
    'Invalid arguments:\nthen.0.action: Computer has no left_click action, and click takes no text. Send action "click"; to hold keys during it, set modifiers, e.g. "shift" or "ctrl+shift".'
  );
  const unchanged = { action: "key", key: "Return" };
  expect(computerArgumentsWithAliases(unchanged)).toBe(unchanged);
});

test("CheckSubagent and MessageSubagent results read as the reference words them", async () => {
  const { renderControlResult } = await import("../src/tool-results");
  const child = {
    subagent_id: "sand-subagent-1", title: "Find the three cheapest nonstop flights", subagent_type: "executor", status: "running",
    elapsed_seconds: 125, tool_call_count: 3, transcript_path: "/home/box/agent-data/agent-transcripts/c/c.jsonl",
    recent_tool_calls: [{ tool: "WebSearch", status: "running" }, { tool: "Shell", status: "completed" }, { tool: "Read", status: "cancelled" }],
  };
  expect(renderControlResult("CheckSubagent", child, { subagent_id: "sand-subagent-1" }).split("\n").slice(0, 5)).toEqual([
    '- sand-subagent-1 [executor] "Find the three cheapest nonstop flights": running for 2m 5s, 3 tool call(s)',
    "  Recent activity (oldest first):",
    "    [failed] Read",
    "    [done] Shell",
    "    [pending] WebSearch",
  ]);
  expect(renderControlResult("CheckSubagent", { subagents: [{ ...child, elapsed_seconds: 42 }] }, {})).toBe(
    '1 subagent(s) running:\n- sand-subagent-1 [executor] "Find the three cheapest nonstop flights": running for 42s, 3 tool call(s)\nPass a subagent_id to see its recent activity and transcript path.'
  );
  expect(renderControlResult("MessageSubagent", { delivered: true }, { subagent_id: "sand-subagent-1", message: "x" })).toBe(
    "Message delivered to subagent sand-subagent-1. It will interrupt what it's doing, take your message into account, and keep working. You'll be revived with its result when it finishes, so don't wait on it."
  );
});
