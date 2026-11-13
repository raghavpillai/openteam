/** Issue #277: characterize live prompt inputs, then verify that the production
 * runtime pins the model-visible prefix and persists updates at the tail.
 * Inference transport and database reads are fixtures; the session, snapshot,
 * context hook and provider serializer are real.
 */
import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ComputerRuntime } from "../src/runtime";
import type { ComputerEvent } from "@openteam/contracts";
import { AgentMessaging } from "../../../packages/messaging/src";
import { AgentDataStore } from "../../../packages/messaging/src/agent-data";
import { timestampUserTurn } from "../../../packages/messaging/src/timestamps";
import {
  BotCompactionCoordinator,
  BotCompactionArchiveStore,
  botUserInfoMessage,
  botMessageDigest,
} from "../src/bot-compaction";
import { enrichUserInfo, renderDynamicToolCatalog } from "../src/runtime/prompt-context";
import { pinDynamicToolCatalog } from "../src/runtime/catalog-snapshot";
const peers = (n: number): any[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `agent-${i.toString().padStart(5, "0")}`,
    name: `Agent ${i}`,
    hiddenFromSidebar: false,
  }));
const directories: string[] = [];
afterEach(async () => {
  setSystemTime();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-277-"));
  directories.push(root);
  return root;
};
const now = () => setSystemTime(new Date("2026-11-13T12:00:00Z"));
const fixture = () => {
  const queryArgs: Record<string, unknown> = {};
  const recent = peers(2);
  const groups = [
    {
      id: "group-one",
      name: "Group One",
      members: [{ bot: recent[0] }],
      workingDirectory: "/project",
    },
  ];
  const state = { epoch: 0, zone: "UTC", skills: "fixed skills", memory: "original facts" };
  const snapshots = new Map<string, any>();
  const db = {
    $transaction: async (fn: any) => fn(db),
    $executeRaw: async () => 0,
    contextPromptSnapshot: {
      findUniqueOrThrow: async ({ where }: any) =>
        snapshots.get(where.contextSessionId) ?? { promptSections: {} },
      update: async ({ where, data }: any) => {
        snapshots.set(where.contextSessionId, structuredClone(data));
        return data;
      },
    },
  };
  const store = () =>
    new AgentDataStore(db as never, { root: "/agent-data", workspaceRoot: "/workspace" });
  const messaging = Object.create(AgentMessaging.prototype) as Record<string, unknown>;
  Object.assign(messaging, {
    userTimeZone: async () => state.zone,
    agentData: {
      root: "/agent-data",
      preparePlatformSections: (...args: any[]) =>
        (store().preparePlatformSections as any)(...args),
      promptContext: async () => ({
        compactionEpoch: state.epoch,
        profileSection: "You are Main.",
        profileSnapshot: null,
        identityAnnouncement: "",
        memory: { policy: "## Memory\nMemory policy.", facts: state.memory },
        skillRender: state.skills,
        warnings: [],
      }),
      loadInferenceSettings: async () => ({
        providerId: "openai-codex",
        modelId: "gpt-5.5",
        reasoning: "high",
      }),
      loadTaskConfiguration: async () => ({ executorProfiles: [] }),
    },
    prisma: {
      run: { findMany: async () => [] },
      $queryRaw: async () => [],
      contextSession: { findMany: async () => [], findFirst: async () => null },
      bot: {
        findUniqueOrThrow: async (args: Record<string, unknown>) => {
          queryArgs.bot = args;
          return {
            id: "main",
            name: "Main",
            hiddenFromSidebar: false,
            notificationsEnabled: true,
            defaultDirectory: "/workspace",
            subagentIdentity: null,
            todos: [],
          };
        },
        findMany: async (args: Record<string, unknown>) => {
          queryArgs.peers = args;
          return recent;
        },
      },
      channel: {
        findMany: async (args: Record<string, unknown>) => {
          queryArgs.groups = args;
          return groups;
        },
      },
      botConnectorState: { findMany: async () => [] },
      routine: { findMany: async () => [] },
    },
  });

  const prompt = (context = "same-context") =>
    AgentMessaging.prototype.platformPrompt.call(
      messaging as unknown as AgentMessaging,
      "main",
      context,
      ""
    );
  const restart = () => {
    for (const [key, value] of snapshots) snapshots.set(key, JSON.parse(JSON.stringify(value)));
  };
  return { recent, groups, state, prompt, restart };
};
const leading = (p: any) =>
  botUserInfoMessage(
    enrichUserInfo(p.userInfo, { cwd: "/workspace", catalog: null }),
    p.userInfoEpoch
  );
const project = async (p: any, history: any[], root: string) =>
  new BotCompactionCoordinator(new BotCompactionArchiveStore(root), 0).modelContextMessages({
    contextSessionId: "11111111-1111-4111-8111-111111111111",
    piMessages: history,
    systemPrompt: p.instructions,
    userInfoMessage: leading(p),
    usedTokens: 100,
    maxTokens: 100000,
  });

test("unchanged calls and a serialized snapshot restart preserve the model prefix", async () => {
  now();
  const f = fixture();
  const a = await f.prompt();
  f.restart();
  const b = await f.prompt();
  expect(b.instructions).toBe(a.instructions);
  expect(b.userInfo).toBe(a.userInfo);
  expect(leading(b)).toEqual(leading(a));
});

const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "create bot",
    (f) => f.recent.push({ id: "new-bot", name: "New Bot", hiddenFromSidebar: false }),
  ],
  ["delete bot", (f) => f.recent.pop()],
  ["rename bot", (f) => (f.recent[1].name = "Renamed")],
  ["change description", (f) => (f.recent[1].description = "New description")],
  ["hide bot", (f) => (f.recent[1].hiddenFromSidebar = true)],
  [
    "create group",
    (f) =>
      f.groups.push({ id: "group-two", name: "New Group", members: [], workingDirectory: "/new" }),
  ],
  ["remove group", (f) => f.groups.splice(0)],
  ["rename group", (f) => (f.groups[0]!.name = "Renamed Group")],
  [
    "change group members",
    (f) => (f.groups[0]!.members = [{ bot: { ...f.recent[1], name: "New Member" } }]),
  ],
  ["change group directory", (f) => (f.groups[0]!.workingDirectory = "/changed")],
  [
    "remove entire roster",
    (f) => {
      f.recent.splice(0);
      f.groups.splice(0);
    },
  ],
];
for (const [name, mutate] of cases)
  test(`live renderer: ${name} rewrites message zero while preserving the conversation`, async () => {
    now();
    const f = fixture();
    const first = await f.prompt();
    mutate(f);
    f.restart();
    const changed = await f.prompt();
    expect(changed.userInfoEpoch).toBe(first.userInfoEpoch);
    expect(changed.instructions).toBe(first.instructions);
    expect(changed.userInfo).not.toBe(first.userInfo);
    const history: any[] = [
      leading(first),
      { role: "user", content: "one", timestamp: 1 },
      { role: "assistant", content: "one", timestamp: 2 },
    ];
    const root = await directory();
    const before = await project(first, history, root);
    const after = await project(changed, history, root);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(after[0]).toEqual(leading(changed));
    expect(botMessageDigest(after)).not.toBe(botMessageDigest(before));
  });

