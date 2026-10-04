import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NATIVE_TOOL_NAMES } from "@openteam/contracts";
import { BROWSER_USE_TOOLS } from "../../src/browser/use";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import {
  CLOSING_SEND_NUDGE_PROMPT,
  ComputerRuntime,
  isDeliveryOwed,
  modelVisibleSummaryTools,
  REPLY_NUDGE_PROMPT,
} from "../../src/runtime";

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

const toolNames = (subagentType: "computerUse" | "browserUse" | "executor" | null) => {
  const runtime = runtimeTools() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{ name: string }>;
  };
  return runtime.customTools({ subagentType }).map((tool) => tool.name);
};

const toolDescriptions = (subagentType: "computerUse" | "browserUse") => {
  const runtime = runtimeTools() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{
      name: string;
      description: string;
    }>;
  };
  return Object.fromEntries(
    runtime.customTools({ subagentType }).map((tool) => [tool.name, tool.description])
  );
};

const dynamicToolNames = (namespace: string) => {
  const runtime = runtimeTools() as unknown as {
    dynamicCatalog(active: {
      runtimeProfile: "agent";
      pluginNamespaces: [];
    }): Array<{ name: string; tools: Array<{ name: string }> }>;
  };
  return (
    runtime
      .dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((candidate) => candidate.name === namespace)
      ?.tools.map((tool) => tool.name) ?? []
  );
};

const subagentDynamicToolNames = (namespace: string) => {
  const runtime = runtimeTools() as unknown as {
    dynamicCatalog(active: {
      runtimeProfile: "subagent";
      pluginNamespaces: [];
    }): Array<{ name: string; tools: Array<{ name: string }> }>;
  };
  return (
    runtime
      .dynamicCatalog({ runtimeProfile: "subagent", pluginNamespaces: [] })
      .find((candidate) => candidate.name === namespace)
      ?.tools.map((tool) => tool.name) ?? []
  );
};

