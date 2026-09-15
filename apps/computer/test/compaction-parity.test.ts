import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  BotNoSummaryResponseError,
  botSummaryResponse,
  type BotMessage,
  type BotObservation,
  botBackgroundThreshold,
  botPersistThreshold,
  botSummaryRetryDirective,
  botDurableBlocks,
  botSummaryMessage,
  botSummaryText,
  shouldPersistBotSummary,
  isValidBotEarlyThreshold,
  partitionForBotSummary,
  reduceBotSummaryInputMessages,
  shouldWaitForBotSummary,
  estimateBotContextTokens,
} from "../src/bot-compaction";

const roots: string[] = [];
const coordinators: { coordinator: BotCompactionCoordinator; contextSessionId: string }[] = [];
afterEach(async () => {
  for (const { coordinator, contextSessionId } of coordinators.splice(0))
    coordinator.discardBackground(contextSessionId);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const text = (role: string, content: string): BotMessage => ({ role, content });
const history = () => [
  text("user", "Build red"),
  text("assistant", "Built red"),
  text("user", "Correction: keep blue"),
  text("assistant", "Inspected blue"),
];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "compaction-parity-"));
  roots.push(root);
  const store = new BotCompactionArchiveStore(root);
  const coordinator = new BotCompactionCoordinator(store, 0);
  const observation: BotObservation = {
    contextSessionId: crypto.randomUUID(),
    piMessages: history(),
    systemPrompt: "System fixture",
    usedTokens: 91_000,
    maxTokens: 100_000,
    modelKey: "fixture/model",
    infer: async () => ({ text: "Keep blue; red work is obsolete." }),
  };
  coordinators.push({ coordinator, contextSessionId: observation.contextSessionId });
  return { store, coordinator, observation };
};

test("launch uses the self-summary floor without changing the background persistence gate", async () => {
  const { coordinator, observation, store } = await setup();
  let calls = 0;
  const input = {
    ...observation,
    maxTokens: 100_003,
    usedTokens: 90_001,
    infer: async () => {
      calls++;
      return { text: "Keep blue" };
    },
  };
  await coordinator.observe(input);
  expect(calls).toBe(0);
  input.usedTokens = 90_002;
  await coordinator.observe(input);
  await settle();
  expect(calls).toBe(1);
  await coordinator.modelContextMessages(input);
  expect((await store.manifest(input.contextSessionId)).epoch).toBe(0);
  input.usedTokens = 90_003;
  await coordinator.modelContextMessages(input);
  expect((await store.manifest(input.contextSessionId)).epoch).toBe(1);
});

test("generation sees the latest correction and skips old summary carriers when preserving a request", () => {
  const messages = [
    ...history(),
    { ...text("user", "OLD SUMMARY"), providerOptions: { cursor: { isSummary: true } } },
  ];
  messages.splice(1, 0, text("assistant", ""));
  const partition = partitionForBotSummary(messages)!;
  expect(partition.lastUserMessage.content).toBe("Correction: keep blue");
  expect(partition.messagesToSummarize).toContainEqual(partition.lastUserMessage);
  expect(partition.messagesToSummarize).not.toContainEqual(text("assistant", ""));
  expect(partition.messagesToSummarize.at(-1)).toEqual(messages.at(-1)!);
  expect(partitionForBotSummary([text("user", "goal"), text("assistant", "work")])).not.toBeNull();
});

test("all attached skills survive alongside supported deterministic context", () => {
  const blocks = botDurableBlocks(
    text(
      "user",
      "<manually_attached_skills>A</manually_attached_skills>\n<manually_attached_skills>B</manually_attached_skills>"
    ),
    {
      isRootProject: true,
      projectRoot: "/project",
      transcriptPath: "/transcript",
      todoUpdate: "Check blue",
      automationTrigger: "<automation_trigger>fixture</automation_trigger>",
    }
  );
  expect(blocks).toHaveLength(6);
  expect(blocks[0]).toContain("Project root:");
  expect(blocks.at(-2)).toContain(">A<");
  expect(blocks.at(-1)).toContain(">B<");
});

test("early thresholds lower both boundaries only when valid", () => {
  expect(botBackgroundThreshold(200_000, 60_000)).toBe(60_000);
  expect(botPersistThreshold(200_000, 60_000)).toBe(60_000);
  expect(botBackgroundThreshold(200_000, 195_000)).toBe(180_000);
  for (const value of [0, -1, 200_000, 200_001, 1.5, NaN, Infinity, "60000", undefined]) {
    expect(isValidBotEarlyThreshold(value, 200_000)).toBe(false);
    expect(botBackgroundThreshold(200_000, value as number)).toBe(180_000);
  }
});

