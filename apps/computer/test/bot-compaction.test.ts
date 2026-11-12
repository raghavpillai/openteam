import type { BotSummaryRequest } from "../src/bot-compaction";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { closeBotPreservedTail, BotCompactionArchiveStore, BotCompactionCoordinator, type BotMessage, type BotObservation, botDurableBlocks, TRANSCRIPT_LOCATION, botBackgroundThreshold, botMessageDigest, botPersistThreshold, botPiPersistReserve, botSummaryPrompt, botSummaryRetryDirective, partitionForBotSummary, reduceBotSummaryInputMessages, shouldPersistBotSummary, shouldStartBotSummary, stripEmptyTrailingAssistantMessages } from "../src/bot-compaction";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const workspace = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "openteam-bot-compaction-"));
  directories.push(path);
  return path;
};

const text = (role: string, value: string, options?: Record<string, unknown>): BotMessage => ({
  role,
  content: [{ type: "text", text: value }],
  ...(options ? { providerOptions: { cursor: options } } : {}),
});

describe("Bot trigger thresholds", () => {
  test("starts and adopts once 10,000 tokens or 10% of the window remain, including Pi's strict boundary", () => {
    for (const [window, boundary] of [
      [12_000, 2_000],
      [32_768, 22_768],
      [64_000, 54_000],
      [100_000, 90_000],
      [100_003, 90_003],
      [128_000, 115_200],
      [256_000, 230_400],
      [272_000, 244_800],
      [922_000, 829_800],
      [1_000_000, 900_000],
    ] as const) {
      expect(botBackgroundThreshold(window)).toBe(boundary);
      expect(botPersistThreshold(window)).toBe(boundary);
      expect(shouldStartBotSummary(boundary - 1, window)).toBe(false);
      expect(shouldStartBotSummary(boundary, window)).toBe(true);
      expect(shouldPersistBotSummary(boundary - 1, window)).toBe(false);
      expect(shouldPersistBotSummary(boundary, window)).toBe(true);
      const piBoundary = window - botPiPersistReserve(window);
      expect(boundary - 1 > piBoundary).toBe(false);
      expect(boundary > piBoundary).toBe(true);
    }
    for (const window of [0, -1, NaN, Infinity]) {
      expect(shouldStartBotSummary(100, window)).toBe(false);
      expect(shouldPersistBotSummary(100, window)).toBe(false);
    }
    for (const usage of [NaN, Infinity, -1]) {
      expect(shouldStartBotSummary(usage, 100_000)).toBe(false);
    }
  });

});

