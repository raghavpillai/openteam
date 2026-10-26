import { expect, test } from "bun:test";
import { platform, release } from "node:os";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import {
  communicationReminder,
  enrichUserInfo,
  renderDynamicToolCatalog,
  promptFingerprint,
  ACK_REMINDER,

  PROGRESS_REMINDER,
} from "../../src/runtime/prompt-context";

const user = { role: "user", content: "do work" };
const call = (name: string, args = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", name, arguments: args }],
});
const active = { requestSource: "turn", subagentType: null } as const;

test("runtime context describes actual tools and preserves saved skill catalog", () => {
  const text = enrichUserInfo(
    "<user_info>\n<agent_skills>test skill</agent_skills>\n</user_info>",
    {
      cwd: "/workspace/task",
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
  const input = { cwd: "/workspace/task", catalog: renderDynamicToolCatalog([{ name: "test", tools: [{ name: "Lookup" }] }]) };
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
  for (const gone of ["Is directory a git repo", "<agent_transcripts>"]) expect(text).not.toContain(gone);
  // A worker's user_info is the reference's too: the date, its skills, then its tool catalog, and no transcript block.
  const worker = enrichUserInfo("<user_info>\nToday's date: Wednesday Oct 21, 2026\n</user_info>\n\n<agent_skills>\ncatalog\n</agent_skills>", { ...input, subagent: true });
  expect(worker).toContain("Workspace Path: /workspace/task\nIf editing a git workspace");
  expect(worker).toContain("Today's date: Wednesday Oct 21, 2026\n</user_info>\n\n<agent_skills>");
  expect(worker).toEndWith("</dynamic_tool_catalog>");
  expect(worker).not.toContain("<agent_transcripts>");
  expect(worker).not.toContain("<available_subagent_types>");
});

test("acknowledgement reminders fire during work, with silent/worker exclusions", () => {
  const messages = [user, call("Read"), call("Shell")];
  expect(communicationReminder([user, call("Read")], active)).toBeNull();
  expect(communicationReminder(messages, active)).toEqual({ kind: "ack", content: ACK_REMINDER });
  expect(communicationReminder(messages, { ...active, requestSource: "automation" })).toBeNull();
  expect(communicationReminder(messages, { ...active, subagentType: "executor" })).toBeNull();
  expect(
    communicationReminder(
      [...messages, { role: "custom", customType: "openteam-communication-reminder" }],
      active
    )
  ).toBeNull();
});

const reminderNote = (content: string) => ({ role: "custom", customType: "openteam-communication-reminder", content });
/** Runs the hook before each step the way the context hook does, appending what it injects. */
const simulate = (steps: Array<ReturnType<typeof call>>) => {
  const messages: any[] = [user];
  const fired: Array<{ before: number; kind: string }> = [];
  steps.forEach((step, index) => {
    const reminder = communicationReminder(messages, active);
    if (reminder) {
      fired.push({ before: index + 1, kind: reminder.kind });
      messages.push(reminderNote(reminder.content));
    }
    messages.push(step, { role: "toolResult", toolCallId: `call-${index}`, content: [] });
  });
  return fired;
};

test("the ack repeats every two silent calls until the user hears from the bot", () => {
  expect(simulate(Array.from({ length: 13 }, () => call("Shell")))).toEqual(
    [3, 5, 7, 9, 11, 13].map((before) => ({ before, kind: "ack" }))

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

test("after an ack the progress reminder fires once per seven silent calls, not every step", () => {
  expect(simulate([call("SendToUser", { type: "text" }), ...Array.from({ length: 16 }, () => call("Shell"))])).toEqual([
    { before: 9, kind: "progress" },
    { before: 16, kind: "progress" },
  ]);
});

test("a reaction that went through acknowledges the user; a widget or failed reaction does not", () => {
  const react = { role: "assistant", content: [{ type: "toolCall", id: "r", name: "ReactToMessage", arguments: { emoji: "👍" } }] };
  const reacted = (isError: boolean) => [user, react, { role: "toolResult", toolCallId: "r", isError, content: [] }, call("Shell"), call("Shell")];
  expect(communicationReminder(reacted(false), active)).toBeNull();
  expect(communicationReminder(reacted(true), active)?.kind).toBe("ack");
  expect(communicationReminder([user, call("SendToUser", { type: "widget" }), call("Read"), call("Read")], active)?.kind).toBe("ack");
  expect(communicationReminder([user, call("SendToUser", { type: "widget" }), call("Read")], active)).toBeNull();
});

test("a newer real user message starts a new acknowledgement window", () => {
  expect(communicationReminder([user, call("SendToUser", { type: "text" }), call("Read"), user, call("Read"), call("Read")], active)?.kind).toBe("ack");
  // Injected reminder blocks are skipped when looking back for the ack.
  const hold = { role: "custom", customType: "openteam-end-turn-hold", content: "<system_reminder>\nYour turn did not end.\n</system_reminder>" };
  expect(communicationReminder([user, call("SendToUser", { type: "text" }), hold, call("Read"), call("Read")], active)).toBeNull();
});

test("a reply cut off at the output limit gets one reminder to continue in smaller pieces", async () => {
  const { OUTPUT_LIMIT_REMINDER, owesOutputLimitReminder } = await import("../../src/runtime/prompt-context");
  const cut = { role: "assistant", content: [{ type: "text", text: "Part one" }], stopReason: "length" };
  expect(owesOutputLimitReminder([user, cut, { role: "toolResult", toolCallId: "x" }], {})).toBe(true);
  expect(owesOutputLimitReminder([user, cut], { outputLimitReminded: true })).toBe(false);
  expect(owesOutputLimitReminder([user, { ...cut, stopReason: "stop" }], {})).toBe(false);
  const { ComputerRuntime } = await import("../../src/runtime");
  const runtime = new ComputerRuntime() as any;
  runtime.compaction = { beginUserQuery: async () => {}, settleAtTurnEnd: async () => null, parkBackground() {} };
  runtime.cleanup = async () => {};
  const prompts: string[] = [];
  const messages: any[] = [];
  const active = {
    subagentType: "executor", requestSource: "subagent", turnId: "t", runId: "r", contextSessionId: "c",
    attachmentTempDirectories: [], sentMessageCount: 0,
    session: {
      messages,
      prompt: async (text: string) => { prompts.push(text); messages.push(user, prompts.length === 1 ? cut : { ...cut, stopReason: "length" }); },
      getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [],
    },
    queue: { push() {}, end() {} },
  } as any;
  await runtime.execute(active, "Write the report.", []);
  expect(prompts).toEqual(["Write the report.", OUTPUT_LIMIT_REMINDER]);
  expect(OUTPUT_LIMIT_REMINDER).toBe("<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>");
});

test("Task's and the web tools' schemas ride in the catalog, so a dispatch or a quick lookup needs no schema lookup", () => {
  const task = { name: "Task", description: "Start a subagent.", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } };
  const catalog = renderDynamicToolCatalog([{ name: "cursor", description: "First-party tools.", tools: [{ name: "TodoWrite" }, task] }])!;
  expect(catalog).toContain("before calling `CallDynamicTool`, except for the tools in <preloaded_tool_schemas>, which you can call with `CallDynamicTool` directly.");
  expect(catalog).toContain([
    "</dynamic_tool_namespaces>",
    "<preloaded_tool_schemas>",
    JSON.stringify({ namespace: "cursor", tool: "Task", description: task.description, inputSchema: task.inputSchema }),
    "</preloaded_tool_schemas>",
    "</dynamic_tool_catalog>",
  ].join("\n"));

  const tools = new RuntimeTools({} as never, "http://127.0.0.1", "fixture", "/tmp", "/tmp");
  const turn = { requestSource: "turn", runtimeProfile: "agent", subagentType: null, pluginNamespaces: [] } as unknown as ActiveTurn;
  const cursor = tools.contextCatalog(turn).find((namespace) => namespace.name === "cursor")!;
  const preloaded = cursor.tools.filter((tool) => tool.inputSchema !== undefined);
  expect(preloaded.map((tool) => tool.name).sort()).toEqual(["Task", "WebFetch", "WebSearch"]);
  expect(JSON.stringify(preloaded.find((tool) => tool.name === "Task")!.inputSchema)).toContain("subagent_type");
  // A quick lookup is one call away too: without these schemas the main agent handed one-question research to an executor.
  expect(JSON.stringify(preloaded.find((tool) => tool.name === "WebSearch")!.inputSchema)).toContain("search_term");
  expect(JSON.stringify(preloaded.find((tool) => tool.name === "WebFetch")!.inputSchema)).toContain("url");
});