test("fractional persist boundaries retain the reference arithmetic", () => {
  expect(shouldPersistBotSummary(95_000.95, 100_001)).toBe(false);
  expect(shouldPersistBotSummary(95_001, 100_001)).toBe(true);
});

test("summary text joins nonempty prose parts and strips only closed legacy thinking tags", () => {
  expect(
    botSummaryText([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "<think>old reasoning</think>First" },
      { type: "text", text: "" },
      { type: "text", text: "Second" },
      { type: "toolCall", name: "Read", id: "never-executed" },
    ])
  ).toBe("First\nSecond");
  expect(botSummaryText("<think>unclosed")).toBe("<think>unclosed");
  expect(botSummaryText("<think>a</think><think>b</think>")).toBe("");
});

test("only zero-length assistant envelopes are removed, including signed or whitespace content", () => {
  const retained: BotMessage[] = [
    text("assistant", " \n"),
    { role: "assistant", content: [{ type: "text", text: "" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "signed" }] },
  ];
  const partition = partitionForBotSummary([
    text("user", "goal"),
    text("assistant", ""),
    { role: "assistant", content: [] },
    ...retained,
  ])!;
  expect(partition.messagesToSummarize).toEqual([text("user", "goal"), ...retained]);
});

test("skill extraction matches exact tags within each user text segment", () => {
  const block = "<manually_attached_skills>A</manually_attached_skills>";
  expect(
    botDurableBlocks(
      {
        role: "user",
        content: [
          { type: "text", text: "<manually_attached_skills>split" },
          { type: "text", text: "across parts</manually_attached_skills>" },
          { type: "text", text: block },
          { type: "text", text: block.toUpperCase() },
          { type: "text", text: block.replace("skills>", 'skills name="x">') },
        ],
      },
      {}
    )
  ).toEqual([block]);
  expect(botDurableBlocks(text("assistant", block), {})).toEqual([]);
});

test("the generic summary carrier preserves raw text and exact reference delimiters", () => {
  const message = botSummaryMessage(
    " \nKeep blue.\n ",
    2,
    0,
    botDurableBlocks(text("user", "goal"), {
      todoUpdate: "Check <blue>",
      automationTrigger: "clock",
    })
  );
  expect((message.content as { text: string }[])[0]!.text).toBe(
    "\n\nYour conversation was summarized due to context constraints. Here is the summary of the conversation so far:\n\n" +
      "<summary_content>\n \nKeep blue.\n \n</summary_content>\n\n" +
      "NOTE: There was an active todo list in the conversation. Here is the latest update before summarization:\n" +
      "<todo_update>\nCheck <blue>\n</todo_update>\n\n" +
      "NOTE: This is an automation run. The original trigger info that started this session:\nclock\n\n" +
      "Total summaries generated so far for this user query: 2\n\n" +
      "If the task is complete, respond to the user. Otherwise, continue working on the task."
  );
});

test("resource exhaustion caused by malformed input is terminal", () => {
  for (const message of ["request is not valid json", "invalid json", "invalid argument: shape"]) {
    expect(botSummaryRetryDirective(Object.assign(new Error(message), { code: 8 }))).toEqual({
      retry: false,
      delay: false,
      reduceInputs: false,
      shorter: false,
    });
  }
});

test("parked adoption retains the provider threshold captured at generation start", async () => {
  const { coordinator, observation, store } = await setup();
  await coordinator.observe({ ...observation, usedTokens: 60_000, earlyThreshold: 60_000 });
  await settle();
  coordinator.parkBackground(observation.contextSessionId);
  await coordinator.beginUserQuery(observation.contextSessionId);
  await coordinator.modelContextMessages({ ...observation, usedTokens: 1_000 });
  expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
});

test("claiming an unfinished parked generation restores the current-pressure gate", async () => {
  const { coordinator, observation, store } = await setup();
  const result = deferred<{ text: string }>();
  await coordinator.observe({ ...observation, infer: () => result.promise });
  coordinator.parkBackground(observation.contextSessionId);
  await coordinator.beginUserQuery(observation.contextSessionId);
  result.resolve({ text: "Ready" });
  await settle();
  expect(await coordinator.modelContextMessages({ ...observation, usedTokens: 1_000 })).toEqual([
    ...observation.piMessages,
  ]);
  expect((await store.manifest(observation.contextSessionId)).epoch).toBe(0);
});