describe("Bot summary partition", () => {
  test("drops empty assistant envelopes before summarization", () => {
    const messages = [
      text("user", "goal"),
      text("assistant", "working"),
      text("user", "continue"),
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "context_length_exceeded",
      },
    ] as BotMessage[];
    expect(stripEmptyTrailingAssistantMessages(messages)).toEqual(messages.slice(0, -1));
    expect(partitionForBotSummary(messages)?.lastUserMessage).toEqual(text("user", "continue"));
  });

  test("peels a leading user-info pair and preserves SelfSummarizer's last user", () => {
    const userInfo = text("user", "<user_info>current identity</user_info>", { isUserInfo: true });
    const priorSummary = text("user", "prior summary", { isSummary: true });
    const lastUser = text("user", "finish the implementation");
    const partition = partitionForBotSummary([
      userInfo,
      text("user", "original request"),
      text("assistant", "work one"),
      priorSummary,
      lastUser,
      text("assistant", "work two"),
    ]);
    expect(partition?.userInfoMessage).toEqual(userInfo);
    expect(partition?.lastUserMessage).toEqual(lastUser);
    expect(partition?.messagesToSummarize).toContainEqual(priorSummary);
    expect(partition?.messagesToSummarize).toContainEqual(text("assistant", "work two"));
    if (!partition) throw new Error("Expected a summary partition");
    const prompt = botSummaryPrompt();
    expect(prompt).toContain("Please summarize the conversation so far.");
    expect(partition.messagesToSummarize).toContainEqual(lastUser);
    expect(prompt).not.toContain("system snapshot");
    expect(prompt).not.toContain("current identity");
    expect(prompt).not.toContain("finish the implementation");
  });

  test("matches Bot's summary retry classifier", () => {
    const named = (name: string, message = name): Error => {
      const error = new Error(message);
      error.name = name;
      return error;
    };
    expect(botSummaryRetryDirective(named("OutputTokensLimitExceededError"))).toEqual({
      retry: true,
      delay: true,
      reduceInputs: true,
      shorter: true,
    });
    expect(botSummaryRetryDirective(named("InputTokenLimitError"))).toEqual({
      retry: true,
      delay: false,
      reduceInputs: true,
      shorter: false,
    });
    expect(
      botSummaryRetryDirective(named("ResourceExhausted", "text fields are too large"))
    ).toEqual({
      retry: true,
      delay: false,
      reduceInputs: true,
      shorter: false,
    });
    expect(botSummaryRetryDirective(named("ResourceExhausted"))).toEqual({
      retry: true,
      delay: true,
      reduceInputs: false,
      shorter: false,
    });
    expect(
      botSummaryRetryDirective(
        named("InvalidArgument", "User API Key Rate limit exceeded for this request")
      )
    ).toEqual({ retry: true, delay: true, reduceInputs: false, shorter: false });
    expect(botSummaryRetryDirective(named("InvalidArgument"))).toEqual({
      retry: false,
      delay: false,
      reduceInputs: false,
      shorter: false,
    });
    expect(botSummaryRetryDirective(named("AbortError"))).toEqual({
      retry: false,
      delay: false,
      reduceInputs: false,
      shorter: false,
    });
    expect(botSummaryRetryDirective("not-an-error").retry).toBe(false);
    expect(botSummaryRetryDirective(new Error("uncategorized"))).toEqual({
      retry: true,
      delay: true,
      reduceInputs: false,
      shorter: false,
    });
  });

  test("retry reduction keeps the reference suffix even for a delayed tool result", () => {
    const call: BotMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }],
    };
    const result: BotMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "result" }],
    };
    const priorSummary = text("user", "prior summary", { isSummary: true });
    const reduced = reduceBotSummaryInputMessages([
      text("user", "goal"),
      text("assistant", "start"),
      text("user", "middle-1"),
      text("assistant", "middle-2"),
      call,
      text("user", "middle-3"),
      priorSummary,
      text("assistant", "middle-4"),
      result,
      text("user", "newest-1"),
      text("assistant", "newest-2"),
      text("user", "newest-3"),
    ]);
    expect(reduced).not.toContainEqual(call);
    expect(reduced).toContainEqual(result);
    expect(reduced).toContainEqual(priorSummary);
  });

});

describe("Bot overflow attempt budget", () => {
  test("allows five overflowing model calls for one step and never makes a sixth", async () => {
    const session = Object.create(AgentSession.prototype) as {
      _overflowRecoveryAttempts: number;
      settingsManager: { getCompactionSettings(): { enabled: boolean } };
      model: { provider: string; id: string; contextWindow: number; maxTokens: number };
      sessionManager: { getBranch(): [] };
      agent: { state: { messages: BotMessage[] } };
      _runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean>;
      _checkCompaction(message: BotMessage): Promise<boolean>;
    };
    session._overflowRecoveryAttempts = 0;
    session.settingsManager = { getCompactionSettings: () => ({ enabled: true }) };
    Object.defineProperty(session, "model", {
      configurable: true,
      value: {
        provider: "openai-codex",
        id: "gpt-test",
        contextWindow: 1_000,
        maxTokens: 100,
      },
    });
    session.sessionManager = { getBranch: () => [] };
    session.agent = { state: { messages: [] } };
    const retryFlags: boolean[] = [];
    session._runAutoCompaction = async (_reason, willRetry) => {
      retryFlags.push(willRetry);
      return willRetry;
    };

    const overflow = (timestamp: number) =>
      ({
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-test",
        content: [],
        stopReason: "error",
        errorMessage: "context_length_exceeded",
        timestamp,
      }) as BotMessage;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const message = overflow(attempt + 1);
      session.agent.state.messages = [message];
      expect(await session._checkCompaction(message)).toBe(true);
    }
    const fifth = overflow(5);
    session.agent.state.messages = [fifth];
    await expect(session._checkCompaction(fifth)).rejects.toThrow("summarization-retries");
    expect(retryFlags).toEqual([true, true, true, true, false]);
    expect(session._overflowRecoveryAttempts).toBe(5);
  });
});