test("live renderer: adding the first teammate bypasses the frozen no-teammates system section", async () => {
  now();
  const f = fixture();
  f.recent.splice(0);
  f.groups.splice(0);
  const a = await f.prompt();
  f.recent.push({ id: "first", name: "First Teammate" });
  const b = await f.prompt();
  expect(b.instructions).toBe(a.instructions);
  expect(b.instructions).toContain("This user has no other agents yet");
  expect(b.userInfo).toContain("First Teammate");
  expect(b.instructionsUpdate).toContain("Teammates and groups");
});

test("stable ordering alone handles query reorder but cannot protect a changed roster", async () => {
  now();
  const f = fixture();
  const a = await f.prompt();
  f.recent.reverse();
  const b = await f.prompt();
  expect(b.userInfo).toBe(a.userInfo);
  f.recent.push({ id: "new", name: "New" });
  expect((await f.prompt()).userInfo).not.toBe(a.userInfo);
});

test("bounded roster: creating an omitted peer need not change every other bot's prefix", async () => {
  now();
  const f = fixture();
  f.groups.splice(0);
  f.recent.splice(0, ...peers(41));
  const a = await f.prompt();
  f.recent.push({ id: "omitted", name: "Omitted" });
  const b = await f.prompt();
  expect(b.userInfo).toBe(a.userInfo);
  f.recent.unshift({ id: "newest", name: "Newest" });
  const c = await f.prompt();
  expect(c.userInfo).not.toBe(a.userInfo);
});