test("model, reasoning, window and tool changes reuse an unchanged prefix and freeze retry schemas", async () => {
  const { coordinator, observation, store } = await setup();
  const result = deferred<{ text: string }>();
  const requests: any[] = [];
  const tools = [{ name: "Read", description: "Read files", parameters: {} }];
  await coordinator.observe({
    ...observation,
    tools,
    infer: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        await result.promise;
        throw Object.assign(new Error("input too long"), { name: "InputTokenLimitError" });
      }
      return { text: "  Ready\n" };
    },
  });
  tools[0]!.name = "Changed";
  const next = {
    ...observation,
    modelKey: "new/model/reasoning/tools",
    maxTokens: 200_000,
    tools: [{ name: "New", description: "Discovered", parameters: {} }],
  };
  await coordinator.observe(next);
  result.resolve({ text: "release" });
  await settle();
  await settle();
  coordinator.parkBackground(observation.contextSessionId);
  await coordinator.modelContextMessages(next);
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.tools[0].name)).toEqual(["Read", "Read"]);
  expect((await store.latest(observation.contextSessionId))?.summary).toBe("  Ready\n");
});

test("effective request estimates include tools and system text without counting encoded images as text", () => {
  const image = (data: string): BotMessage[] => [
    { role: "user", content: [{ type: "image", data }] },
  ];
  const tokens = estimateBotContextTokens("", image("tiny"));
  expect(estimateBotContextTokens("", image("a".repeat(1_000_000)))).toBe(tokens);
  expect(estimateBotContextTokens("x".repeat(4_000), image("tiny"))).toBe(tokens + 1_000);
  expect(
    estimateBotContextTokens("", image("tiny"), [{ description: "x".repeat(4_000) }])
  ).toBeGreaterThan(tokens + 1_000);
});

test("ordinary four-message retry inputs reduce progressively", () => {
  const first = reduceBotSummaryInputMessages(history());
  expect(first).toEqual(history().slice(2));
  const second = reduceBotSummaryInputMessages(first);
  expect(second).toEqual(history().slice(3));
  expect(reduceBotSummaryInputMessages([text("user", "abcdefgh")])[0]?.content).toBe("efgh");
  expect(
    reduceBotSummaryInputMessages([
      { role: "user", content: [{ type: "text", text: "abcdefgh" }] },
    ])[0]?.content
  ).toEqual([{ type: "text", text: "abcdefgh" }]);
});

test("explicit short-history compaction rejects before inference or archive writes", async () => {
  const { coordinator, observation, store } = await setup();
  for (const piMessages of [[], [{ role: "user", content: "abcdefgh" }]]) {
    let calls = 0;
    await expect(
      coordinator.beforePiCompaction({
        ...observation,
        piMessages,
        reason: "manual",
        firstKeptEntryId: "fixture",
        tokensBefore: 90_000,
        signal: new AbortController().signal,
        infer: async () => {
          calls++;
          return { text: "must not run" };
        },
      })
    ).rejects.toThrow(`Self-summary requires at least 3 messages, got ${piMessages.length + 1}`);
    expect(calls).toBe(0);
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(0);
    expect(await store.stagedId(observation.contextSessionId)).toBeNull();
  }
});

test("reported missing-assistant usage is counted while provider-error usage is excluded", async () => {
  const { coordinator, observation } = await setup();
  let calls = 0;
  const usage = { input: 100, output: 10, reasoning: 4, totalTokens: 110 };
  const prepared = await coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    firstKeptEntryId: "fixture",
    tokensBefore: 90_000,
    signal: new AbortController().signal,
    infer: async () => {
      calls++;
      if (calls === 1) return botSummaryResponse({ messages: [], usage });
      if (calls === 2)
        return botSummaryResponse({ messages: [], usage, error: new Error("Transient fixture") });
      return botSummaryResponse({ messages: [{ role: "assistant", content: "Keep blue" }], usage });
    },
  });
  expect(calls).toBe(3);
  expect(prepared?.usage).toEqual({ input: 200, output: 20, reasoning: 8, totalTokens: 220 });
  expect(() =>
    botSummaryResponse({ messages: [{ role: "user", content: "Wrong role" }], usage })
  ).toThrow(BotNoSummaryResponseError);
});