describe("specialized subagent tool surfaces", () => {
  test("image generation is removed while unconfigured search remains discoverable", () => {
    for (const names of [dynamicToolNames("cursor"), subagentDynamicToolNames("cursor")]) {
      expect(names).not.toContain("GenerateImage");
      expect(names).toContain("WebSearch");
      expect(names).toContain("WebFetch");
    }
  });

  test("uses Bot's exact delivery nudges only for user-facing wake sources", () => {
    expect(REPLY_NUDGE_PROMPT).toContain("ack ≠ delivery");
    expect(REPLY_NUDGE_PROMPT).toEndWith("they just keep seeing silence.");
    expect(CLOSING_SEND_NUDGE_PROMPT).toEndWith(
      "continue it and send the result once you have it."
    );
    for (const source of ["turn", "handoff-resume", "broadcast", "connector"] as const) {
      expect(isDeliveryOwed(source)).toBe(true);
    }
    for (const source of ["agent", "automation", "event", "background-revival"] as const) {
      expect(isDeliveryOwed(source)).toBe(false);
    }
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
    const executable = runtime.customTools({ subagentType: null });
    const visible = modelVisibleSummaryTools(executable);
    expect(visible.map((tool) => tool.name)).toEqual(executable.map((tool) => tool.name));
    expect(visible.map((tool) => tool.description)).toEqual(
      executable.map((tool) => tool.description)
    );
    expect(visible.every((tool) => !("execute" in tool))).toBe(true);
  });

  test("combined computerUse receives Shell, Read, Computer and the browser tools", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "Computer", ...BROWSER_USE_TOOLS.map(tool => tool.name)]);
  });

  test("split and resumed graphical workers retain disabled-tool restrictions", () => {
    const runtime = runtimeTools() as any;
    const taskConfiguration = { combinedComputerUse: false, executorProfiles: [], disabledToolIdentifiers: ["SHELL", "BROWSER_CDP", "OPENAI_COMPUTER_USE"] };
    expect(runtime.customTools({ subagentType: "computerUse", taskConfiguration }).map((tool: any) => tool.name)).toEqual(["Read"]);
    const browser = runtime.customTools({ subagentType: "browserUse", taskConfiguration }).map((tool: any) => tool.name);
    expect(browser).toContain("browser_snapshot");
    expect(browser).not.toContain("browser_cdp");
    expect(browser).not.toContain("Shell");
    expect(browser).not.toContain("Computer");
  });

  test("browserUse receives only Shell, Read, and the direct browser tools", () => {
    expect(toolNames("browserUse")).toEqual([
      "Shell",
      "Read",
      ...BROWSER_USE_TOOLS.map((tool) => tool.name),
    ]);
  });

  test("executor stays private while retaining execution and discovery tools", () => {
    const names = toolNames("executor");
    expect(names).not.toContain("SendToUser");
    expect(names).not.toContain("ReactToMessage");
    expect(names).not.toContain("update_state");
    expect(names).toContain("Shell");
    expect(names).toContain("Read");
    expect(names).toContain("GetDynamicTools");
    expect(names).toContain("CallDynamicTool");
    expect(subagentDynamicToolNames("cursor")).toEqual(["WebFetch", "WebSearch", "AwaitShell", "TodoWrite"]);
  });

  test("graphical workers receive compact box-scoped Shell and Read guidance", () => {
    for (const subagentType of ["computerUse", "browserUse"] as const) {
      const descriptions = toolDescriptions(subagentType);
      expect(descriptions.Shell).toContain("this worker's box");
      expect(descriptions.Shell).not.toContain("committing-changes-with-git");
      expect(descriptions.Read).toContain("same filesystem Shell acts on");
    }
  });

  test("normal agents target hosts with machineId on Shell and Read", () => {
    const names = toolNames(null);
    expect(names).toEqual(
      NATIVE_TOOL_NAMES.filter((name) => !["ExternalShell", "ExternalRead"].includes(name))
    );
    expect(names).toContain("ListMachines");
    expect(names).toContain("Shell");
    expect(names).toContain("Read");
    expect(names).not.toContain("ExternalShell");
    expect(names).not.toContain("ExternalRead");
  });

  test("normal agents discover A2A under cursor without legacy graphical Computer control", () => {
    expect(dynamicToolNames("openteam")).toEqual([]);
    expect(dynamicToolNames("cursor")).toContain("Task");
    expect(dynamicToolNames("cursor")).toContain("SendToAgent");
    expect(dynamicToolNames("cursor")).toContain("ListAgents");
    expect(dynamicToolNames("cursor")).toContain("ListGroups");
    expect(dynamicToolNames("cursor")).toContain("request_box_help");
  });

  test("directory tools validate bounded inputs and route through the control plane", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const runtime = runtimeTools() as unknown as {
      callControlPlaneTool(
        active: unknown,
        callId: string,
        tool: string,
        args: unknown
      ): Promise<{ content: []; details: Record<string, unknown> }>;
      dynamicCatalog(active: { runtimeProfile: "agent"; pluginNamespaces: [] }): Array<{
        name: string;
        tools: Array<{
          name: string;
          decodeArguments(args: unknown): unknown;
          execute(active: unknown, callId: string, args: unknown): Promise<unknown>;
        }>;
      }>;
    };
    runtime.callControlPlaneTool = async (_active, _callId, tool, args) => {
      calls.push({ tool, args });
      return { content: [], details: {} };
    };
    const catalog = runtime
      .dynamicCatalog({ runtimeProfile: "agent", pluginNamespaces: [] })
      .find((namespace) => namespace.name === "cursor");
    const listAgents = catalog?.tools.find((tool) => tool.name === "ListAgents");
    const listGroups = catalog?.tools.find((tool) => tool.name === "ListGroups");

    expect(listAgents?.decodeArguments({ query: "research", limit: 50 })).toEqual({
      query: "research",
      limit: 50,
    });
    expect(() => listAgents?.decodeArguments({ limit: 51 })).toThrow();
    expect(() => listGroups?.decodeArguments({ query: "x".repeat(121) })).toThrow();
    await listAgents?.execute({}, "call-agents", { query: "target", limit: 3 });
    await listGroups?.execute({}, "call-groups", { limit: 2 });
    expect(calls).toEqual([
      { tool: "ListAgents", args: { query: "target", limit: 3 } },
      { tool: "ListGroups", args: { limit: 2 } },
    ]);
  });

  test("normal agents expose the complete plugin lifecycle management surface", () => {
    expect(dynamicToolNames("cursor")).toEqual(
      expect.arrayContaining([
        "SearchPlugins",
        "GetPlugin",
        "GetMcpServerStatus",
        "InstallPlugin",
        "UninstallPlugin",
        "AddMcpServer",
        "UninstallMcpServer",
        "AuthenticateMcpServer",
        "RestartMcpServers",
        "RenameMcpAccount",
        "RemoveMcpAccount",
        "SetMcpInstructions",
      ])
    );
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
      "- [completed] audit: Review parity\n- [in_progress] ship: Run checks"
    );
  });

  test("clears the summary todo snapshot when TodoWrite clears the queue", async () => {
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
      content: [{ type: "text", text: JSON.stringify({ todos: [] }) }],
      details: {},
    });
    const active = { todoUpdate: "- [pending] stale: Old snapshot" };
    await runtime.executeTodoWrite(active, "call-1", { todos: [] });
    expect(active.todoUpdate).toBeNull();
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

  test("rejects an out-of-root persisted session before opening it", async () => {
    const runtime = new ComputerRuntime() as unknown as {
      authenticated: boolean;
      modelRuntime: {
        checkAuth(providerId: string): Promise<{ type: string; source: string }>;
        isUsingSubscription(providerId: string): boolean;
      };
      resolveModel(): object;
      start(): Promise<void>;
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
    await expect(
      runtime.run(turnRequest({ sessionPath: "/tmp/not-an-openteam-session.jsonl" }))
    ).rejects.toThrow("outside the OpenTeam session directory");
    expect(runtime.diagnostics.activeTurns).toBe(0);
  });

  test("replays a staged archive from the matching persisted Pi compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-compaction-recovery-"));
    temporaryRoots.push(root);
    const sessionsDir = join(root, "sessions", "openteam");
    const contextSessionsDir = join(root, "context-sessions");
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(contextSessionsDir, { recursive: true }),
    ]);
    const contextSessionId = crypto.randomUUID();
    const compactionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(contextSessionsDir);
    await store.stage(contextSessionId, {
      id: compactionId,
      reason: "approaching_token_limit",
      summary: "recoverable summary",
      prefixDigest: "a".repeat(64),
      userInfoMessage: null,
      lastUserMessage: {
        role: "user",
        content: [{ type: "text", text: "latest request" }],
        timestamp: 1,
      },
      preservedTailMessages: [],
      summarizedMessages: [],
      tokensBefore: 95_000,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 12,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });

    const manager = SessionManager.create(root, sessionsDir, { id: contextSessionId });
    const firstKeptEntryId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "latest request" }],
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    manager.appendCompaction(
      "recoverable summary",
      firstKeptEntryId,
      95_000,
      { openteamBotCompaction: true, id: compactionId },
      true
    );

    const runtime = new ComputerRuntime() as unknown as {
      sessionsDir: string;
      contextSessionsDir: string;
      compactionArchive: BotCompactionArchiveStore;
      compaction: BotCompactionCoordinator;
      contextState(contextSessionId: string): Promise<{ epoch: number }>;
    };
    runtime.sessionsDir = sessionsDir;
    runtime.contextSessionsDir = contextSessionsDir;
    runtime.compactionArchive = store;
    runtime.compaction = new BotCompactionCoordinator(store, 0);

    expect((await runtime.contextState(contextSessionId)).epoch).toBe(1);
    expect((await store.latest(contextSessionId))?.piBaseMessageCount).toBe(
      manager.buildSessionContext().messages.length
    );
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });
});

