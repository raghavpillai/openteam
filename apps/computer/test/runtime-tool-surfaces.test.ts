import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NATIVE_TOOL_NAMES } from "@openbot/contracts";
import { BROWSER_USE_TOOLS } from "../src/browser-use";
import { GrokCompactionArchiveStore, GrokCompactionCoordinator } from "../src/grok-compaction";
import { HostApprovalRequiredError } from "../src/native-tool-executor";
import {
  CLOSING_SEND_NUDGE_PROMPT,
  ComputerRuntime,
  isDeliveryOwed,
  modelVisibleSummaryTools,
  REPLY_NUDGE_PROMPT,
} from "../src/runtime";

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
  channelId: crypto.randomUUID(),
  deliveryId: null,
  ...overrides,
});

const toolNames = (subagentType: "computerUse" | "browserUse" | "executor" | null) => {
  const runtime = new ComputerRuntime() as unknown as {
    customTools(active: { subagentType: typeof subagentType }): Array<{ name: string }>;
  };
  return runtime.customTools({ subagentType }).map((tool) => tool.name);
};

const toolDescriptions = (subagentType: "computerUse" | "browserUse") => {
  const runtime = new ComputerRuntime() as unknown as {
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
  const runtime = new ComputerRuntime() as unknown as {
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
  const runtime = new ComputerRuntime() as unknown as {
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
  test("uses Grok's exact delivery nudges only for user-facing wake sources", () => {
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
    const runtime = new ComputerRuntime() as unknown as {
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

  test("computerUse receives only Shell, Read, and direct Computer", () => {
    expect(toolNames("computerUse")).toEqual(["Shell", "Read", "Computer"]);
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
    expect(subagentDynamicToolNames("cursor")).toEqual(["TodoWrite"]);
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
    expect(dynamicToolNames("openbot")).toEqual([]);
    expect(dynamicToolNames("cursor")).toContain("Task");
    expect(dynamicToolNames("cursor")).toContain("SendToAgent");
    expect(dynamicToolNames("cursor")).toContain("ListAgents");
    expect(dynamicToolNames("cursor")).toContain("ListGroups");
  });

  test("directory tools validate bounded inputs and route through the control plane", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const runtime = new ComputerRuntime() as unknown as {
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

describe("local computer approval broker", () => {
  const runtimeHarness = () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = new ComputerRuntime() as unknown as {
      executeHostTool(
        active: { runId: string; turnId: string; queue: { push(event: unknown): void } },
        callId: string,
        toolName: string,
        signal: AbortSignal | undefined,
        execute: (approvals: Record<string, unknown>) => Promise<unknown>
      ): Promise<unknown>;
      resolveApproval(approvalId: string, decision: "accept" | "decline"): void;
    };
    const active = {
      runId: "run-1",
      turnId: "run-1",
      queue: { push: (event: unknown) => events.push(event as Record<string, unknown>) },
    };
    return { active, events, runtime };
  };

  test("pauses one host call and retries it with a one-shot token after approval", async () => {
    const { active, events, runtime } = runtimeHarness();
    const attempts: Array<Record<string, unknown>> = [];
    const execution = runtime.executeHostTool(
      active,
      "call-1",
      "Shell",
      undefined,
      async (approvals) => {
        attempts.push({ ...approvals });
        if (attempts.length === 1) {
          throw new HostApprovalRequiredError({
            gate: "local",
            requestMethod: "openbot/localTool",
            details: { type: "localTool", machineId: "machine-1" },
          });
        }
        return { content: [{ type: "text", text: "ran" }], details: {} };
      }
    );
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "approval.requested",
      requestMethod: "openbot/localTool",
      itemId: "call-1",
    });
    runtime.resolveApproval(String(events[0]?.approvalId), "accept");
    expect(await execution).toMatchObject({ content: [{ type: "text", text: "ran" }] });
    expect(attempts).toEqual([{}, { localApproval: "allow-once" }]);
  });

  test("turns denial into a do-not-retry tool error without a second host call", async () => {
    const { active, events, runtime } = runtimeHarness();
    let attempts = 0;
    const execution = runtime.executeHostTool(active, "call-2", "Shell", undefined, async () => {
      attempts += 1;
      throw new HostApprovalRequiredError({
        gate: "local",
        requestMethod: "openbot/localTool",
        details: { type: "localTool", machineId: "machine-1" },
      });
    });
    await Promise.resolve();
    runtime.resolveApproval(String(events[0]?.approvalId), "decline");
    await expect(execution).rejects.toThrow("Do not retry it");
    expect(attempts).toBe(1);
  });

  test("routes Shell by machineId while keeping omitted machineId in the box", async () => {
    const calls: string[] = [];
    const runtime = new ComputerRuntime() as unknown as {
      nativeToolExecutor: {
        shell: (...args: unknown[]) => Promise<unknown>;
        externalShell: (...args: unknown[]) => Promise<unknown>;
      };
      executeOpenBotTool(
        active: Record<string, unknown>,
        callId: string,
        tool: string,
        args: unknown,
        signal?: AbortSignal
      ): Promise<unknown>;
    };
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

    await runtime.executeOpenBotTool(active, "box-call", "Shell", { command: "pwd" });
    await runtime.executeOpenBotTool(active, "host-call", "Shell", {
      command: "pwd",
      machineId: "machine-1",
    });
    expect(calls).toEqual(["box", "host"]);
  });
});

describe("compaction durable state capture", () => {
  test("refreshes the summary todo snapshot after a successful TodoWrite", async () => {
    const runtime = new ComputerRuntime() as unknown as {
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
    const runtime = new ComputerRuntime() as unknown as {
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
    runtime.authenticated = true;
    runtime.resolveModel = () => ({});
    runtime.modelRuntime = {
      checkAuth: async () => ({ type: "oauth", source: "test" }),
      isUsingSubscription: () => true,
    };
    await expect(
      runtime.run(turnRequest({ sessionPath: "/tmp/not-an-openbot-session.jsonl" }))
    ).rejects.toThrow("outside the OpenBot session directory");
    expect(runtime.diagnostics.activeTurns).toBe(0);
  });

  test("replays a staged archive from the matching persisted Pi compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-compaction-recovery-"));
    temporaryRoots.push(root);
    const sessionsDir = join(root, "sessions", "openbot");
    const contextSessionsDir = join(root, "context-sessions");
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(contextSessionsDir, { recursive: true }),
    ]);
    const contextSessionId = crypto.randomUUID();
    const compactionId = crypto.randomUUID();
    const store = new GrokCompactionArchiveStore(contextSessionsDir);
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
      { openbotGrokCompaction: true, id: compactionId },
      true
    );

    const runtime = new ComputerRuntime() as unknown as {
      sessionsDir: string;
      contextSessionsDir: string;
      compactionArchive: GrokCompactionArchiveStore;
      compaction: GrokCompactionCoordinator;
      contextState(contextSessionId: string): Promise<{ epoch: number }>;
    };
    runtime.sessionsDir = sessionsDir;
    runtime.contextSessionsDir = contextSessionsDir;
    runtime.compactionArchive = store;
    runtime.compaction = new GrokCompactionCoordinator(store, 0);

    expect((await runtime.contextState(contextSessionId)).epoch).toBe(1);
    expect((await store.latest(contextSessionId))?.piBaseMessageCount).toBe(
      manager.buildSessionContext().messages.length
    );
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });
});