test("three empty completions preserve the reference exhaustion error", async () => {
  const { coordinator, observation } = await setup();
  let calls = 0;
  await expect(
    coordinator.beforePiCompaction({
      ...observation,
      reason: "manual",
      firstKeptEntryId: "fixture",
      tokensBefore: 90_000,
      signal: new AbortController().signal,
      infer: async () => {
        calls++;
        return { text: "" };
      },
    })
  ).rejects.toThrow("[self-summary] all retries exhausted without valid content");
  expect(calls).toBe(3);
});

test("tool-heavy reduction drops tool exchanges at the quarter boundary", () => {
  const messages = [
    text("user", "goal"),
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "Read" }] },
    { role: "toolResult", toolCallId: "a", content: "huge result" },
    text("user", "latest"),
  ];
  expect(reduceBotSummaryInputMessages(messages)).toEqual([messages[0]!, messages[3]!]);
});

test("structured and nested failures select their intended retry paths", () => {
  expect(
    botSummaryRetryDirective({ cause: { code: 8, message: "text fields are too large" } })
  ).toMatchObject({ retry: true, reduceInputs: true, delay: false });
  expect(botSummaryRetryDirective({ cause: { code: 14 } })).toMatchObject({
    retry: true,
    delay: true,
  });
  expect(botSummaryRetryDirective({ cause: { status: 401 } }).retry).toBe(false);
  expect(botSummaryRetryDirective(new Error("context_length_exceeded"))).toMatchObject({
    retry: true,
    reduceInputs: true,
  });
  expect(
    botSummaryRetryDirective(
      Object.assign(new Error("No response"), { name: "NoSummaryResponseError" })
    ).retry
  ).toBe(false);
});

test("the generic caller retries missing assistant responses with the active factory default", async () => {
  const { coordinator, observation } = await setup();
  let calls = 0;
  const result = await coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    firstKeptEntryId: "last",
    tokensBefore: 91_000,
    signal: new AbortController().signal,
    infer: async () => {
      if (++calls === 1)
        throw Object.assign(new Error("No assistant response received"), {
          name: "NoSummaryResponseError",
        });
      return { text: "Ready" };
    },
  });
  expect(calls).toBe(2);
  expect(result?.summary).toBe("Ready");
});

test("successful empty attempts contribute to total summary usage and cost", async () => {
  const { coordinator, observation } = await setup();
  let calls = 0;
  const result = await coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    firstKeptEntryId: "last",
    tokensBefore: 91_000,
    signal: new AbortController().signal,
    infer: async () => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("provider failure"), { name: "Unavailable" });
      return {
        text: calls === 1 ? "" : "Ready",
        usage: {
          input: 100,
          output: 10,
          cacheRead: 20,
          cacheWrite: 5,
          totalTokens: 135,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
      };
    },
  });
  expect(calls).toBe(3);
  expect(result?.usage).toEqual({
    input: 200,
    output: 20,
    cacheRead: 40,
    cacheWrite: 10,
    totalTokens: 270,
    cost: { input: 0.2, output: 0.4, cacheRead: 0.02, cacheWrite: 0.04, total: 0.66 },
  });
});

test("an unfinished summary survives a turn and is adopted once with the appended request", async () => {
  const { coordinator, store, observation } = await setup();
  const result = deferred<{ text: string }>();
  let signal!: AbortSignal;
  let calls = 0;
  observation.infer = (_request, capturedSignal) => {
    calls++;
    signal = capturedSignal;
    return result.promise;
  };
  await coordinator.observe(observation);
  coordinator.parkBackground(observation.contextSessionId);
  expect(signal.aborted).toBe(false);
  await coordinator.beginUserQuery(observation.contextSessionId);
  const next = {
    ...observation,
    piMessages: [...observation.piMessages, text("user", "Also keep the tests")],
  };
  await coordinator.observe(next);
  expect(calls).toBe(1);
  result.resolve({ text: "Blue version is current" });
  await settle();
  const projected = await coordinator.modelContextMessages(next);
  expect(projected.at(-1)).toEqual(next.piMessages.at(-1)!);
  expect(projected.filter((message) => message.content === "Correction: keep blue")).toHaveLength(
    1
  );
  expect((await store.manifest(observation.contextSessionId)).archives[0]?.reason).toBe(
    "approaching_token_limit"
  );
  expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
  expect(await coordinator.modelContextMessages(next)).toEqual(projected);
  expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
});