test('foreground Task yields existing worker identity for pending steering instead of polling forever', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url:any, init:any) => { calls++; const body=JSON.parse(init.body); return Response.json(body.foregroundYield ? {foregroundYielded:true,subagent_id:'existing-worker',status:'running',message:'MessageSubagent'} : {foregroundPending:true,subagent_id:'existing-worker',attempt_id:'attempt'}); }) as unknown as typeof fetch;
  try {
    const result = await runtime.callControlPlaneTool({pendingSteers:[{content:'Apply correction'}]}, 'call', 'Task', {});
    expect(calls).toBe(2);
    expect(result.content[0].text).toContain('existing-worker');
    expect(result.content[0].text).toContain('MessageSubagent');
  } finally {globalThis.fetch=previousFetch;}
});

test('foreground Task keeps the same call identity while waiting without steering', async () => {
  const runtime = runtimeTools() as any;
  const previousFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (_url:any, init:any) => {
    requests.push(JSON.parse(init.body));
    return Response.json(requests.length === 1 ? {foregroundPending:true,subagent_id:'existing-worker'} : {status:'completed',result:'done'});
  }) as unknown as typeof fetch;
  try {
    const result = await runtime.callControlPlaneTool({pendingSteers:[]}, 'same-call', 'Task', {prompt:'existing task'});
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(result.content[0].text).toContain('done');
  } finally {globalThis.fetch=previousFetch;}
});

test('browser workers retain their parent desktop session and steering cancels only the waiting run', async () => {
  const tools = runtimeTools() as any;
  tools.screens.browserEndpointForAgent = async () => 'http://unused-test-endpoint';
  const used: string[] = [];
  const makeBrowser = (name: string) => ({connected:true, configureUploads(){}, registerPrivateValues(){}, watchLoginFocus(){return () => {};},
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
  const pending=tools.callBrowserForTurn(turn,'browser_wait_for',{time:10});
  await new Promise(resolve=>setTimeout(resolve,0));
  tools.interruptShellWaits('different-run'); expect(tools.shellWaits.size).toBe(1);
  tools.interruptShellWaits('wait-run'); await expect(pending).rejects.toThrow('new user message');
  expect(tools.shellWaits.size).toBe(0); expect(used).toEqual(['first','other','first']);
});
