import { describe, expect, test } from "bun:test";
import { AUTOMATION_PARENT_ONLY_TOOLS, AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED } from "@openteam/contracts";
import { BROWSER_USE_TOOLS } from "../../src/browser/use";
import { ComputerRuntime } from "../../src/runtime";
import { compactionObservation } from "../../src/runtime/compaction";
import { withFetch } from "./tool-fixtures";

const runtimeTools = () => (new ComputerRuntime() as unknown as { tools: unknown }).tools;

test('background status evidence comes only from active server records', async () => {
  const runtime = runtimeTools() as any;
  const pending = {subagent_id: 'worker', status: 'running', run_status: 'running'};
  const fixtures: Array<[unknown, boolean]> = [
    [pending, true],
    [{...pending, status: 'queued', run_status: null}, true],
    [{subagents: [pending]}, true],
    [{...pending, run_status: 'failed'}, false],
    [{...pending, status: 'completed'}, false],
    [{subagents: [pending, {...pending, status: 'completed'}]}, false],
    [{subagents: []}, false],
    ['No background subagents are running right now.', false],
    ['The worker is running', false],
  ];
  for (const [body, expected] of fixtures) {
    const result = await withFetch(async () => Response.json(body), () => runtime.callControlPlaneTool({}, 'check', 'CheckSubagent', {}));
    expect(result.details.pendingBackgroundWork).toBe(expected);
  }
});

const turnRequest = (overrides: Record<string, unknown> = {}) => ({
  runId: crypto.randomUUID(),
  botId: crypto.randomUUID(),
  contextSessionId: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  sessionPath: null,
  content: "test",
  clientMessageId: crypto.randomUUID(),
  cwd: "/workspace",
  instructions: "system",
  model: "openai-codex/gpt-5.5",
  reasoning: "high",
  channelId: crypto.randomUUID(),
  deliveryId: null,
  ...overrides,
});

/** A connected Drive account: UploadFile and DownloadFile are offered only beside one. */
const driveNamespace = { name: "google-drive", description: "Google Drive (default)", namespaceStatus: "ready", tools: [], fileTransfers: { upload: true, download: true } };

const workerTurn = (subagentType: string | null, overrides: Record<string, unknown> = {}) => ({
  subagentType,
  runtimeProfile: subagentType ? "subagent" : "agent",
  pluginNamespaces: [driveNamespace],
  ...overrides,
}) as any;

const toolNames = (subagentType: string | null) => {
  const runtime = runtimeTools() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{ name: string }>;
  };
  return runtime.customTools(workerTurn(subagentType)).map((tool) => tool.name);
};

describe("specialized subagent tool surfaces", () => {
  test.each(["videoReview", "watchVideo"])("%s reviews supplied media without tools", (subagentType) => {
    expect((runtimeTools() as any).customTools({ subagentType })).toEqual([]);
  });

  test("computerUse receives Shell, Read, AwaitShell, Computer and the browser tools", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "ReportTaskProgress", "AwaitShell", "Computer", ...BROWSER_USE_TOOLS.map(tool => tool.name)]);
  });

  test("StopSubagent decodes exactly one target and routes through the control plane", async () => {
    const runtime = runtimeTools() as any;
    const calls: Array<{ tool: string; args: unknown }> = [];
    runtime.callControlPlaneTool = async (_active: unknown, _callId: string, tool: string, args: unknown) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const stop = runtime.dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((namespace: any) => namespace.name === "cursor").tools.find((tool: any) => tool.name === "StopSubagent");
    expect(stop.decodeArguments({ subagent_id: "sand-subagent-1" })).toEqual({ subagent_id: "sand-subagent-1" });
    for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
      expect(() => stop.decodeArguments(invalid), JSON.stringify(invalid)).toThrow();
    await stop.execute({}, "call-stop", stop.decodeArguments({ all: true }));
    expect(calls).toEqual([{ tool: "StopSubagent", args: { all: true } }]);
  });

  test("DraftExternalMessage refuses HTML email bodies and sends the server an unwrapped body", () => {
    const draft = (runtimeTools() as any).dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((namespace: any) => namespace.name === "cursor").tools.find((tool: any) => tool.name === "DraftExternalMessage");
    const email = { platform: "email", providerIdentifier: "p", from: "me@example.com", to: ["ann@example.com"], subject: "Hi" };
    expect(draft.decodeArguments({ ...email, body: "We reviewed the contract terms with legal on Monday and they asked us to\nadd a clause about data retention before anything gets signed.\n\nBest,\nAnn" }))
      .toMatchObject({ body: "We reviewed the contract terms with legal on Monday and they asked us to add a clause about data retention before anything gets signed.\n\nBest,\nAnn" });
    expect(() => draft.decodeArguments({ ...email, body: "Hello<br>See you" })).toThrow("body is plain text, so <br> would reach the recipient as literal text. Nothing was drafted.");
    expect(draft.decodeArguments({ ...email, body: "Please review.", forwardMessageId: "source-1", attachments: ["/workspace/report.txt"] }))
      .toMatchObject({ forwardMessageId: "source-1", attachments: ["/workspace/report.txt"] });
  });

});

