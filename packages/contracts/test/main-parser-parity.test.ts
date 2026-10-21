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
  // The advertised trigger names only its type; the parser answers a bad one with every shape.
  expect(validate({ ...input, trigger: { type: "email" } }).valid).toBe(true);
  expect(validate({ ...input, trigger: { type: "imap" } }).valid).toBe(false);
  let invalid: unknown;
  try { normalizeMainToolArguments("UpdateRoutine", { ...input, trigger: { type: "email" } }); } catch (error) { invalid = error; }
  const issues = (invalid as { issues: Array<{ path: string[]; message: string }> }).issues;
  expect(JSON.stringify(issues[0])).toContain('"path":["inbox"]');
  expect(issues.at(-1)!.path).toEqual(["trigger"]);
  expect(issues.at(-1)!.message).toStartWith('Not a valid trigger. Trigger shapes:\n  { "type": "slack"');
  expect(issues.at(-1)!.message).toContain('{ "type": "email", "inbox": "<one of the user\'s connected Email plugin inbox addresses (ListEmailInboxes)>"');
  expect(issues.at(-1)!.message).toEndWith('"blockUnauthenticatedTeamsUsers": true to ignore messages from unauthenticated Teams users.');
  expect(normalizeMainToolArguments("UpdateRoutine", { action: "get", id: "brief" })).toEqual({ action: "get", id: "brief" });
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
  const entry = (id: string) => ({ subagent_id: `sand-subagent-${id}`, subagent_type: "executor", description: `Worker ${id}` });
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
test("a dated cron is described as a one-off", () => {
  expect(describeTrigger({ type: "cron", schedule: "36 10 21 10 *" })).toBe("Once October 21 at 10:36 AM");
  expect(describeTrigger({ type: "cron", schedule: "CRON_TZ=America/New_York 5 17 3 2 *" })).toBe("Once February 3 at 5:05 PM (America/New_York)");
  // Not one-offs: a weekday restriction, several days, an impossible date, or a calendar shorthand.
  expect(describeTrigger({ type: "cron", schedule: "0 9 21 10 1" })).not.toStartWith("Once");
  expect(describeTrigger({ type: "cron", schedule: "0 9 1,15 10 *" })).not.toStartWith("Once");
  expect(describeTrigger({ type: "cron", schedule: "0 9 31 2 *" })).not.toStartWith("Once");
  expect(describeTrigger({ type: "cron", schedule: "@yearly" })).not.toStartWith("Once");
  expect(describeTrigger({ type: "cron", schedule: "0 9 * * *" })).toBe("Every day at 9:00 AM");
});