for (const [zone, before, after] of [
  ["UTC", "2026-11-13T23:59:59Z", "2026-11-14T00:00:01Z"],
  ["Asia/Jerusalem", "2026-11-13T21:59:59Z", "2026-11-13T22:00:01Z"],
  ["America/New_York", "2026-11-14T04:59:59Z", "2026-11-14T05:00:01Z"],
] as const)
  test(`live renderer: local midnight in ${zone} rewrites the same epoch`, async () => {
    const f = fixture();
    f.state.zone = zone;
    setSystemTime(new Date(before));
    const a = await f.prompt();
    setSystemTime(new Date(after));
    const b = await f.prompt();
    expect(b.userInfoEpoch).toBe(a.userInfoEpoch);
    expect(b.instructions).toBe(a.instructions);
    expect(b.userInfo).not.toBe(a.userInfo);
    expect(a.userInfo).toContain("Friday Nov 13, 2026");
    expect(b.userInfo).toContain("Saturday Nov 14, 2026");
    expect(timestampUserTurn("new turn", { timeZone: zone })).toContain("Nov 14, 2026");
  });

test("UTC midnight alone does not change the date before the user's local midnight", async () => {
  const f = fixture();
  f.state.zone = "America/New_York";
  setSystemTime(new Date("2026-11-13T23:59:59Z"));
  const a = await f.prompt();
  setSystemTime(new Date("2026-11-14T00:00:01Z"));
  expect((await f.prompt()).userInfo).toBe(a.userInfo);
});

test("existing memory pin survives changes and restart and refreshes at compaction", async () => {
  now();
  const f = fixture();
  const a = await f.prompt();
  f.state.memory = "new facts";
  f.restart();
  const b = await f.prompt();
  expect(b.userInfo).toBe(a.userInfo);
  f.state.epoch++;
  const c = await f.prompt();
  expect(c.userInfoEpoch).toBe(1);
  expect(c.userInfo).toContain("new facts");
  expect(c.userInfo).not.toContain("original facts");
});

test("compaction refreshes the date and roster; separate contexts keep independent memory snapshots", async () => {
  now();
  const f = fixture();
  const a = await f.prompt("a");
  f.state.memory = "new facts";
  const b = await f.prompt("b");
  expect(b.userInfo).toContain("new facts");
  expect((await f.prompt("a")).userInfo).toBe(a.userInfo);
  f.recent.push({ id: "new", name: "New Bot" });
  f.state.epoch++;
  setSystemTime(new Date("2026-11-14T12:00:00Z"));
  const c = await f.prompt("a");
  expect(c.userInfoEpoch).toBe(1);
  expect(c.userInfo).toContain("New Bot");
  expect(c.userInfo).toContain("Saturday Nov 14");
});

test("the platform renderer trusts skillRender; the final prefix needs protection from same-epoch skill changes too", async () => {
  now();
  const f = fixture();
  const a = await f.prompt();
  f.state.skills = "changed installed skills";
  const b = await f.prompt();
  expect(b.userInfoEpoch).toBe(a.userInfoEpoch);
  expect(b.userInfo).not.toBe(a.userInfo);
  expect(b.instructions).toBe(a.instructions);
});

test("tool catalog pin persists through real Pi session reopen and refreshes on a new epoch", async () => {
  const root = await directory();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions);
  const initial = [{ name: "cursor", tools: [{ name: "Read" }] }];
  const changed = [
    { name: "cursor", tools: [{ name: "Read" }, { name: "Shell" }] },
    { name: "gmail", tools: [{ name: "Search" }] },
  ];
  const a = pinDynamicToolCatalog(manager, 0, initial);
  manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "one" }],
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
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
  const path = manager.getSessionFile()!;
  const reopened = SessionManager.open(path, sessions, root);
  const b = pinDynamicToolCatalog(reopened, 0, changed);
  expect(b.catalog).toBe(a.catalog);
  expect(b.update).toContain("user_info_catalog_update");
  const again = SessionManager.open(path, sessions, root);
  expect(pinDynamicToolCatalog(again, 0, changed).update).toBeNull();
  expect(pinDynamicToolCatalog(again, 1, changed).catalog).toBe(renderDynamicToolCatalog(changed));
});