test("a completed parked summary uses its capture pressure when the next turn is below the trigger", async () => {
  const { coordinator, observation, store } = await setup();
  await coordinator.observe(observation);
  await settle();
  coordinator.parkBackground(observation.contextSessionId);
  await coordinator.beginUserQuery(observation.contextSessionId);
  expect(
    JSON.stringify(await coordinator.modelContextMessages({ ...observation, usedTokens: 80_000 }))
  ).toContain("summary_content");
  expect((await store.latest(observation.contextSessionId))?.reason).toBe(
    "pending_summary_adopted"
  );
});

test("a parked candidate with a changed system or message prefix is never adopted", async () => {
  for (const change of [
    { systemPrompt: "Changed authority" },
    { piMessages: [text("user", "changed"), ...history().slice(1)] },
  ]) {
    const { coordinator, store, observation } = await setup();
    await coordinator.observe(observation);
    await settle();
    coordinator.parkBackground(observation.contextSessionId);
    const next = { ...observation, ...change };
    expect(await coordinator.modelContextMessages(next)).toEqual([...next.piMessages]);
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(0);
  }
});

test("ordinary end-of-turn pressure defers in-flight work and adopts a completed result", async () => {
  const { coordinator, observation } = await setup();
  const result = deferred<{ text: string }>();
  observation.usedTokens = 96_000;
  observation.infer = () => result.promise;
  expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(false);
  expect(
    await coordinator.beforePiCompaction({
      ...observation,
      reason: "threshold",
      tokensBefore: 96_000,
      firstKeptEntryId: "last",
      signal: new AbortController().signal,
    })
  ).toBeNull();
  result.resolve({ text: "Ready" });
  await settle();
  expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(true);
});

test("image pressure and extreme overage have independent blocking boundaries", () => {
  expect(shouldWaitForBotSummary(96_000, 100_000, 84)).toBe(false);
  expect(shouldWaitForBotSummary(10, 100_000, 85)).toBe(true);
  expect(shouldWaitForBotSummary(125_000, 100_000, 0)).toBe(false);
  expect(shouldWaitForBotSummary(125_001, 100_000, 0)).toBe(true);
  expect(shouldWaitForBotSummary(1_050_000, 1_000_000, 0)).toBe(false);
  expect(shouldWaitForBotSummary(1_050_001, 1_000_000, 0)).toBe(true);
});

test("a reported early threshold can start and persist below ordinary headroom", async () => {
  const { coordinator, observation } = await setup();
  observation.usedTokens = 60_000;
  observation.earlyThreshold = 60_000;
  await coordinator.observe(observation);
  await settle();
  expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(true);
  expect(JSON.stringify(await coordinator.modelContextMessages(observation))).toContain(
    "summary_content"
  );
});

test("projected adoption invalidates raw usage until a new provider response arrives", async () => {
  const { coordinator, observation, store } = await setup();
  let calls = 0;
  observation.piMessages = [
    ...history(),
    {
      ...text("assistant", "old response"),
      usage: { input: 91_000, output: 100 },
      stopReason: "stop",
    },
  ];
  observation.infer = async () => ({ text: `Summary ${++calls}` });
  await coordinator.observe(observation);
  await settle();
  await coordinator.modelContextMessages(observation);
  await coordinator.observe(observation);
  expect(calls).toBe(1);
  expect(await coordinator.shouldCompactAtTurnEnd({ ...observation, usedTokens: 96_000 })).toBe(
    false
  );
  expect(
    await coordinator.beforePiCompaction({
      ...observation,
      reason: "overflow",
      tokensBefore: 96_000,
      firstKeptEntryId: "last",
      signal: new AbortController().signal,
    })
  ).toBeNull();
  expect((await store.latest(observation.contextSessionId))!.tokensAfter).toBeLessThan(1_000);
  observation.piMessages = [
    ...observation.piMessages,
    {
      ...text("assistant", "new response"),
      usage: { input: 91_000, output: 100 },
      stopReason: "stop",
    },
  ];
  await coordinator.observe(observation);
  expect(calls).toBe(2);
});

test("input-limit failures suppress automatic relaunch at the same or greater pressure", async () => {
  const { coordinator, observation } = await setup();
  let calls = 0;
  observation.infer = async () => {
    calls++;
    throw new Error("context_length_exceeded");
  };
  await coordinator.observe(observation);
  await settle();
  expect(calls).toBe(3);
  await coordinator.observe(observation);
  await coordinator.observe({ ...observation, usedTokens: 95_000 });
  expect(calls).toBe(3);
  await coordinator.observe({ ...observation, modelKey: "another/model" });
  await settle();
  expect(calls).toBe(6);
});

