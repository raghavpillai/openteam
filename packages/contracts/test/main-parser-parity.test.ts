import { expect, test } from "bun:test";
import { normalizeMainToolArguments } from "../src/reference-main-parsers";

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
    "Stopped 1 of 3 running subagent(s). They are torn down, will not report back, and anything they dispatched or ran inside their own turn ends with them:",
    '- sand-subagent-a [executor] "Worker a"',
    "1 had already finished before the stop reached them (you are revived with a finished subagent's result separately):",
    '- sand-subagent-b [executor] "Worker b"',
    "1 could NOT be stopped and may still be running. Retry each with StopSubagent and its id; if it still fails, tell the user which work may still be running:",
    '- sand-subagent-c [executor] "Worker c": timeout',
    "Do not resume, redispatch, or continue the stopped work unless the user asks again. Background shell commands you started yourself are not covered: terminate those with their reported PIDs.",
  ]);
  expect(renderControlResult("StopSubagent", { stopped_all: true, stopped: [], already_finished: [], failed: [], delegated: [] }, { all: true }))
    .toBe("No background subagents are running and no work is out with other agents, so there was nothing to stop. Background shell commands you started yourself are not subagents: terminate those with their reported PIDs.");
  // Peers handed work with a priority message are stopped too, and each is reported.
  expect(renderControlResult("StopSubagent", { stopped_all: true, stopped: [], already_finished: [], failed: [], delegated: [
    { id: "p1", name: "Researcher", result: "stopped" },
    { id: "p2", name: "Scout", result: "not_running" },
    { id: "p3", name: "Writer", result: "failed", detail: "computer connection timeout" },
  ] }, { all: true }).split("\n")).toEqual([
    "No background subagents of your own are running.",
    "Work you handed to other agents (1 of 3 stopped):",
    "- Researcher (agent p1): stop delivered; its turn is cancelled and its own subagents are being torn down.",
    "- Scout (agent p2): already idle, nothing to stop.",
    "- Writer (agent p3): stop failed (computer connection timeout). Retry StopSubagent with all: true; if it fails again, tell the user it may still be working.",
    "Do not resume, redispatch, or continue the stopped work unless the user asks again. Background shell commands you started yourself are not covered: terminate those with their reported PIDs.",
  ]);
});
test("SendToUser refuses fields and files it would silently drop", () => {
  const refusal = (args: unknown) => {
    try { normalizeMainToolArguments("SendToUser", args); } catch (error) { return (error as Error).message; }
    throw new Error("accepted");
  };
  const others = 'Send every other file (PDF, document, spreadsheet, video) as its own SendToUser call with type:"attachment" and url (file:// or https://), one call per file.';
  expect(refusal({ type: "text", content: "hi", attachments: [{ url: "file:///workspace/a.pdf" }] })).toBe(
    `Invalid arguments:\nattachments: attachments is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}`
  );
  expect(refusal({ content: "hi", files: ["file:///workspace/a.pdf"] })).toStartWith("Invalid arguments:\nfiles: files is not a SendToUser field");
  // Field issues still come back beside the hint.
  expect(refusal({ type: "text", files: ["/workspace/a.pdf"] })).toBe(
    `Invalid arguments:\nfiles: files is not a SendToUser field, so it would be silently dropped. Nothing was sent. Put images that go with your text in images on the type:text message. ${others}\ncontent: content is required when type is text`
  );
  expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", attachments: [] })).toEqual({ type: "text", content: "hi" });
  expect(refusal({ type: "text", content: "hi", images: [{ url: "file:///workspace/report.pdf" }] })).toBe(
    `Invalid arguments:\nimages.0.url: each images url must be a picture that goes with your text, and this one is another kind of file, so nothing was sent. ${others}`
  );
  for (const url of ["file:///workspace/chart.png", "https://example.com/photo.JPG?x=1", "file:///workspace/logo.svg", "https://example.com/render"])
    expect(normalizeMainToolArguments("SendToUser", { type: "text", content: "hi", images: [{ url }] }).images).toEqual([{ url }]);
  expect(refusal({ type: "text", content: "hi", images: [{ url: "/workspace/chart.png" }] })).toBe(
    "Invalid arguments:\nimages.0.url: each images url must include a file:// or https:// scheme. For a file on your computer, put file:// before its absolute path (file:///workspace/chart.png) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "/workspace/report.pdf" })).toBe(
    "Invalid arguments:\nurl: url must include a file:// or https:// scheme when type is attachment. For a file on your computer, put file:// before its absolute path (file:///workspace/report.pdf) and send it again. Nothing was sent."
  );
  expect(refusal({ type: "attachment", url: "file:///workspace/a.pdf", content: "here" })).toBe(
    "Invalid arguments:\ncontent: content is only valid with type:text and cannot be sent on a type:attachment message. It would be silently dropped. Nothing was sent. Re-send as separate SendToUser calls, one per type: this field on its own properly-typed message (type:text), and any text as its own type:text message."
  );
});
test("argument errors list one path and message per issue", () => {
  expect(() => normalizeMainToolArguments("ReactToMessage", {})).toThrow(
    "Invalid arguments:\nmessage_address: Invalid input: expected string, received undefined\nemoji: Invalid input: expected string, received undefined"
  );
  expect(() => normalizeMainToolArguments("UpdateMemory", { action: "write", fact: "x" })).toThrow(
    "Invalid arguments:\ntype: UpdateMemory: pick the memory type it belongs in"
  );
});
