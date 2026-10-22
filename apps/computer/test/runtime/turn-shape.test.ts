import { expect, test } from "bun:test";
import { turnEndedOnSilentToolCalls } from "../../src/runtime/turn-shape";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const step = (...calls: Array<[string, string, unknown?]>) => ({
  role: "assistant",
  content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args ?? {} })),
});
const result = (id: string, isError = false) => ({ role: "toolResult", toolCallId: id, isError, content: [] });
const text = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const query = user("<system_reminder>\nReply with SendToUser.\n</system_reminder>\n<timestamp>now</timestamp>\n<user_query>\nmake it\n</user_query>");
const send = (id: string): [string, string, unknown] => [id, "SendToUser", { content: "On it." }];
const task = (id = "task"): [string, string, unknown] => [id, "CallDynamicTool", { namespace: "cursor", toolName: "Task", arguments: {} }];

test("an acknowledgement, then only work, ended silently", () => {
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), step(task()), result("task"), text("")])).toBe(true);
});

test("a background dispatch counts as work unless a later send reports it", () => {
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), step(task()), result("task"), step(send("started")), result("started")])).toBe(false);
});

test("a send through the cursor namespace reports work; a connector's tool named alike does not", () => {
  const dynamicSend = (namespace: string): [string, string, unknown] => ["late", "CallDynamicTool", { namespace, toolName: "SendToUser", arguments: {} }];
  const turn = (namespace: string) => [query, step(send("ack")), result("ack"), step(task()), result("task"), step(dynamicSend(namespace)), result("late"), step(task("more")), result("more")];
  expect(turnEndedOnSilentToolCalls(turn("cursor"))).toBe(false);
  expect(turnEndedOnSilentToolCalls(turn("user-slack"))).toBe(true);
});

test("a failed later send does not report the work", () => {
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), step(task()), result("task"), step(send("late")), result("late", true), step(task("more")), result("more")])).toBe(true);
});

test("only an acknowledgement in the first tool step counts", () => {
  expect(turnEndedOnSilentToolCalls([query, step(["schema", "GetDynamicTools"]), result("schema"), step(send("ack")), result("ack"), step(task()), result("task")])).toBe(false);
  expect(turnEndedOnSilentToolCalls([query, step(send("ack"), task()), result("ack"), result("task")])).toBe(false);
  expect(turnEndedOnSilentToolCalls([query, text("thinking"), step(send("ack")), result("ack")])).toBe(false);
});

test("a closing step that sends beside work counts only if the send went out", () => {
  const closing = step(send("done"), ["work", "Shell"]);
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), closing, result("done"), result("work"), text("Here is the answer")])).toBe(false);
  // A failed send beside work, with the answer left in plain text, delivered nothing.
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), closing, result("done", true), result("work"), text("Here is the answer")])).toBe(true);
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), closing, result("done", true), result("work")])).toBe(false);
});

test("injected reminders neither bound the turn nor end it", () => {
  const reminder = user("<system_reminder>\nKeep the user posted.\n</system_reminder>");
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), reminder, step(task()), result("task"), reminder])).toBe(true);
});

test("each nudge starts a new turn shape", () => {
  expect(turnEndedOnSilentToolCalls([query, step(send("ack")), result("ack"), step(task()), result("task"), user("Your previous turn acknowledged the user…"), step(["read", "Read"]), result("read")])).toBe(false);
});
