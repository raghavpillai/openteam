import { expect, test } from "bun:test";
import { platform, release } from "node:os";
import {
  communicationReminder,
  enrichUserInfo,
  renderDynamicToolCatalog,
  promptFingerprint,
  EARLY_RESULT_REMINDER,
  PROGRESS_REMINDER,
  executionClock,
} from "../../src/runtime/prompt-context";

const user = { role: "user", content: "do work" };
const call = (name: string, args = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", name, arguments: args }],
});
const active = { requestSource: "turn", subagentType: null } as const;

test("execution clock reports actual invocation interval without restarting parent deadlines", () => {
  const start = Date.parse("2026-09-25T17:52:23Z");
  const messages = executionClock(start, start + 158000);
  expect(messages[0]?.content).toContain("elapsed 158 seconds");
  expect(messages[0]?.content).toContain("2026-09-25T17:55:01.000Z");
  expect(messages[0]?.content).toContain("not total user wait");
  expect(executionClock(undefined, start)).toEqual([]);
  expect(executionClock(NaN, start)).toEqual([]);
  expect(executionClock(start, start - 1000)[0]?.content).toContain("elapsed 0 seconds");
});

test("runtime context describes actual tools and preserves saved skill catalog", () => {
  const text = enrichUserInfo(
    "<user_info>\n<agent_skills>test skill</agent_skills>\n</user_info>",
    {
      cwd: "/workspace/task",
      transcriptPath: "/private/session.jsonl",
      catalog: renderDynamicToolCatalog([{ name: "test", description: "test namespace", tools: [{ name: "Lookup" }] }]),
    }
  );
  expect(text).toContain("Workspace Path: /workspace/task");
  expect(text).toContain("test skill");
  expect(text).toContain("<available_subagent_types>");
  expect(text).toContain('<namespace name="test" tools="Lookup" source="mcp" />');
  expect(promptFingerprint("system", text, [], 2)).toEqual(
    promptFingerprint("system", text, [], 2)
  );
  expect(promptFingerprint("system", text, ["Lookup"], 2).toolsSha).not.toBe(
    promptFingerprint("system", text, [], 2).toolsSha
  );
});

test("main user_info follows the reference layout and leaves transcripts to ReadTranscript", () => {
  const base = [
    "<user_info>\nToday's date: Wednesday Oct 21, 2026\n</user_info>",
    "<memory_context>\nfacts\n</memory_context>",
    "<teammates>\nroster\n</teammates>",
    "<agent_skills>\ncatalog\n</agent_skills>",
  ].join("\n\n");
  const input = { cwd: "/workspace/task", transcriptPath: "/private/session.jsonl", catalog: renderDynamicToolCatalog([{ name: "test", tools: [{ name: "Lookup" }] }]) };
  const text = enrichUserInfo(base, input);
  expect(text).toStartWith(
    `<user_info>\nOS Version: ${platform()} ${release()}\n\nShell: /bin/bash\n\nThe Linux computer supports passwordless sudo for system changes and package installation.\n\n` +
      "Workspace Path: /workspace/task\nIf editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so.\n\n" +
      "Today's date: Wednesday Oct 21, 2026\n</user_info>\n\n<memory_context>"
  );
  const order = ["</user_info>", "<memory_context>", "<available_subagent_types>", "<teammates>", "<agent_skills>", "<dynamic_tool_catalog>"].map((tag) => text.indexOf(tag));
  expect(order.every((at, index) => at > (order[index - 1] ?? -1))).toBe(true);
  expect(text).toContain("</memory_context>\n\n<available_subagent_types>\n");
  expect(text).toContain("</available_subagent_types>\n\n<teammates>");
  for (const gone of ["Is directory a git repo", "<agent_transcripts>", "/private/session.jsonl"]) expect(text).not.toContain(gone);
  const worker = enrichUserInfo("<user_info>\n<agent_skills>\ncatalog\n</agent_skills>\n</user_info>", { ...input, subagent: true });
  expect(worker).toContain("Workspace Path: /workspace/task\nIf editing a git workspace");
  expect(worker).toContain("\n\n<agent_skills>");
  expect(worker).toContain("<agent_transcripts>\nPast conversation transcripts: /private/session.jsonl.");
  expect(worker).not.toContain("<available_subagent_types>");
});

test("acknowledgement reminders fire during work, with silent/worker exclusions", () => {
  const messages = [user, call("Read"), call("Shell")];
  expect(communicationReminder([user, call("Read")], active)).toBeNull();
  expect(communicationReminder(messages, active)?.kind).toBe("ack");
  expect(communicationReminder(messages, { ...active, requestSource: "automation" })).toBeNull();
  expect(communicationReminder(messages, { ...active, subagentType: "executor" })).toBeNull();
  expect(
    communicationReminder(
      [...messages, { role: "custom", customType: "openteam-communication-reminder" }],
      active
    )
  ).toBeNull();
});

test("opening acknowledgement is followed by a result reminder after work", () => {
  expect(communicationReminder([user, call("SendToUser", { type: "text" })], active)).toBeNull();
  expect(
    communicationReminder([user, call("SendToUser", { type: "text" }), call("Read")], active)
  ).toEqual({ kind: "early-result", content: EARLY_RESULT_REMINDER });
  expect(
    communicationReminder(
      [user, call("SendToUser", { type: "widget" }), call("Read"), call("Read")],
      active
    )?.kind
  ).toBe("ack");
});