describe("Bot preserved suffix", () => {
  test("moves a captured tool-call owner across the boundary with its appended result", () => {
    const call: BotMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "SendToUser", arguments: {} }],
    };
    const result: BotMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "delivered" }],
    };
    const completed = text("assistant", "done");
    expect(
      closeBotPreservedTail(3, [
        text("user", "goal"),
        text("assistant", "work"),
        call,
        result,
        completed,
      ])
    ).toEqual([call, result, completed]);
  });

  test("keeps sibling results when a multi-call assistant straddles the boundary", () => {
    const call: BotMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "one", arguments: {} },
        { type: "toolCall", id: "call-2", name: "two", arguments: {} },
      ],
    };
    const first: BotMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "one" }],
    };
    const second: BotMessage = {
      role: "toolResult",
      toolCallId: "call-2",
      content: [{ type: "text", text: "two" }],
    };
    expect(closeBotPreservedTail(3, [text("user", "goal"), call, first, second])).toEqual([
      call,
      first,
      second,
    ]);
  });
});

describe("restart-safe compaction archive", () => {
  test("retains the sealed failed assistant before the overflow retry", async () => {
    const root = await workspace();
    const contextSessionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(root);
    const lastUser = text("user", "retry this request");
    const nativeBase = [text("user", "native summary"), lastUser];
    await store.commit(contextSessionId, {
      id: crypto.randomUUID(),
      reason: "fallback_on_limit_error",
      summary: "state before overflow",
      prefixDigest: botMessageDigest([lastUser]),
      piBaseMessageCount: nativeBase.length,
      userInfoMessage: null,
      lastUserMessage: lastUser,
      preservedTailMessages: [],
      tokensBefore: 100_001,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 2,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });
    const failed = {
      ...text("assistant", "context limit"),
      stopReason: "error",
      errorMessage: "context_length_exceeded",
    };
    const recovered = text("assistant", "successful retry");
    const rebuilt = await store.contextMessages(contextSessionId, [
      ...nativeBase,
      failed,
      recovered,
    ]);
    expect(rebuilt).toContainEqual(failed);
    expect(rebuilt.at(-1)).toEqual(recovered);
  });

  test("keeps archive epoch monotonic but resets self-summary count per user query", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const contextSessionId = crypto.randomUUID();
    const commit = (label: string) =>
      store.commit(contextSessionId, {
        id: crypto.randomUUID(),
        reason: "approaching_token_limit",
        summary: label,
        prefixDigest: botMessageDigest([text("user", label)]),
        piBaseMessageCount: 1,
        userInfoMessage: null,
        lastUserMessage: text("user", label),
        preservedTailMessages: [],
        tokensBefore: 95_000,
        tokensAfter: 2_000,
        imageCount: 0,
        turnCount: 12,
        usage: null,
        startedAt: new Date(1).toISOString(),
        completedAt: new Date(2).toISOString(),
      });
    const first = await commit("first");
    const second = await commit("second");
    await store.beginUserQuery(contextSessionId);
    const third = await commit("third");
    expect(first.selfSummaryCount).toBe(1);
    expect(second.selfSummaryCount).toBe(2);
    expect(third.sequence).toBe(3);
    expect(third.selfSummaryCount).toBe(1);
    expect((await store.manifest(contextSessionId)).epoch).toBe(3);
  });

  test("collects only unreferenced archive blobs", async () => {
    const root = await workspace();
    const store = new BotCompactionArchiveStore(root);
    const contextSessionId = crypto.randomUUID();
    const blobs = join(root, contextSessionId, "blobs");
    await mkdir(blobs, { recursive: true });
    const orphan = join(blobs, `${"a".repeat(64)}.json`);
    await writeFile(orphan, "orphan");
    expect(await store.collectOrphans(contextSessionId)).toBe(6);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("Bot coordinator", () => {

  test("projects a completed background result between model steps at the 90 percent gate", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const captured = [
      text("user", "goal"),
      text("assistant", "progress"),
      text("user", "latest request"),
    ];
    await coordinator.observe({
      contextSessionId,
      piMessages: captured,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer: async () => ({ text: "settled background summary" }),
    });
    await Promise.resolve();
    const suffix = text("assistant", "tool call completed after capture");
    const projected = await coordinator.modelContextMessages({
      contextSessionId,
      piMessages: [...captured, suffix],
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
    });
    expect(projected[0]).toEqual(captured.at(-1));
    expect(projected[1]?.providerOptions).toEqual({ cursor: { isSummary: true } });
    expect(projected[2]).toEqual(suffix);
    expect(coordinator.projectedReason(contextSessionId)).toBeNull();
    expect((await store.manifest(contextSessionId)).epoch).toBe(1);
    expect(coordinator.takeProjectedEvent(contextSessionId)).toMatchObject({
      epoch: 1,
      reason: "approaching_token_limit",
    });
    expect(coordinator.consumeProjectedCommit(contextSessionId)).toBe(true);
    expect(coordinator.consumeProjectedCommit(contextSessionId)).toBe(false);
  });

  test("starts background inference without waiting for it", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    let release!: (value: { text: string }) => void;
    let settled = false;
    const inference = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    }).then((value) => {
      settled = true;
      return value;
    });
    await coordinator.observe({
      contextSessionId,
      piMessages: [text("user", "goal"), text("assistant", "progress"), text("user", "latest")],
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer: async () => inference,
    });
    expect(settled).toBe(false);
    release({ text: "background result" });
    expect(
      (
        await coordinator.beforePiCompaction({
          contextSessionId,
          piMessages: [text("user", "goal"), text("assistant", "progress"), text("user", "latest")],
          reason: "threshold",
          firstKeptEntryId: "kept-entry",
          tokensBefore: 95_000,
          systemPrompt: "system-v1",
          infer: async () => ({ text: "should not run" }),
          signal: new AbortController().signal,
        })
      )?.summary
    ).toBe("background result");
  });

  test("restarts background inference when an observed prefix message changes", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const initial = [text("user", "goal"), text("assistant", "tool call"), text("user", "latest")];
    const requests: Array<{ messagesToSummarize: BotMessage[] }> = [];
    const infer = async (request: { messagesToSummarize: BotMessage[] }) => {
      requests.push(request);
      return { text: `summary-${requests.length}` };
    };
    await coordinator.observe({
      contextSessionId,
      piMessages: initial,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer,
    });
    const first = initial[0];
    const last = initial[2];
    if (!first || !last) throw new Error("Expected initial prefix messages");
    const rewritten = [first, text("assistant", "rewritten tool call"), last];
    await coordinator.observe({
      contextSessionId,
      piMessages: rewritten,
      systemPrompt: "system-v1",
      usedTokens: 91_000,
      maxTokens: 100_000,
      infer,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messagesToSummarize).toContainEqual(rewritten[1]);
  });

  test("rejects a background result when the system snapshot changed", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [text("user", "goal"), text("assistant", "progress"), text("user", "latest")];
    let calls = 0;
    const infer = async (request: { systemPrompt: string }) => {
      calls += 1;
      return {
        text: request.systemPrompt.includes("system-v2") ? "fresh result" : "stale result",
      };
    };
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer,
    });
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v2",
      infer,
      signal: new AbortController().signal,
    });
    expect(prepared?.summary).toBe("fresh result");
    expect(calls).toBe(2);
  });

  test("reuses a non-blocking background result at Pi's persist boundary", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [
      text("user", "goal"),
      text("assistant", "progress"),
      text("user", "latest request"),
      text("assistant", "latest work"),
    ];
    let calls = 0;
    const infer = async () => {
      calls += 1;
      return { text: "merged state" };
    };
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer,
    });
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer,
      signal: new AbortController().signal,
    });
    expect(prepared?.summary).toBe("merged state");
    expect(prepared?.details.reason).toBe("self_summary_completed");
    expect(calls).toBe(1);
    const adopted = await coordinator.afterPiCompaction({
      contextSessionId,
      piBaseMessageCount: 2,
    });
    expect(adopted?.epoch).toBe(1);
    expect(adopted?.compactionId).toBe(prepared?.details.id);
    expect(adopted?.reason).toBe("self_summary_completed");
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });

  test("archives serialized payloads without nesting prior summary records", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const priorSummary = text("user", "old summary record", { isSummary: true });
    const messages: BotMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "goal" },
          { type: "image", data: "secret-image-bytes", mimeType: "image/png" },
        ],
      },
      priorSummary,
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "x".repeat(9_000) }],
      },
      text("user", "latest request"),
    ];
    await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer: async () => ({ text: "merged state" }),
      signal: new AbortController().signal,
    });
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: 2 });
    const archive = await store.latest(contextSessionId);
    const serialized = JSON.stringify(archive?.summarizedMessages);
    expect(serialized).toContain("secret-image-bytes");
    expect(serialized).not.toContain("old summary record");
    expect(
      (
        archive?.summarizedMessages?.find((message) => message.role === "toolResult")
          ?.content as Array<{ text?: string }>
      )[0]?.text
    ).toHaveLength(9_000);
  });

  test("overflow recovery sends a size-capped transcript and shrinks it after an input-limit error", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages: BotMessage[] = [text("user", "goal")];
    for (let index = 0; index < 12; index += 1) {
      messages.push(text(index % 2 ? "assistant" : "user", `message-${index} ${"x".repeat(30_000)}`));
    }
    messages.push(text("user", "latest"), text("assistant", "current work"));
    const promptSizes: number[] = [];
    const requests: BotSummaryRequest[] = [];
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "overflow",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 100_000,
      maxTokens: 100_000,
      systemPrompt: "system-v1",
      tools: [{ name: "Read", description: "Read", parameters: {} }],
      infer: async (request) => {
        requests.push(request);
        promptSizes.push(request.external?.prompt.length ?? 0);
        if (promptSizes.length === 1) {
          const error = new Error("input token limit");
          error.name = "InputTokenLimitError";
          throw error;
        }
        if (promptSizes.length === 2) return { text: "" };
        return { text: "recovered" };
      },
      signal: new AbortController().signal,
    });
    expect(prepared?.summary).toBe("recovered");
    expect(promptSizes).toHaveLength(3);
    expect(promptSizes[0]).toBeLessThanOrEqual(219_000);
    expect(promptSizes.at(1)!).toBeLessThan(promptSizes.at(0)!);
    expect(promptSizes.at(2)).toBe(promptSizes.at(1));
    expect(requests[0]!.systemPrompt).toStartWith("You are an intelligent assistant, tasked with summarizing the following conversation.");
    expect(requests[0]!.tools).toBeUndefined();
    expect(requests[0]!.external!.maxTokens).toBe(25_000);
    expect(requests[0]!.external!.prompt).toContain("user: latest");
    expect(requests[0]!.external!.prompt).toEndWith("following this structure and ensuring precision and thoroughness in your response.</summarization_request>");
    // The carrier comes first; the latest request and its tail stay verbatim after it.
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: messages.length });
    const projected = await store.contextMessages(contextSessionId, messages);
    const textOf = (message: BotMessage) => typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    expect(projected.map(textOf)).toEqual([
      "[Previous conversation summary]: recovered",
      "latest",
      "current work",
    ]);
    expect(projected[0]!.providerOptions).toEqual({ cursor: { isSummary: true } });
  });

  test("aborts immediately while waiting between summary retries", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 60_000);
    const contextSessionId = crypto.randomUUID();
    const controller = new AbortController();
    let firstAttempt!: () => void;
    const attempted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    const compaction = coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: [
        text("user", "goal"),
        text("assistant", "progress"),
        text("user", "latest request"),
      ],
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer: async () => {
        firstAttempt();
        throw new Error("transient");
      },
      signal: controller.signal,
    });
    await attempted;
    controller.abort();
    await expect(
      Promise.race([
        compaction,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("abort did not interrupt retry delay")), 1_000)
        ),
      ])
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// Coordinator pressure, parking and adoption against a live observation.
describe("Bot coordinator lifecycle", () => {
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
      }
    );
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toContain("Project root:");
    expect(blocks[1]).toBe(TRANSCRIPT_LOCATION);
    expect(blocks.at(-2)).toContain(">A<");
    expect(blocks.at(-1)).toContain(">B<");
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

  test("ordinary end-of-turn pressure defers in-flight work and adopts a completed result", async () => {
    const { coordinator, observation } = await setup();
    const result = deferred<{ text: string }>();
    observation.usedTokens = 90_000;
    observation.infer = () => result.promise;
    expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(false);
    expect(
      await coordinator.beforePiCompaction({
        ...observation,
        reason: "threshold",
        tokensBefore: 90_000,
        firstKeptEntryId: "last",
        signal: new AbortController().signal,
      })
    ).toBeNull();
    result.resolve({ text: "Ready" });
    await settle();
    expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(true);
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

  test("last request excludes injected reminders but preserves ordinary users with the same text", () => {
    const genuine = text("user", "Do not forget the original goal");
    const reminder = {
      ...text("user", "Reminder: send an update"),
      providerOptions: { cursor: { sandSendMessageReminder: true } },
    };
    expect(
      partitionForBotSummary([genuine, text("assistant", "Working"), reminder])?.lastUserMessage
    ).toEqual(genuine);
    expect(partitionForBotSummary([text("user", "Earlier"), genuine])?.lastUserMessage).toEqual(
      genuine
    );
  });

  test("capacity backpressure leaves 90 percent nonblocking and adopts at the limit with new tail intact", async () => {
    const { coordinator, observation, store } = await setup();
    const generated = deferred<{ text: string }>();
    let inferenceCalls = 0;
    const input = {
      ...observation,
      infer: async () => {
        inferenceCalls++;
        return generated.promise;
      },
    };
    await coordinator.observe(input);
    await coordinator.waitForModelCapacity(input, new AbortController().signal);
    expect((await store.manifest(input.contextSessionId)).epoch).toBe(0);
    const steering = text("user", "Latest correction survives the capacity wait");
    const full = { ...input, usedTokens: 100_000, piMessages: [...input.piMessages, steering] };
    let finished = false;
    const waiting = coordinator.waitForModelCapacity(full, new AbortController().signal).then(() => {
      finished = true;
    });
    await settle();
    expect(finished).toBe(false);
    generated.resolve({ text: "Original unfinished goal and exact ledger values" });
    await waiting;
    const projected = await coordinator.modelContextMessages(full);
    expect(projected.at(-1)).toEqual(steering);
    expect((await store.manifest(input.contextSessionId)).epoch).toBe(1);
    expect(inferenceCalls).toBe(1);
  });

  test("a failed pending summary cannot skip the durable model projection", async () => {
    const { coordinator, observation, store } = await setup();
    await coordinator.observe(observation);
    await settle();
    await coordinator.modelContextMessages(observation);
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
    const generated = deferred<{ text: string }>();
    const input = {
      ...observation,
      freshUsage: true,
      usedTokens: 100_000,
      piMessages: [...observation.piMessages, text("user", "Continue with the correction")],
      infer: () => generated.promise,
    };
    await coordinator.observe(input);
    const waiting = coordinator.waitForModelCapacity(input, new AbortController().signal);
    await settle();
    generated.reject(new Error("Summary provider unavailable"));
    await waiting;
    const projected = JSON.stringify(await coordinator.modelContextMessages(input));
    expect(projected).toContain("summary_content");
    expect(projected).toContain("Continue with the correction");
    expect(projected).not.toContain("Built red");
  });
});
