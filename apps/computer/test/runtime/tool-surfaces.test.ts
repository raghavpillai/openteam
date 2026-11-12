import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { BROWSER_USE_TOOLS } from "../../src/browser/use";
import { ComputerRuntime, modelVisibleSummaryTools } from "../../src/runtime";

const runtimeTools = () => (new ComputerRuntime() as unknown as { tools: unknown }).tools;

test('background status evidence comes only from active server records', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
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
  try {
    for (const [body, expected] of fixtures) {
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
      const result = await runtime.callControlPlaneTool({}, 'check', 'CheckSubagent', {});
      expect(result.details.pendingBackgroundWork).toBe(expected);
    }
  } finally { globalThis.fetch = previousFetch; }
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
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

  test("summary requests receive normal schemas but no executable tool functions", () => {
    const runtime = runtimeTools() as unknown as {
      customTools(active: { subagentType: null }): Array<{
        name: string;
        description: string;
        parameters: unknown;
        execute: unknown;
      }>;
    };
    const executable = runtime.customTools(workerTurn(null));
    const visible = modelVisibleSummaryTools(executable);
    expect(visible.map((tool) => tool.name)).toEqual(executable.map((tool) => tool.name));
    expect(visible.map((tool) => tool.description)).toEqual(
      executable.map((tool) => tool.description)
    );
    expect(visible.every((tool) => !("execute" in tool))).toBe(true);
  });

  test("computerUse receives Shell, Read, AwaitShell, Computer and the browser tools", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "ReportTaskProgress", "AwaitShell", "Computer", ...BROWSER_USE_TOOLS.map(tool => tool.name)]);
  });

  test("StopSubagent and request_box_help decode their reference arguments and route through the control plane", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(active: unknown, callId: string, tool: string, args: unknown): Promise<{ content: []; details: Record<string, unknown> }>;
      dynamicCatalog(active: { runtimeProfile: "agent"; pluginNamespaces: [] }): Array<{
        name: string;
        tools: Array<{ name: string; decodeArguments(args: unknown): unknown; execute(active: unknown, callId: string, args: unknown): Promise<unknown> }>;
      }>;
    };
    runtime.callControlPlaneTool = async (_active, _callId, tool, args) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const catalog = runtime.dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] }).find((namespace) => namespace.name === "cursor");
    const stop = catalog!.tools.find((tool) => tool.name === "StopSubagent")!;
    expect(stop.decodeArguments({ all: true })).toEqual({ all: true });
    expect(stop.decodeArguments({ subagent_id: "sand-subagent-1" })).toEqual({ subagent_id: "sand-subagent-1" });
    for (const invalid of [{}, { all: false }, { all: true, subagent_id: "sand-subagent-1" }])
      expect(() => stop.decodeArguments(invalid), JSON.stringify(invalid)).toThrow();
    const help = catalog!.tools.find((tool) => tool.name === "request_box_help")!;
    const handoff = { instruction: "Sign in", reason: "auth", domain: "example.com", url: "https://app.example.com/login" };
    expect(help.decodeArguments(handoff)).toEqual(handoff);
    await stop.execute({}, "call-stop", { all: true });
    expect(calls).toEqual([{ tool: "StopSubagent", args: { all: true } }]);
  });

  test("DraftExternalMessage refuses HTML email bodies and sends the server an unwrapped body", () => {
    const runtime = runtimeTools() as unknown as {
      dynamicCatalog(active: { runtimeProfile: "agent"; pluginNamespaces: [] }): Array<{
        name: string;
        tools: Array<{ name: string; decodeArguments(args: unknown): unknown }>;
      }>;
    };
    const draft = runtime.dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((namespace) => namespace.name === "cursor")!.tools.find((tool) => tool.name === "DraftExternalMessage")!;
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

describe("local computer routing", () => {
  test("routes Shell by machineId while keeping omitted machineId in the box", async () => {
    const calls: string[] = [];
    const runtime = runtimeTools() as unknown as {
      processSecrets: () => Promise<Record<string, string>>;
      nativeToolExecutor: {
        shell: (...args: unknown[]) => Promise<unknown>;
        externalShell: (...args: unknown[]) => Promise<unknown>;
      };
      executeOpenTeamTool(
        active: Record<string, unknown>,
        callId: string,
        tool: string,
        args: unknown,
        signal?: AbortSignal
      ): Promise<unknown>;
    };
    runtime.processSecrets = async () => ({});
    runtime.nativeToolExecutor.shell = async () => {
      calls.push("box");
      return { content: [{ type: "text", text: "box" }], details: {} };
    };
    runtime.nativeToolExecutor.externalShell = async () => {
      calls.push("host");
      return { content: [{ type: "text", text: "host" }], details: {} };
    };
    const active = {
      subagentType: null,
      cwd: "/workspace",
      runId: "run-1",
      turnId: "run-1",
      queue: { push: () => undefined },
    };

    await runtime.executeOpenTeamTool(active, "box-call", "Shell", { command: "pwd" });
    await runtime.executeOpenTeamTool(active, "host-call", "Shell", {
      command: "pwd",
      machineId: "machine-1",
    });
    expect(calls).toEqual(["box", "host"]);
  });
});

describe("compaction durable state capture", () => {
  test("refreshes the summary todo snapshot after a successful TodoWrite", async () => {
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
      executeTodoWrite(
        active: { todoUpdate: string | null },
        callId: string,
        args: unknown
      ): Promise<unknown>;
    };
    runtime.callControlPlaneTool = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            todos: [
              { id: "audit", content: "Review parity", status: "completed" },
              { id: "ship", content: "Run checks", status: "in_progress" },
            ],
          }),
        },
      ],
      details: {},
    });
    const active = { todoUpdate: "- [pending] stale: Old snapshot" };
    await runtime.executeTodoWrite(active, "call-1", { todos: [] });
    expect(active.todoUpdate).toBe(
      "- **COMPLETED**: Review parity (id: audit)\n- **IN_PROGRESS**: Run checks (id: ship)"
    );
  });

});