test("early reminders allow unfinished work; prolonged silence requires an update", () => {
  const start = [user, call("SendToUser", { type: "text" }), call("Read")];
  const note = {
    role: "custom",
    customType: "openteam-communication-reminder",
    content: EARLY_RESULT_REMINDER,
  };
  expect(communicationReminder([...start, note, call("Read")], active)).toBeNull();
  expect(
    communicationReminder(
      [...start, note, ...Array.from({ length: 6 }, () => call("Read"))],
      active
    )
  ).toEqual({ kind: "progress", content: PROGRESS_REMINDER });
  expect(
    communicationReminder(
      [...start, note, call("SendToUser", { type: "text" }), call("Read")],
      active
    )?.kind
  ).toBe("early-result");
});

test("injected user-role notes do not hide a long silent streak or a newer real user turn", () => {
  const note = {
    role: "user",
    content: EARLY_RESULT_REMINDER,
    providerOptions: { cursor: { sandEarlyResultReminder: true } },
  };
  const start = [user, call("SendToUser", { type: "text" }), call("Read"), note];
  expect(
    communicationReminder([...start, ...Array.from({ length: 6 }, () => call("Read"))], active)
      ?.kind
  ).toBe("progress");
  expect(communicationReminder([...start, user, call("Read"), call("Read")], active)?.kind).toBe(
    "ack"
  );
});

test("the dynamic tool catalog has the reference shape and marks connections that are not ready", () => {
  expect(renderDynamicToolCatalog([
    { name: "gmail", namespaceStatus: "ready", description: "Gmail (default)", tools: [{ name: "search_threads" }, { name: "create_draft" }] },
    { name: "gmail--personal-2", namespaceStatus: "needsAuth", description: "Gmail (personal 2)", tools: [{ name: "search_threads" }] },
    { name: "cursor", namespaceStatus: "ready", description: "First-party tools.\n\nHere are some crucial instructions:\n- Task: Spawn subagents natively.", tools: [{ name: "TodoWrite" }, { name: "request_box_help" }, { name: "AwaitShell" }, { name: "RequestUserForm" }] },
    { name: "slack-stealth", namespaceStatus: "error", tools: [] },
  ])).toBe([
    "<dynamic_tool_catalog>",
    "These dynamic tool namespaces were available when this conversation started. Availability may have changed, so use `GetDynamicTools` to check current state before calling `CallDynamicTool`.",
    "",
    "<dynamic_tool_namespaces>",
    '<namespace name="cursor" tools="AwaitShell, request_box_help, RequestUserForm, TodoWrite" namespaceUseInstructions="First-party tools.\n\nHere are some crucial instructions:\n- Task: Spawn subagents natively." source="cursor" />',
    '<namespace name="gmail" tools="create_draft, search_threads" source="mcp" />',
    '<namespace name="gmail--personal-2" status="needsAuth" source="mcp" />',
    '<namespace name="slack-stealth" status="error" source="mcp" />',
    "</dynamic_tool_namespaces>",
    "</dynamic_tool_catalog>",
  ].join("\n"));
  expect(renderDynamicToolCatalog([{ name: "cursor", tools: [] }])).toBeNull();
});

test("the catalog in user_info is pinned for the epoch; a changed cursor namespace is announced once", async () => {
  const { pinDynamicToolCatalog } = await import("../../src/runtime/catalog-snapshot");
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const log = { getEntries: () => entries, appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
  const cursor = (tools: string[]) => ({ name: "cursor", description: "First-party tools.", tools: tools.map((name) => ({ name })) });
  const gmail = { name: "gmail", namespaceStatus: "ready", tools: [{ name: "search_threads" }] };
  const first = pinDynamicToolCatalog(log, 0, [cursor(["TodoWrite"])]);
  expect(first).toEqual({ catalog: renderDynamicToolCatalog([cursor(["TodoWrite"])]), update: null });
  // A connector connected mid-conversation does not rewrite user_info.
  expect(pinDynamicToolCatalog(log, 0, [cursor(["TodoWrite"]), gmail])).toEqual({ catalog: first.catalog, update: null });
  const changed = pinDynamicToolCatalog(log, 0, [cursor(["TodoWrite", "UploadFile"]), gmail]);
  expect(changed.catalog).toBe(first.catalog);
  expect(changed.update).toBe([
    "<system_reminder>",
    '<user_info_catalog_update sections="dynamic_tool_snapshot">',
    "The catalogs below have changed since the user_info message at the start of this conversation was written. They replace the same-named sections there; a later update of this kind replaces this one.",
    "<dynamic_tool_namespaces>",
    '<namespace name="cursor" tools="TodoWrite, UploadFile" namespaceUseInstructions="First-party tools." source="cursor" />',
    "</dynamic_tool_namespaces>",
    "</user_info_catalog_update>",
    "</system_reminder>",
  ].join("\n"));
  expect(pinDynamicToolCatalog(log, 0, [cursor(["TodoWrite", "UploadFile"]), gmail]).update).toBeNull();
  // A new epoch (after a summary) renders the live catalog again.
  expect(pinDynamicToolCatalog(log, 1, [cursor(["TodoWrite", "UploadFile"]), gmail]).catalog).toContain('<namespace name="gmail"');
});