describe("durable state tools", () => {
  const namespacedStateTools = ["UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel"];
  const cursorToolNames = (runtime: any, active: Record<string, unknown>) =>
    runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === "cursor").tools.map((tool: any) => tool.name);

  test("the main agent and its routine runs get every state tool; workers and read-only agents get none", async () => {
    const runtime = runtimeTools() as any;
    for (const active of [workerTurn(null), workerTurn(null, { requestSource: "automation" })]) {
      const names = runtime.customTools(active).map((tool: any) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["UpdateMemory", "UpdateRoutine"]));
      expect(names).not.toContain("update_state");
      expect(cursorToolNames(runtime, active)).toEqual(expect.arrayContaining(namespacedStateTools));
      expect(cursorToolNames(runtime, active)).not.toContain("UpdateProject");
    }
    for (const subagentType of ["executor", "knowledgeWork", "computerUse"]) {
      for (const readOnly of [false, true]) {
        const active = workerTurn(subagentType, { readOnly });
        const names = runtime.customTools(active).map((tool: any) => tool.name);
        expect(names).not.toContain("UpdateMemory");
        expect(names).not.toContain("UpdateRoutine");
        for (const name of namespacedStateTools) expect(cursorToolNames(runtime, active)).not.toContain(name);
      }
    }
    const readOnly = { ...workerTurn("executor", { readOnly: true }), runId: "run-1" };
    for (const name of ["UpdateMemory", "UpdateRoutine"])
      await expect(runtime.executeOpenTeamTool(readOnly, "call-1", name, { action: "pause", id: "brief" })).rejects.toThrow("read-only");
    for (const toolName of namespacedStateTools)
      await expect(runtime.callDynamicTool(readOnly, "call-1", { namespace: "cursor", toolName, arguments: {} })).rejects.toThrow("read-only");
  });

  test("each state tool reaches the control plane under its own name with parsed arguments", async () => {
    const runtime = runtimeTools() as any;
    const calls: Array<{ tool: string; args: unknown }> = [];
    runtime.callControlPlaneTool = async (_active: unknown, _callId: string, tool: string, args: unknown) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const active = { ...workerTurn(null), runId: "run-1" };
    await runtime.executeOpenTeamTool(active, "memory", "UpdateMemory", { target: "memory", action: "write", fact: " Prefers tea. ", type: "profile" });
    await runtime.executeOpenTeamTool(active, "routine", "UpdateRoutine", { action: "pause", id: "brief" });
    await expect(runtime.executeOpenTeamTool(active, "invalid", "UpdateMemory", { action: "create", fact: "x", type: "profile" })).rejects.toThrow(
      "UpdateMemory only writes, replaces or forgets memory"
    );
    const cursor = runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === "cursor");
    const namespaced: Array<[string, Record<string, unknown>]> = [
      ["UpdateSkill", { action: "delete", id: "standup" }],
      ["UpdateProfile", { title: "Designer", notify_on_updates: false }],
      ["UpdateAvatar", { action: "clear" }],
      ["DisconnectChannel", { platform: "slack" }],
    ];
    for (const [name, args] of namespaced) {
      const tool = cursor.tools.find((candidate: any) => candidate.name === name);
      await tool.execute(active, name, tool.decodeArguments({ ...args, target: "skill" }));
    }
    expect(() => cursor.tools.find((tool: any) => tool.name === "UpdateProfile").decodeArguments({ avatar_shape: "triangle" })).toThrow();
    expect(calls).toEqual([
      { tool: "UpdateMemory", args: { action: "write", fact: "Prefers tea.", type: "profile" } },
      { tool: "UpdateRoutine", args: { action: "pause", id: "brief" } },
      ...namespaced.map(([tool, args]) => ({ tool, args })),
    ]);
  });
});

