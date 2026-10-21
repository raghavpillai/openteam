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
test("reference aliases and wrong-tool hints for file tools", async () => {
  const { applyArgumentAliases } = await import("../src/reference-main-parsers");
  const { parseConnectorTransfer } = await import("../src/connector-transfers");
  for (const alias of ["path", "source_path", "sourcePath", "source", "local_path"])
    expect(applyArgumentAliases("CopyToBox", { [alias]: "/Users/a/x.csv", machineId: "m1" })).toEqual({ computer_path: "/Users/a/x.csv", machineId: "m1" });
  expect(applyArgumentAliases("CopyToBox", { computer_path: "/a", path: "/b" })).toEqual({ computer_path: "/a", path: "/b" });
  expect(applyArgumentAliases("CopyToBox", { path: "/a", source: "/a" })).toEqual({ computer_path: "/a" });
  expect(() => applyArgumentAliases("CopyToBox", { path: "/a", source: "/b" })).toThrow(
    "Invalid arguments:\ncomputer_path: Pass the file's absolute path on the user's computer once, as computer_path."
  );
  const shape = 'Shape: {"connection": "google-drive", "source": {"fileId": "<id>"}, "destination"?: {"path": "<box path>"}}.';
  expect(() => parseConnectorTransfer("DownloadFile", { url: "https://example.com/a.pdf" })).toThrow(
    `Invalid arguments:\nurl: DownloadFile fetches a file from a connected Google Drive / Gmail account. For a URL use WebFetch or Shell curl; for a file already on this box use Read. ${shape}\nconnection: Invalid input: expected string, received undefined\nsource: Invalid input: expected object, received undefined`
  );
  expect(() => parseConnectorTransfer("DownloadFile", { file_path: "/workspace/a.pdf" })).toThrow(
    `file_path: DownloadFile fetches a file from a connected Google Drive / Gmail account. For a file already on this box use Read; for a URL use WebFetch or Shell curl. ${shape}`
  );
  expect(() => parseConnectorTransfer("UploadFile", { connection: "google-drive", path: "/workspace/a.pdf" })).toThrow(
    'Invalid arguments:\nargument: UploadFile sends a file that is already on your box into a connected Google Drive / Gmail account; sourcePath is the box path. Shape: {"connection": "google-drive", "sourcePath": "/workspace/report.pdf", "destination"?: {"path": "<folder>"} | {"folderId": "<id>"} | {"draftId": "<id>"}}.\nsourcePath: Invalid input: expected string, received undefined'
  );
  expect(parseConnectorTransfer("UploadFile", { connection: "google-drive", sourcePath: "/workspace/a.pdf" })).toMatchObject({ sourcePath: "/workspace/a.pdf" });
});
test("CheckSubagent points at the subagent's transcript by id", async () => {
  const { renderControlResult } = await import("../src/tool-results");
  const detail = renderControlResult("CheckSubagent", {
    subagent_id: "sand-subagent-1", subagent_type: "executor", description: "Fix", status: "running", elapsed_seconds: 5, recent_tool_calls: [], transcript_path: "/private/run.jsonl",
  }, { subagent_id: "sand-subagent-1" });
  expect(detail.split("\n").at(-1)).toBe("  Full transcript: call ReadTranscript with in=sand-subagent-1 for the complete play-by-play.");
  expect(detail).not.toContain("/private/run.jsonl");
});
test("a reaction that could not be placed reads as its note", async () => {
  const { renderControlResult } = await import("../src/tool-results");
  expect(renderControlResult("ReactToMessage", { reacted: false, removed: false, note: "No user message t9u in this chat, so nothing was reacted to." }, { message_address: "t9u", emoji: "👍" }))
    .toBe("No user message t9u in this chat, so nothing was reacted to.");
});
test("SendToUser text gets real line breaks for escaped ones outside code", () => {
  const content = (text: string) => normalizeMainToolArguments("SendToUser", { type: "text", content: text }).content;
  expect(content("hi\\nthere")).toBe("hi\nthere");
  expect(content("Done.\\n\\n- one\\n- two")).toBe("Done.\n\n- one\n- two");
  expect(content('She said \\"yes\\"')).toBe('She said "yes"');
  expect(content("Use `printf 'a\\nb'` here")).toBe("Use `printf 'a\\nb'` here");
  expect(content("```\nline\\nkept\n```")).toBe("```\nline\\nkept\n```");
  expect(content("Saved to C:\\new\\report.txt")).toBe("Saved to C:\\new\\report.txt");
  expect(normalizeMainToolArguments("SendToUser", { type: "attachment", url: "file:///workspace/a\\nb.pdf" }).url).toBe("file:///workspace/a\\nb.pdf");
});