test("output-limit retries shrink progressively and retain their instruction after empty output", async () => {
  const { coordinator, observation } = await setup();
  const inputs: { count: number; shorter: boolean }[] = [];
  const prepared = await coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    tokensBefore: 96_000,
    firstKeptEntryId: "last",
    signal: new AbortController().signal,
    infer: async (request) => {
      inputs.push({ count: request.messagesToSummarize.length, shorter: request.shorter });
      if (inputs.length === 1)
        throw Object.assign(new Error("output limit"), { name: "OutputTokensLimitExceededError" });
      return { text: inputs.length === 2 ? "" : "Ready" };
    },
  });
  expect(prepared?.summary).toBe("Ready");
  expect(inputs).toEqual([
    { count: 4, shorter: false },
    { count: 2, shorter: true },
    { count: 2, shorter: true },
  ]);
});

test("a blocking adoption wait respects cancellation even for an existing background request", async () => {
  const { coordinator, observation } = await setup();
  const result = deferred<{ text: string }>();
  observation.infer = () => result.promise;
  await coordinator.observe(observation);
  const controller = new AbortController();
  const preparing = coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    tokensBefore: 96_000,
    firstKeptEntryId: "last",
    signal: controller.signal,
  });
  controller.abort();
  await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
});

test("consecutive input-limit failures reduce the actual generation request on every retry", async () => {
  const { coordinator, observation } = await setup();
  const sizes: number[] = [];
  await coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    tokensBefore: 96_000,
    firstKeptEntryId: "last",
    signal: new AbortController().signal,
    infer: async (request) => {
      sizes.push(request.messagesToSummarize.length);
      if (sizes.length < 3) throw new Error("context_length_exceeded");
      return { text: "Ready" };
    },
  });
  expect(sizes).toEqual([4, 2, 1]);
});

for (const changedPrefix of [false, true]) {
  test(`blocking generation revalidates the live transcript after ${changedPrefix ? "a prefix change" : "an appended message"}`, async () => {
    const { coordinator, store, observation } = await setup();
    const started = deferred<void>();
    const result = deferred<{ text: string }>();
    let current = [...observation.piMessages];
    const preparing = coordinator.beforePiCompaction({
      ...observation,
      reason: "manual",
      tokensBefore: 96_000,
      firstKeptEntryId: "last",
      signal: new AbortController().signal,
      readPiMessages: () => current,
      infer: async () => {
        started.resolve();
        return result.promise;
      },
    });
    await started.promise;
    const arrival = text("user", "Background job finished while compacting");
    current = changedPrefix
      ? [text("user", "Changed prior instruction"), ...current.slice(1)]
      : [...current, arrival];
    result.resolve({ text: "Ready" });
    const prepared = await preparing;
    if (changedPrefix) {
      expect(prepared).toBeNull();
      expect(await store.stagedId(observation.contextSessionId)).toBeNull();
    } else {
      expect(prepared?.retainedTail).toEqual([arrival]);
      await coordinator.afterPiCompaction({
        contextSessionId: observation.contextSessionId,
        piBaseMessageCount: current.length,
      });
      const projected = await coordinator.contextMessages(observation.contextSessionId, current);
      expect(projected.filter((message) => message.content === arrival.content)).toHaveLength(1);
    }
  });
}

test("deleting a context cancels a blocking summary and cannot resurrect its archive", async () => {
  const { coordinator, store, observation } = await setup();
  const started = deferred<void>();
  const result = deferred<{ text: string }>();
  let signal!: AbortSignal;
  const preparing = coordinator.beforePiCompaction({
    ...observation,
    reason: "manual",
    tokensBefore: 96_000,
    firstKeptEntryId: "last",
    signal: new AbortController().signal,
    infer: async (_request, currentSignal) => {
      signal = currentSignal;
      started.resolve();
      return result.promise;
    },
  });
  const failed = preparing.then(
    () => null,
    (error: unknown) => error
  );
  await started.promise;
  await coordinator.remove(observation.contextSessionId);
  expect(signal.aborted).toBe(true);
  expect(await failed).toMatchObject({ name: "AbortError" });
  result.resolve({ text: "Late result from an uncooperative provider" });
  await settle();
  expect((await store.manifest(observation.contextSessionId)).epoch).toBe(0);
});