describe("local turn plumbing", () => {
  test("routes Shell by machineId while keeping omitted machineId in the box", async () => {
    const calls: string[] = [];
    const runtime = runtimeTools() as any;
    runtime.processSecrets = async () => ({});
    const fake = (where: string) => async () => {
      calls.push(where);
      return { content: [{ type: "text", text: where }], details: {} };
    };
    runtime.nativeToolExecutor.shell = fake("box");
    runtime.nativeToolExecutor.externalShell = fake("host");
    const active = { subagentType: null, cwd: "/workspace", runId: "run-1", turnId: "run-1", queue: { push: () => undefined } };
    await runtime.executeOpenTeamTool(active, "box-call", "Shell", { command: "pwd" });
    await runtime.executeOpenTeamTool(active, "host-call", "Shell", { command: "pwd", machineId: "machine-1" });
    expect(calls).toEqual(["box", "host"]);
  });

  test("refreshes the summary todo snapshot after a successful TodoWrite", async () => {
    const runtime = runtimeTools() as any;
    const todos = [
      { id: "audit", content: "Review parity", status: "completed" },
      { id: "ship", content: "Run checks", status: "in_progress" },
    ];
    runtime.callControlPlaneTool = async () => ({ content: [{ type: "text", text: JSON.stringify({ todos }) }], details: {} });
    const active = { todoUpdate: "- [pending] stale: Old snapshot" };
    await runtime.executeTodoWrite(active, "call-1", { todos: [] });
    expect(active.todoUpdate).toBe("- **COMPLETED**: Review parity (id: audit)\n- **IN_PROGRESS**: Run checks (id: ship)");
  });

  test("reserves a context before asynchronous setup and releases it on failure", async () => {
    const runtime = new ComputerRuntime() as any;
    runtime.start = async () => {};
    Object.assign(runtime.tools.userForms, { beginTurn: async () => {}, endTurn: async () => {} });
    runtime.authenticated = true;
    runtime.resolveModel = () => ({});
    runtime.modelRuntime = { checkAuth: async () => ({ type: "oauth", source: "test" }), isUsingSubscription: () => true };
    let rejectSetup!: (error: Error) => void;
    let enteredSetup!: () => void;
    const entered = new Promise<void>((resolve) => (enteredSetup = resolve));
    runtime.contextState = () =>
      new Promise<never>((_resolve, reject) => {
        rejectSetup = reject;
        enteredSetup();
      });
    const contextSessionId = crypto.randomUUID();
    const first = runtime.run(turnRequest({ contextSessionId }));
    await entered;
    await expect(runtime.run(turnRequest({ contextSessionId, runId: crypto.randomUUID() }))).rejects.toThrow("already has an active Pi turn");
    rejectSetup(new Error("setup failed"));
    await expect(first).rejects.toThrow("setup failed");
    expect(runtime.diagnostics.activeTurns).toBe(0);
  });
});

