import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NATIVE_TOOL_NAMES } from "@openbot/contracts";
import { BROWSER_USE_TOOLS } from "../src/browser-use";
import { GrokCompactionArchiveStore, GrokCompactionCoordinator } from "../src/grok-compaction";
import { ComputerRuntime } from "../src/runtime";

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

describe("specialized subagent tool surfaces", () => {
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

  test("graphical workers receive compact box-scoped Shell and Read guidance", () => {
    for (const subagentType of ["computerUse", "browserUse"] as const) {
      const descriptions = toolDescriptions(subagentType);
      expect(descriptions.Shell).toContain("this worker's box");
      expect(descriptions.Shell).not.toContain("committing-changes-with-git");
      expect(descriptions.Read).toContain("same filesystem Shell acts on");
    }
  });

  test("normal agents retain the closed ten-tool native catalog", () => {
    expect(toolNames(null)).toEqual(NATIVE_TOOL_NAMES);
  });

  test("normal agents discover A2A under cursor without legacy graphical Computer control", () => {
    expect(dynamicToolNames("openbot")).toEqual([]);
    expect(dynamicToolNames("cursor")).toContain("Task");
    expect(dynamicToolNames("cursor")).toContain("SendToAgent");
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
      start(): Promise<void>;
      contextState(contextSessionId: string): Promise<never>;
      run(request: ReturnType<typeof turnRequest>): Promise<AsyncIterable<unknown>>;
      diagnostics: { activeTurns: number };
    };
    runtime.start = async () => {};
    runtime.authenticated = true;
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
      start(): Promise<void>;
      run(request: ReturnType<typeof turnRequest>): Promise<AsyncIterable<unknown>>;
      diagnostics: { activeTurns: number };
    };
    runtime.start = async () => {};
    runtime.authenticated = true;
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