describe("context turn reservation", () => {
  test("reserves a context before asynchronous setup and releases it on failure", async () => {
    const runtime = new ComputerRuntime() as unknown as {
      authenticated: boolean;
      modelRuntime: {
        checkAuth(providerId: string): Promise<{ type: string; source: string }>;
        isUsingSubscription(providerId: string): boolean;
      };
      resolveModel(): object;
      start(): Promise<void>;
      contextState(contextSessionId: string): Promise<never>;
      run(request: ReturnType<typeof turnRequest>): Promise<AsyncIterable<unknown>>;
      diagnostics: { activeTurns: number };
    };
    runtime.start = async () => {};
    Object.assign((runtime as any).tools.userForms, { beginTurn: async () => {}, endTurn: async () => {} });
    runtime.authenticated = true;
    runtime.resolveModel = () => ({});
    runtime.modelRuntime = {
      checkAuth: async () => ({ type: "oauth", source: "test" }),
      isUsingSubscription: () => true,
    };
    let rejectSetup!: (error: Error) => void;
    let enteredSetup!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredSetup = resolve;
    });
    runtime.contextState = async () =>
      new Promise<never>((_resolve, reject) => {
        rejectSetup = reject;
        enteredSetup();
      });
    const contextSessionId = crypto.randomUUID();
    const first = runtime.run(turnRequest({ contextSessionId }));
    await entered;
    await expect(
      runtime.run(turnRequest({ contextSessionId, runId: crypto.randomUUID() }))
    ).rejects.toThrow("already has an active Pi turn");
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
  const previousFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body).arguments);
    return Response.json({ error: { code: 'subagent_not_resumable', message: "That background subagent is still running, so it can't be resumed yet." } }, { status: 409 });
  }) as unknown as typeof fetch;
  try {
    const task = runtime.dynamicCatalog(workerTurn(null)).find((namespace: any) => namespace.name === 'cursor').tools.find((tool: any) => tool.name === 'Task');
    expect(task.decodeArguments({ description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' }).subagent_type).toBe('computerUse');
    const active = { ...workerTurn(null), runId: 'run-1' };
    await expect(runtime.executeOpenTeamTool(active, 'call', 'CallDynamicTool', {
      namespace: 'cursor', toolName: 'Task', arguments: { description: 'Book', prompt: 'Book it', subagent_type: 'computer_use' },
    })).rejects.toThrow(/^Error: That background subagent is still running, so it can't be resumed yet\.$/);
    expect(sent[0].subagent_type).toBe('computerUse');
  } finally { globalThis.fetch = previousFetch; }
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