test('browser workers retain their parent desktop session', async () => {
  const tools = runtimeTools() as any;
  tools.screens.browserEndpointForAgent = async () => 'http://unused-test-endpoint';
  tools.screens.readySession = async (id: string) => ({botId:id,profileDirectory:'/tmp/browser-fixture',humanTakeoverUntil:0,humanActiveAt:0,agentInputPaused:false});
  const used: string[] = [];
  const makeBrowser = (name: string) => ({connected:true, configureUploads(){}, registerPrivateValues(){},
    async execute(tool: string, _args: unknown, signal?: AbortSignal) {
      used.push(name);
      if (tool === 'browser_wait_for') await new Promise((_,reject) => {signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
      return {content:[],details:{}};
    }});
  const first=makeBrowser('first'), other=makeBrowser('other');
  tools.browserUseSessions.set('old-worker',first); tools.browserSessionScreens.set('old-worker','desktop-a');
  tools.browserUseSessions.set('other-worker',other); tools.browserSessionScreens.set('other-worker','desktop-b');
  const turn={botId:'new-worker',screenBotId:'desktop-a',cwd:'/workspace',runId:'wait-run',requestSource:'automation'};
  await tools.callBrowserUse(turn,'browser_console_messages',{all:true});
  expect(tools.browserUseSessions.get('new-worker')).toBe(first);
  await tools.callBrowserUse({...turn,botId:'another-worker',screenBotId:'desktop-b'},'browser_console_messages',{});
  expect(tools.browserUseSessions.get('another-worker')).toBe(other);
  expect(used).toEqual(['first','other']);
});

test('browser calls and forms on an already connected browser mark that desktop for the turn-end snapshot', async () => {
  const tools = runtimeTools() as any;
  let connects = 0;
  tools.screens.readySession = async () => tools.screens.sessions.get('desktop-a');
  tools.screens.browserIsReady = async () => true;
  tools.screens.browserBroker = {attach: async () => undefined};
  const browserEndpointForAgent = tools.screens.browserEndpointForAgent.bind(tools.screens);
  tools.screens.browserEndpointForAgent = (...args: unknown[]) => { connects += 1; return browserEndpointForAgent(...args); };
  tools.screens.sessions.set('desktop-a', {botId:'desktop-a', profileDirectory:'/home/box/chrome-profile-2', browserDebugPort:9301, humanTakeoverUntil:0, agentInputPaused:false});
  tools.browserUseSessions.set('worker',{connected:true, configureUploads(){}, registerPrivateValues(){}, async execute(){ return {content:[],details:{}}; }});
  tools.browserSessionScreens.set('worker','desktop-a');
  const turn={botId:'worker',screenBotId:'desktop-a',cwd:'/workspace',runId:'run',requestSource:'turn'};
  for (let call = 0; call < 2; call += 1) {
    await tools.callBrowserUse(turn,'browser_console_messages',{});
    expect(tools.screens.takeBrowserUse('desktop-a')).toBe('chrome-profile-2');
    expect(tools.screens.takeBrowserUse('desktop-a')).toBeNull();
  }
  expect(connects).toBe(2);
  // A user's form submission reuses the connected browser without asking the screen for it.
  await tools.formBrowser('desktop-a');
  expect(connects).toBe(2);
  expect(tools.screens.takeBrowserUse('desktop-a')).toBe('chrome-profile-2');
});

test('Task reads subagent_type spellings as their type and reports a refused dispatch as Error: reason', async () => {
  const runtime = runtimeTools() as any;
  const sent: any[] = [];
  const task = runtime.dynamicCatalog(workerTurn(null)).find((namespace: any) => namespace.name === 'cursor').tools.find((tool: any) => tool.name === 'Task');
  expect(task.decodeArguments({ description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' }).subagent_type).toBe('computerUse');
  await expect(withFetch(async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body).arguments);
    return Response.json({ error: { code: 'subagent_not_resumable', message: "That background subagent is still running, so it can't be resumed yet." } }, { status: 409 });
  }, () => runtime.executeOpenTeamTool({ ...workerTurn(null), runId: 'run-1' }, 'call', 'CallDynamicTool', {
    namespace: 'cursor', toolName: 'Task', arguments: { description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' },
  }))).rejects.toThrow(/^Error: That background subagent is still running, so it can't be resumed yet\.$/);
  expect(sent[0].subagent_type).toBe('computerUse');
});

test('a readonly worker lists and greps with Shell on the box, reads only through read tools, and moves no files', async () => {
  const runtime = runtimeTools() as any;
  const readonly = workerTurn('executor', { readOnly: true, runId: 'run-ro',
    pluginNamespaces: [{ name: 'gmail_work', description: 'Gmail', namespaceStatus: 'ready', tools: [
      { connectionId: 'c1', name: 'search_threads', description: '', inputSchema: { type: 'object' }, source: 'gmail/gmail' },
      { connectionId: 'c1', name: 'whoami', description: '', inputSchema: { type: 'object' }, source: 'custom/custom', readOnly: true },
      { connectionId: 'c1', name: 'send_message', description: '', inputSchema: { type: 'object' }, source: 'gmail/gmail' },
    ] }] });
  expect(runtime.customTools(readonly).map((tool: any) => tool.name)).toEqual(['WebSearch', 'WebFetch', 'Shell', 'Read', 'AwaitShell', 'GetDynamicTools', 'CallDynamicTool', 'ReportTaskProgress']);
  expect(runtime.dynamicCatalog(readonly).find((namespace: any) => namespace.name === 'cursor').tools.map((tool: any) => tool.name)).toEqual([]);
  await expect(runtime.executeOpenTeamTool(readonly, 'call-1', 'Shell', { command: 'ls', machineId: 'mac' })).rejects.toThrow("Read-only agents cannot access the user's computer");
  const calls: string[] = [];
  runtime.callControlPlaneTool = async (_active: unknown, _callId: string, _tool: string, args: any) => {
    calls.push(args.toolName);
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  };
  for (const toolName of ['search_threads', 'whoami']) {
    await runtime.callDynamicTool(readonly, `call-${toolName}`, { namespace: 'gmail_work', toolName, arguments: {} });
  }
  expect(calls).toEqual(['search_threads', 'whoami']);
  await expect(runtime.callDynamicTool(readonly, 'call-send', { namespace: 'gmail_work', toolName: 'send_message', arguments: {} }))
    .rejects.toThrow('This tool is unavailable to a read-only plugin agent');
});

test('Messages tools appear only while a connected Mac has Messages on, and never for workers or routines', () => {
  const runtime = runtimeTools() as any;
  const cursor = (active: Record<string, unknown>) =>
    runtime.dynamicCatalog(active).find((namespace: any) => namespace.name === 'cursor').tools.map((tool: any) => tool.name);
  const messages = ['FindContacts', 'FindIMessageChats', 'ChatItems', 'SearchIMessages', 'IMessageActivity', 'FetchIMessageAttachment', 'SendIMessage', 'CheckIMessagePermissions'];
  expect(cursor(workerTurn(null, { messagesAvailable: true }))).toEqual(expect.arrayContaining(messages));
  for (const active of [workerTurn(null), workerTurn(null, { messagesAvailable: false }), workerTurn(null, { messagesAvailable: true, requestSource: 'automation' }), workerTurn('executor', { messagesAvailable: true })])
    expect(cursor(active).filter((name: string) => messages.includes(name))).toEqual([]);
  // The Chrome sign-in import does not depend on Messages.
  expect(cursor(workerTurn(null))).toContain('RequestCookieOriginApproval');
});

describe("routine runs", () => {
  const automation = () => ({ requestSource: "automation", runtimeProfile: "agent", subagentType: null, pluginNamespaces: [], botId: "bot" }) as any;
  const names = (tools: any, turn: any) => [...tools.customTools(turn).map((tool: any) => tool.name), ...tools.contextCatalog(turn).flatMap((namespace: any) => namespace.tools.map((tool: any) => tool.name))];

  test("automation calls WakeParent directly and keeps work tools, with all communication surfaces removed", () => {
    const tools = runtimeTools() as any;
    const turn = automation();
    expect(tools.customTools(turn).map((tool: any) => tool.name)).toContain("WakeParent");
    expect(tools.contextCatalog(turn).flatMap((namespace: any) => namespace.tools.map((tool: any) => tool.name))).not.toContain("WakeParent");
    for (const name of AUTOMATION_PARENT_ONLY_TOOLS) expect(names(tools, turn)).not.toContain(name);
    // Routine management tools stay: none of them opens a card or waits for the user.
    for (const name of ["Shell", "Read", "RecallMemory", "UpdateMemory", "UpdateRoutine", "UpdateSkill", "UpdateProfile", "UpdateAvatar", "DisconnectChannel", "Task", "CheckSubagent",
      "WebFetch", "WebSearch", "CopyToBox", "CopyFromBox", "GetPlugin", "SearchPlugins", "UninstallPlugin", "UninstallMcpServer", "RestartMcpServers", "SetMcpInstructions", "RenameMcpAccount", "RemoveMcpAccount"])
      expect(names(tools, turn)).toContain(name);
    for (const profile of [
      { requestSource: "turn", runtimeProfile: "agent", subagentType: null },
      { requestSource: "agent", runtimeProfile: "subagent", subagentType: "executor" },
      { requestSource: "automation", runtimeProfile: "subagent", subagentType: "executor" },
    ]) expect(names(tools, { ...turn, ...profile })).not.toContain("WakeParent");
  });

  test("a rejected WakeParent leaves the automation able to continue, and communication tools point to WakeParent", async () => {
    const tools = runtimeTools() as any;
    const turn = automation();
    const wake = tools.customTools(turn).find((tool: any) => tool.name === "WakeParent")!;
    await expect(withFetch(async () => Response.json({ error: "storage unavailable" }, { status: 503 }),
      () => wake.execute("wake", { message: "Complete report" }, undefined, undefined, {} as never))).rejects.toThrow("storage unavailable");
    expect(turn.endTurnRequested).not.toBe(true);
    for (const [tool, args] of [["SendToUser", { type: "text", content: "Done" }], ["ReactToMessage", { message_address: "t1", emoji: "👍" }]] as const)
      await expect(tools.executeOpenTeamTool(turn, "call", tool, args)).rejects.toThrow(AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED);
  });
});

describe("task progress", () => {
  const input = { key: "generated", state: "working", summary: "Generated the requested artifact", evidence: ["/documents/export"], remaining: ["Confirm destination receipt"], nextAction: "Check receipt" };
  const later = () => new Date(Date.now() + 3600_000).toISOString();
  const worker = (subagentType: string, overrides: Record<string, unknown> = {}) => ({
    requestSource: "agent", runtimeProfile: "subagent", subagentType, pluginNamespaces: [], botId: "child", instructions: "Original authorization and scope.",
    modelRef: {}, reasoning: "low", compactionReadPiMessages: () => [], cwd: "/tmp", contextSessionId: "context", ...overrides,
  }) as any;
  const run = (tools: any, turn: any, name: string, id: string, args: unknown) => tools.customTools(turn).find((tool: any) => tool.name === name)!.execute(id, args, undefined, undefined, {} as never);

  test("worker progress keeps the turn alive, waiting parks it, and compaction sees the latest obligations", async () => {
    const tools = runtimeTools() as any;
    const turn = worker("executor");
    let deferred = false;
    const host = async (_url: unknown, init: any) => {
      const { arguments: args } = JSON.parse(init.body);
      return Response.json({ saved: true, deferred, progress: { ...args, runId: "run", revision: deferred ? 2 : 1 } });
    };
    await withFetch(host, () => run(tools, turn, "ReportTaskProgress", "progress", input));
    expect(turn.endTurnRequested).not.toBe(true);
    expect(compactionObservation(turn).systemPrompt).toContain("Confirm destination receipt");
    expect(compactionObservation(turn).systemPrompt).toContain("Original authorization and scope.");
    deferred = true;
    await withFetch(host, () => run(tools, turn, "ReportTaskProgress", "wait", { ...input, state: "waiting", checkAt: later() }));
    expect(turn.endTurnRequested).toBe(true);
    expect(turn.instructions.split("<durable_task_state>")).toHaveLength(2);
  });

  test("only work-capable delegated workers hold progress, and a failed write neither ends the task nor invents saved state", async () => {
    const tools = runtimeTools() as any;
    for (const kind of ["executor", "knowledgeWork", "computerUse"]) {
      const names = tools.customTools(worker(kind)).map((tool: any) => tool.name);
      expect(names).toContain("ReportTaskProgress");
      expect(names).not.toContain("WakeParent");
    }
    expect(tools.customTools({ requestSource: "turn", runtimeProfile: "agent", subagentType: null, pluginNamespaces: [] }).map((tool: any) => tool.name)).not.toContain("ReportTaskProgress");
    const turn = worker("computerUse", { instructions: "Original scope" });
    await expect(withFetch(async () => Response.json({ error: "database unavailable" }, { status: 503 }), () => run(tools, turn, "ReportTaskProgress", "failed", input))).rejects.toThrow();
    expect(turn.endTurnRequested).not.toBe(true);
    expect(turn.instructions).toBe("Original scope");
  });

  test("a parent saves a separate request wait, carries it into compaction, and workers cannot access that operation", async () => {
    const requestId = crypto.randomUUID();
    const tools = runtimeTools() as any;
    const host = async (_url: unknown, init: any) => {
      const request = JSON.parse(init.body);
      expect(request.tool).toBe("ReportRequestProgress");
      return Response.json({ request_run_id: requestId, deferred: request.arguments.state === "waiting", ended: request.arguments.state === "complete",
        requests: request.arguments.state === "complete" ? [] : [{ request_run_id: requestId, progress: request.arguments }] });
    };
    const active = worker("", { requestSource: "turn", runtimeProfile: "agent", subagentType: null, botId: "owner", instructions: "Only one outgoing message is approved." });
    const waiting = await withFetch(host, () => run(tools, active, "ReportRequestProgress", "wait", { ...input, state: "waiting", checkAt: later() }));
    expect(waiting.terminate).toBe(true);
    expect(active.endTurnRequested).toBe(true);
    const snapshot = compactionObservation(active).systemPrompt;
    for (const value of [requestId, "Confirm destination receipt", "Only one outgoing message is approved."]) expect(snapshot).toContain(value);
    const next = { ...active, endTurnRequested: false };
    expect((await withFetch(host, () => run(tools, next, "ReportRequestProgress", "complete", { ...input, state: "complete", remaining: [] }))).terminate).toBe(true);
    expect(next.endTurnRequested).toBe(true);
    for (const turn of [{ ...active, runtimeProfile: "subagent", subagentType: "executor" }, { ...active, requestSource: "automation" }])
      expect(tools.customTools(turn).map((tool: any) => tool.name)).not.toContain("ReportRequestProgress");
  });
});