// Enter through ComputerRuntime.run, including the production snapshot wiring.
// Construct a fresh runtime on every turn to rule out an in-memory-only fix.
const scenarios: Array<[string, (f: ReturnType<typeof fixture>) => void, boolean]> = [
  ["unchanged", () => {}, false],
  ...cases.map(([name, mutate]) => [name, mutate, true] as [string, typeof mutate, boolean]),
  ["local midnight", () => setSystemTime(new Date("2026-11-14T12:00:00Z")), true],
  ["worker midnight", () => setSystemTime(new Date("2026-11-14T12:00:00Z")), true],
  ["query reorder", (f) => f.recent.reverse(), false],
  ["epoch metadata only", (f) => f.state.epoch++, false],
  ["installed skills", (f) => (f.state.skills = "new installed skills"), true],
  ["missing session path", () => {}, false],
  ["revert roster", (f) => f.recent.push({ id: "temporary", name: "Temporary Teammate" }), true],
  ["catalog and roster", (f) => f.recent.push({ id: "new", name: "New Teammate" }), true],
  ["failed update append", (f) => (f.state.skills = "new installed skills"), true],
  [
    "new epoch refresh",
    (f) => {
      f.state.epoch++;
      f.state.skills = "post-summary skills";
    },
    false,
  ],
  [
    "worker compaction refresh",
    (f) => {
      f.state.epoch++;
      f.state.skills = "post-summary skills";
    },
    false,
  ],
];
for (const [change, mutate, hasUpdate] of scenarios)
  test(`fixed provider prefix across cold runtime restarts: ${change}`, async () => {
    now();
    const f = fixture();
    const root = await directory();
    const requests: any[] = [];
    const model: any = {
      id: "openai/prefix-fixture",
      name: "Prefix fixture",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://offline.invalid/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const provider = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (_model, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "synthetic",
        maxRetries: 0,
        fetch: (async (_url: unknown, init: RequestInit) => {
          requests.push(JSON.parse(await new Response(init.body).text()));
          return new Response(
            `data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "Status: done\nFixture complete." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch,
      });
    const contextSessionId = crypto.randomUUID();
    let sessionPath: string | null = null;
    for (let turn = 0; turn < 4; turn++) {
      if (turn === 3 && change === "revert roster") f.recent.pop();
      if (turn === 2) {
        mutate(f);
        f.restart();
        if (change === "worker compaction refresh") {
          // Commit an actual durable archive, rather than only changing the
          // request's epoch. Worker requests intentionally omit that field.
          const manager = SessionManager.open(sessionPath!, join(root, "sessions"), root);
          const history = manager.buildSessionContext().messages;
          await new BotCompactionArchiveStore(join(root, "archive")).commit(contextSessionId, {
            id: crypto.randomUUID(),
            reason: "self_summary_completed",
            summary: "Reply to turn 1. is complete; continue the same task.",
            prefixDigest: botMessageDigest(history as any),
            piBaseMessageCount: history.length,
            piBoundary: { leafId: manager.getLeafId()!, compactionEntryId: null },
            userInfoMessage: null,
            lastUserMessage: { role: "user", content: "Continue the task" },
            preservedTailMessages: [],
            tokensBefore: 90000,
            tokensAfter: 1000,
            imageCount: 0,
            turnCount: 2,
            usage: null,
            startedAt: new Date(1).toISOString(),
            completedAt: new Date(2).toISOString(),
          });
        }
      }
      const prompt = await f.prompt();
      const runtime = new ComputerRuntime() as any;
      runtime.start = async () => {};
      runtime.diskPressure =
        runtime.installNotice =
        runtime.processNotice =
          { claim: async () => null };
      runtime.agentDir = root;
      runtime.sessionsDir = join(root, "sessions");
      runtime.contextSessionsDir = join(root, "archive");
      runtime.modelRuntime = provider;
      runtime.resolveModel = () => model;
      runtime.compactionArchive = new BotCompactionArchiveStore(runtime.contextSessionsDir);
      runtime.compaction = new BotCompactionCoordinator(runtime.compactionArchive, 0);
      runtime.tools = {
        customTools: () => [],
        contextCatalog: () =>
          change === "catalog and roster"
            ? [{ name: "cursor", tools: [{ name: turn >= 2 ? "NewTool" : "OldTool" }] }]
            : [],
        recoverFormOutcomes: async () => {},
        messagesAvailable: async () => false,
        acknowledgeToolOutcomes: async () => {},
        cancelApprovals() {},
        userForms: { beginTurn: async () => {}, endTurn: async () => {} },
      };
      if (change === "failed update append" && turn === 2) {
        const createSession = runtime.createSession.bind(runtime);
        runtime.createSession = async (...args: any[]) => {
          const session = await createSession(...args);
          const sendCustomMessage = session.sendCustomMessage.bind(session);
          session.sendCustomMessage = (message: any, options: any) => {
            if (message.customType === "openteam-user-info-update")
              throw new Error("Injected append failure");
            return sendCustomMessage(message, options);
          };
          return session;
        };
      }
      const pending = runtime.run({
        runId: crypto.randomUUID(),
        botId: "main",
        contextSessionId,
        conversationId: crypto.randomUUID(),
        channelId: null,
        deliveryId: null,
        clientMessageId: crypto.randomUUID(),
        sessionPath: change === "missing session path" ? null : sessionPath,
        cwd: root,
        model: `${model.provider}/${model.id}`,
        reasoning: "off",
        content: `Reply to turn ${turn + 1}.`,
        instructions: prompt.instructions,
        userInfo: prompt.userInfo,
        userInfoEpoch: change.startsWith("worker ") ? undefined : prompt.userInfoEpoch,
        runtimeProfile: change.startsWith("worker ") ? "subagent" : "agent",
        subagentType: change.startsWith("worker ") ? "executor" : null,
        requestSource: "agent",
      });
      if (change === "failed update append" && turn === 2) {
        await expect(pending).rejects.toThrow("Injected append failure");
        continue;
      }
      const events: AsyncIterable<ComputerEvent> = await pending;
      let completed = false;
      for await (const event of events) {
        if (event.type === "session.attached") sessionPath = event.sessionPath;
        if (event.type === "turn.completed") {
          expect(event.status).toBe("completed");
          completed = true;
        }
      }
      expect(completed).toBe(true);
      expect(sessionPath).toBeString();
    }
    expect(requests).toHaveLength(change === "failed update append" ? 3 : 4);
    for (let i = 1; i < requests.length; i++) {
      // This assertion covers the *entire* earlier model request, including the
      // opening user_info, assistant output and all previously appended notes.
      if ((change === "new epoch refresh" || change === "worker compaction refresh") && i === 2) {
        expect(requests[i].messages[1]).not.toEqual(requests[i - 1].messages[1]);
        expect(JSON.stringify(requests[i].messages[1])).toContain("post-summary skills");
      } else {
        expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(
          requests[i - 1].messages
        );
      }
      expect(requests[i].tools).toEqual(requests[0].tools);
    }
    const last = requests.at(-1);
    const updates = last.messages.filter((message: any) =>
      JSON.stringify(message).includes("user_info memory_context available_subagent_types")
    );
    expect(updates).toHaveLength(change === "revert roster" ? 2 : hasUpdate ? 1 : 0);
    if (hasUpdate) {
      const text =
        typeof updates.at(-1).content === "string"
          ? updates.at(-1).content
          : updates
              .at(-1)
              .content.map((part: any) => part.text ?? "")
              .join("");
      const current = await f.prompt();
      expect(text).toContain(current.userInfo!.match(/^Today's date:.+$/m)![0]);
      for (const section of ["memory_context", "teammates", "agent_skills"]) {
        const block = current.userInfo!.match(
          new RegExp(`<${section}>[\\s\\S]*?</${section}>`)
        )?.[0];
        if (block) expect(text).toContain(block);
        else expect(text).not.toContain(`<${section}>`);
      }
      expect(text).not.toContain("<dynamic_tool_catalog>");
      expect(JSON.stringify(last.messages[1])).not.toContain("new installed skills");
    }
    if (change === "catalog and roster") {
      expect(
        last.messages.filter((message: any) =>
          JSON.stringify(message).includes('sections=\\"dynamic_tool_snapshot')
        )
      ).toHaveLength(1);
      expect(JSON.stringify(last.messages[1])).toContain("OldTool");
      expect(JSON.stringify(last.messages.slice(2))).toContain("NewTool");
    }
    expect(JSON.stringify(last)).toContain("Reply to turn 1.");
    expect(JSON.stringify(last)).toContain("Reply to turn 4.");
  });
