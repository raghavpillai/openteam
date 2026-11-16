import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExternalSummaryPrompt, externalPromptChars, partitionForExternalSummary, reduceExternalPromptChars } from "../src/compaction/external";
import { compactionObservation } from "../src/runtime/compaction";
import type { ActiveTurn } from "../src/runtime/types";
import { tempDirs } from "./temp";
import { type BotSummaryRequest, botUserInfoMessage, estimateBotContextTokens, estimateBotMeasuredContextTokens, closeBotPreservedTail, BotCompactionArchiveStore, BotCompactionCoordinator, type BotMessage, type BotObservation, botDurableBlocks, TRANSCRIPT_LOCATION, botBackgroundThreshold, botMessageDigest, botPersistThreshold, botPiPersistReserve, botSummaryPrompt, botSummaryRetryDirective, partitionForBotSummary, reduceBotSummaryInputMessages, shouldPersistBotSummary, shouldStartBotSummary, stripEmptyTrailingAssistantMessages } from "../src/bot-compaction";
const tempDir = tempDirs();

const workspace = () => tempDir("openteam-bot-compaction-");
const plain = (role: string, content: string): BotMessage => ({ role, content });

const text = (role: string, value: string, options?: Record<string, unknown>): BotMessage =>
  ({ role, content: [{ type: "text", text: value }], ...(options ? { providerOptions: { cursor: options } } : {}) });

describe("Bot trigger thresholds", () => {
  test("starts and adopts once 10,000 tokens or 10% of the window remain, including Pi's strict boundary", () => {
    for (const [window, boundary] of [[12_000, 2_000], [100_003, 90_003], [128_000, 115_200], [1_000_000, 900_000]] as const) {
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
    for (const usage of [NaN, Infinity, -1]) expect(shouldStartBotSummary(usage, 100_000)).toBe(false);
  });
});

describe("Bot summary partition", () => {
  test("the preserved last request skips summaries, reminders, user info and empty or failed assistant envelopes", () => {
    const userInfo = text("user", "<user_info>current identity</user_info>", { isUserInfo: true });
    const priorSummary = text("user", "prior summary", { isSummary: true });
    const lastUser = text("user", "finish the implementation");
    const partition = partitionForBotSummary([userInfo, text("user", "original request"), text("assistant", "work one"), priorSummary, lastUser, text("assistant", "work two")])!;
    expect(partition.userInfoMessage).toEqual(userInfo);
    expect(partition.lastUserMessage).toEqual(lastUser);
    for (const kept of [priorSummary, lastUser, text("assistant", "work two")]) expect(partition.messagesToSummarize).toContainEqual(kept);
    const prompt = botSummaryPrompt();
    expect(prompt).toContain("Please summarize the conversation so far.");
    for (const absent of ["system snapshot", "current identity", "finish the implementation"]) expect(prompt).not.toContain(absent);
    // A trailing failed envelope is dropped; an empty one in the middle is not summarized.
    const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "context_length_exceeded" } as BotMessage;
    const trailing = [text("user", "goal"), text("assistant", "working"), text("user", "continue"), failed];
    expect(stripEmptyTrailingAssistantMessages(trailing)).toEqual(trailing.slice(0, -1));
    expect(partitionForBotSummary(trailing)?.lastUserMessage).toEqual(text("user", "continue"));
    const corrected = [plain("user", "Build red"), plain("assistant", ""), plain("assistant", "Built red"), plain("user", "Correction: keep blue"), plain("assistant", "Inspected blue"),
      { ...plain("user", "OLD SUMMARY"), providerOptions: { cursor: { isSummary: true } } }];
    const latest = partitionForBotSummary(corrected)!;
    expect(latest.lastUserMessage.content).toBe("Correction: keep blue");
    expect(latest.messagesToSummarize).toContainEqual(latest.lastUserMessage);
    expect(latest.messagesToSummarize).not.toContainEqual(plain("assistant", ""));
    expect(latest.messagesToSummarize.at(-1)).toEqual(corrected.at(-1)!);
    expect(partitionForBotSummary([plain("user", "goal"), plain("assistant", "work")])).not.toBeNull();
    // Injected reminders are not requests, but an ordinary user with the same text is.
    const genuine = plain("user", "Do not forget the original goal");
    const reminder = { ...plain("user", "Reminder: send an update"), providerOptions: { cursor: { sandSendMessageReminder: true } } };
    expect(partitionForBotSummary([genuine, plain("assistant", "Working"), reminder])?.lastUserMessage).toEqual(genuine);
    expect(partitionForBotSummary([plain("user", "Earlier"), genuine])?.lastUserMessage).toEqual(genuine);
  });

  test("matches Bot's summary retry classifier", () => {
    const named = (name: string, message = name): Error => Object.assign(new Error(message), { name });
    const cases: Array<[unknown, [boolean, boolean, boolean, boolean]]> = [
      [named("OutputTokensLimitExceededError"), [true, true, true, true]],
      [named("InputTokenLimitError"), [true, false, true, false]],
      [named("ResourceExhausted", "text fields are too large"), [true, false, true, false]],
      [named("ResourceExhausted"), [true, true, false, false]],
      [named("InvalidArgument", "User API Key Rate limit exceeded for this request"), [true, true, false, false]],
      [named("InvalidArgument"), [false, false, false, false]],
      [named("AbortError"), [false, false, false, false]],
      [new Error("uncategorized"), [true, true, false, false]],
    ];
    for (const [error, [retry, delay, reduceInputs, shorter]] of cases) expect(botSummaryRetryDirective(error)).toEqual({ retry, delay, reduceInputs, shorter });
    expect(botSummaryRetryDirective("not-an-error").retry).toBe(false);
  });

  const call = (...ids: string[]): BotMessage => ({ role: "assistant", content: ids.map((id, index) => ({ type: "toolCall", id, name: ["SendToUser", "Read"][index]!, arguments: {} })) });
  const result = (id: string): BotMessage => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: id }] });

  test("retry reduction keeps the reference suffix even for a delayed tool result", () => {
    const priorSummary = text("user", "prior summary", { isSummary: true });
    const read: BotMessage = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }] };
    const reduced = reduceBotSummaryInputMessages([
      text("user", "goal"), text("assistant", "start"), text("user", "middle-1"), text("assistant", "middle-2"), read, text("user", "middle-3"),
      priorSummary, text("assistant", "middle-4"), result("call-1"), text("user", "newest-1"), text("assistant", "newest-2"), text("user", "newest-3"),
    ]);
    expect(reduced).not.toContainEqual(read);
    expect(reduced).toContainEqual(result("call-1"));
    expect(reduced).toContainEqual(priorSummary);
  });

  test("the preserved suffix moves a multi-call owner straddling the boundary with all results and later messages", () => {
    const owner = call("call-1", "call-2");
    const completed = text("assistant", "done");
    expect(closeBotPreservedTail(3, [text("user", "goal"), owner, result("call-1"), result("call-2"), completed])).toEqual([owner, result("call-1"), result("call-2"), completed]);
  });

  test("all attached skills survive alongside supported deterministic context", () => {
    const blocks = botDurableBlocks(plain("user", "<manually_attached_skills>A</manually_attached_skills>\n<manually_attached_skills>B</manually_attached_skills>"),
      { isRootProject: true, projectRoot: "/project", transcriptPath: "/transcript", todoUpdate: "Check blue" });
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toContain("Project root:");
    expect(blocks[1]).toBe(TRANSCRIPT_LOCATION);
    expect(blocks.at(-2)).toContain(">A<");
    expect(blocks.at(-1)).toContain(">B<");
  });
});

describe("restart-safe compaction archive", () => {
  const record = (lastUser: BotMessage, overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), reason: "approaching_token_limit" as const, summary: "summary", prefixDigest: botMessageDigest([lastUser]),
    piBaseMessageCount: 1, userInfoMessage: null, lastUserMessage: lastUser, preservedTailMessages: [], tokensBefore: 95_000, tokensAfter: 2_000,
    imageCount: 0, turnCount: 2, usage: null, startedAt: new Date(1).toISOString(), completedAt: new Date(2).toISOString(), ...overrides,
  });
  test("retains the sealed failed assistant before the overflow retry", async () => {
    const contextSessionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(await workspace());
    const lastUser = text("user", "retry this request");
    const nativeBase = [text("user", "native summary"), lastUser];
    await store.commit(contextSessionId, record(lastUser, { reason: "fallback_on_limit_error", piBaseMessageCount: nativeBase.length }));
    const failed = { ...text("assistant", "context limit"), stopReason: "error", errorMessage: "context_length_exceeded" };
    const recovered = text("assistant", "successful retry");
    const rebuilt = await store.contextMessages(contextSessionId, [...nativeBase, failed, recovered]);
    expect(rebuilt).toContainEqual(failed);
    expect(rebuilt.at(-1)).toEqual(recovered);
  });

  test("keeps archive epoch monotonic but resets self-summary count per user query", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const contextSessionId = crypto.randomUUID();
    const commit = (label: string) => store.commit(contextSessionId, record(text("user", label), { summary: label }));
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
  const coordinators: { coordinator: BotCompactionCoordinator; contextSessionId: string }[] = [];
  afterEach(() => {
    for (const { coordinator, contextSessionId } of coordinators.splice(0)) coordinator.discardBackground(contextSessionId);
  });
  const history = () => [plain("user", "Build red"), plain("assistant", "Built red"), plain("user", "Correction: keep blue"), plain("assistant", "Inspected blue")];
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const fixture = async (retryDelayMs = 0) => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, retryDelayMs);
    const contextSessionId = crypto.randomUUID();
    coordinators.push({ coordinator, contextSessionId });
    const observation: BotObservation = {
      contextSessionId, piMessages: history(), systemPrompt: "system-v1", usedTokens: 90_000, maxTokens: 100_000,
      modelKey: "fixture/model", infer: async () => ({ text: "Keep blue; red work is obsolete." }),
    };
    const compact = { contextSessionId, reason: "threshold" as const, firstKeptEntryId: "kept-entry", tokensBefore: 95_000, systemPrompt: "system-v1", signal: new AbortController().signal };
    return { store, coordinator, contextSessionId, base: observation, observation, compact };
  };
  const latest = () => [text("user", "goal"), text("assistant", "progress"), text("user", "latest request")];

  test("projects a completed background result between model steps at the 90 percent gate", async () => {
    const { store, coordinator, contextSessionId, base } = await fixture();
    const captured = latest();
    await coordinator.observe({ ...base, piMessages: captured, infer: async () => ({ text: "settled background summary" }) });
    await Promise.resolve();
    const suffix = text("assistant", "tool call completed after capture");
    const projected = await coordinator.modelContextMessages({ ...base, piMessages: [...captured, suffix] });
    expect(projected[0]).toEqual(captured.at(-1));
    expect(projected[1]?.providerOptions).toEqual({ cursor: { isSummary: true } });
    expect(projected[2]).toEqual(suffix);
    expect(coordinator.projectedReason(contextSessionId)).toBeNull();
    expect((await store.manifest(contextSessionId)).epoch).toBe(1);
    expect(coordinator.takeProjectedEvent(contextSessionId)).toMatchObject({ epoch: 1, reason: "approaching_token_limit" });
    expect(coordinator.consumeProjectedCommit(contextSessionId)).toBe(true);
    expect(coordinator.consumeProjectedCommit(contextSessionId)).toBe(false);
  });

  test("restarts background inference when an observed prefix message or the system snapshot changes", async () => {
    const { coordinator, base, compact } = await fixture();
    const initial = latest();
    const requests: Array<{ messagesToSummarize: BotMessage[]; systemPrompt: string }> = [];
    const infer = async (request: { messagesToSummarize: BotMessage[]; systemPrompt: string }) => {
      requests.push(request);
      return { text: request.systemPrompt.includes("system-v2") ? "fresh result" : "stale result" };
    };
    await coordinator.observe({ ...base, piMessages: initial, infer });
    const rewritten = [initial[0]!, text("assistant", "rewritten tool call"), initial[2]!];
    await coordinator.observe({ ...base, piMessages: rewritten, usedTokens: 91_000, infer });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messagesToSummarize).toContainEqual(rewritten[1]);
    const prepared = await coordinator.beforePiCompaction({ ...compact, piMessages: rewritten, systemPrompt: "system-v2", infer });
    expect(prepared?.summary).toBe("fresh result");
    expect(requests).toHaveLength(3);
  });

  test("reuses a non-blocking background result at Pi's persist boundary", async () => {
    const { store, coordinator, contextSessionId, base, compact } = await fixture();
    const messages = [...latest(), text("assistant", "latest work")];
    let calls = 0;
    const infer = async () => { calls += 1; return { text: "merged state" }; };
    await coordinator.observe({ ...base, piMessages: messages, infer });
    const prepared = await coordinator.beforePiCompaction({ ...compact, piMessages: messages, infer });
    expect(prepared?.summary).toBe("merged state");
    expect(prepared?.details.reason).toBe("self_summary_completed");
    expect(calls).toBe(1);
    const adopted = await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: 2 });
    expect(adopted).toMatchObject({ epoch: 1, compactionId: prepared?.details.id, reason: "self_summary_completed" });
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });

  test("archives serialized payloads without nesting prior summary records", async () => {
    const { store, coordinator, contextSessionId, compact } = await fixture();
    const messages: BotMessage[] = [
      { role: "user", content: [{ type: "text", text: "goal" }, { type: "image", data: "secret-image-bytes", mimeType: "image/png" }] },
      text("user", "old summary record", { isSummary: true }),
      { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "x".repeat(9_000) }] },
      text("user", "latest request"),
    ];
    await coordinator.beforePiCompaction({ ...compact, piMessages: messages, infer: async () => ({ text: "merged state" }) });
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: 2 });
    const serialized = JSON.stringify((await store.latest(contextSessionId))?.summarizedMessages);
    expect(serialized).toContain("secret-image-bytes");
    expect(serialized).toContain("x".repeat(9_000));
    expect(serialized).not.toContain("old summary record");
  });

  test("overflow recovery sends a size-capped transcript and shrinks it after an input-limit error", async () => {
    const { store, coordinator, contextSessionId, compact } = await fixture();
    const messages: BotMessage[] = [text("user", "goal")];
    for (let index = 0; index < 12; index += 1) messages.push(text(index % 2 ? "assistant" : "user", `message-${index} ${"x".repeat(30_000)}`));
    messages.push(text("user", "latest"), text("assistant", "current work"));
    const requests: BotSummaryRequest[] = [];
    const prepared = await coordinator.beforePiCompaction({
      ...compact, piMessages: messages, reason: "overflow", tokensBefore: 100_000, maxTokens: 100_000, tools: [{ name: "Read", description: "Read", parameters: {} }],
      infer: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw Object.assign(new Error("input token limit"), { name: "InputTokenLimitError" });
        return { text: requests.length === 2 ? "" : "recovered" };
      },
    });
    const promptSizes = requests.map((request) => request.external?.prompt.length ?? 0);
    expect(prepared?.summary).toBe("recovered");
    expect(promptSizes).toHaveLength(3);
    expect(promptSizes[0]).toBeLessThanOrEqual(219_000);
    expect(promptSizes[1]!).toBeLessThan(promptSizes[0]!);
    expect(promptSizes[2]).toBe(promptSizes[1]);
    expect(requests[0]!.systemPrompt).toStartWith("You are an intelligent assistant, tasked with summarizing the following conversation.");
    expect(requests[0]!.tools).toBeUndefined();
    expect(requests[0]!.external!.maxTokens).toBe(25_000);
    expect(requests[0]!.external!.prompt).toContain("user: latest");
    // The carrier comes first; the latest request and its tail stay verbatim after it.
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: messages.length });
    const projected = await store.contextMessages(contextSessionId, messages);
    const textOf = (message: BotMessage) => typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
    expect(projected.map(textOf)).toEqual(["[Previous conversation summary]: recovered", "latest", "current work"]);
    expect(projected[0]!.providerOptions).toEqual({ cursor: { isSummary: true } });
  });

  test("aborts immediately while waiting between summary retries", async () => {
    const { coordinator, compact } = await fixture(60_000);
    const controller = new AbortController();
    const attempted = deferred<void>();
    const compaction = coordinator.beforePiCompaction({
      ...compact, piMessages: latest(), signal: controller.signal, infer: async () => { attempted.resolve(); throw new Error("transient"); },
    });
    await attempted.promise;
    controller.abort();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("abort did not interrupt retry delay")), 1_000));
    await expect(Promise.race([compaction, timeout])).rejects.toMatchObject({ name: "AbortError" });
  });

  test("model, reasoning, window and tool changes reuse an unchanged prefix and freeze retry schemas", async () => {
    const { coordinator, observation, store } = await fixture();
    const result = deferred<{ text: string }>();
    const requests: any[] = [];
    const tools = [{ name: "Read", description: "Read files", parameters: {} }];
    await coordinator.observe({
      ...observation, tools,
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
    const next = { ...observation, modelKey: "new/model/reasoning/tools", maxTokens: 200_000, tools: [{ name: "New", description: "Discovered", parameters: {} }] };
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
    const { coordinator, store, observation } = await fixture();
    const result = deferred<{ text: string }>();
    let signal!: AbortSignal;
    let calls = 0;
    observation.infer = (_request, capturedSignal) => { calls++; signal = capturedSignal; return result.promise; };
    await coordinator.observe(observation);
    coordinator.parkBackground(observation.contextSessionId);
    expect(signal.aborted).toBe(false);
    await coordinator.beginUserQuery(observation.contextSessionId);
    const next = { ...observation, piMessages: [...observation.piMessages, plain("user", "Also keep the tests")] };
    await coordinator.observe(next);
    expect(calls).toBe(1);
    result.resolve({ text: "Blue version is current" });
    await settle();
    const projected = await coordinator.modelContextMessages(next);
    expect(projected.at(-1)).toEqual(next.piMessages.at(-1)!);
    expect(projected.filter((message) => message.content === "Correction: keep blue")).toHaveLength(1);
    expect((await store.manifest(observation.contextSessionId)).archives[0]?.reason).toBe("approaching_token_limit");
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
    expect(await coordinator.modelContextMessages(next)).toEqual(projected);
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
  });

  const blocking = (observation: BotObservation, extra: Record<string, unknown> = {}) =>
    ({ ...observation, reason: "manual" as const, tokensBefore: 96_000, firstKeptEntryId: "last", signal: new AbortController().signal, ...extra });

  test("ordinary end-of-turn pressure defers in-flight work and adopts a completed result", async () => {
    const { coordinator, observation } = await fixture();
    const result = deferred<{ text: string }>();
    observation.infer = () => result.promise;
    expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(false);
    expect(await coordinator.beforePiCompaction(blocking(observation, { reason: "threshold", tokensBefore: 90_000 }))).toBeNull();
    result.resolve({ text: "Ready" });
    await settle();
    expect(await coordinator.shouldCompactAtTurnEnd(observation)).toBe(true);
  });

  for (const changedPrefix of [false, true]) {
    test(`blocking generation revalidates the live transcript after ${changedPrefix ? "a prefix change" : "an appended message"}`, async () => {
      const { coordinator, store, observation } = await fixture();
      const started = deferred<void>();
      const result = deferred<{ text: string }>();
      let current = [...observation.piMessages];
      const preparing = coordinator.beforePiCompaction(blocking(observation, {
        readPiMessages: () => current, infer: async () => { started.resolve(); return result.promise; },
      }));
      await started.promise;
      const arrival = plain("user", "Background job finished while compacting");
      current = changedPrefix ? [plain("user", "Changed prior instruction"), ...current.slice(1)] : [...current, arrival];
      result.resolve({ text: "Ready" });
      const prepared = await preparing;
      if (changedPrefix) {
        expect(prepared).toBeNull();
        expect(await store.stagedId(observation.contextSessionId)).toBeNull();
      } else {
        expect(prepared?.retainedTail).toEqual([arrival]);
        await coordinator.afterPiCompaction({ contextSessionId: observation.contextSessionId, piBaseMessageCount: current.length });
        const projected = await coordinator.contextMessages(observation.contextSessionId, current);
        expect(projected.filter((message) => message.content === arrival.content)).toHaveLength(1);
      }
    });
  }

  test("deleting a context cancels a blocking summary and cannot resurrect its archive", async () => {
    const { coordinator, store, observation } = await fixture();
    const started = deferred<void>();
    const result = deferred<{ text: string }>();
    let signal!: AbortSignal;
    const failed = coordinator.beforePiCompaction(blocking(observation, {
      infer: async (_request: unknown, currentSignal: AbortSignal) => { signal = currentSignal; started.resolve(); return result.promise; },
    })).then(() => null, (error: unknown) => error);
    await started.promise;
    await coordinator.remove(observation.contextSessionId);
    expect(signal.aborted).toBe(true);
    expect(await failed).toMatchObject({ name: "AbortError" });
    result.resolve({ text: "Late result from an uncooperative provider" });
    await settle();
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(0);
  });

  test("capacity backpressure leaves 90 percent nonblocking and adopts at the limit with new tail intact", async () => {
    const { coordinator, observation, store } = await fixture();
    const generated = deferred<{ text: string }>();
    let inferenceCalls = 0;
    const input = { ...observation, infer: async () => { inferenceCalls++; return generated.promise; } };
    await coordinator.observe(input);
    await coordinator.waitForModelCapacity(input, new AbortController().signal);
    expect((await store.manifest(input.contextSessionId)).epoch).toBe(0);
    const steering = plain("user", "Latest correction survives the capacity wait");
    const full = { ...input, usedTokens: 100_000, piMessages: [...input.piMessages, steering] };
    let finished = false;
    const waiting = coordinator.waitForModelCapacity(full, new AbortController().signal).then(() => { finished = true; });
    await settle();
    expect(finished).toBe(false);
    generated.resolve({ text: "Original unfinished goal and exact ledger values" });
    await waiting;
    expect((await coordinator.modelContextMessages(full)).at(-1)).toEqual(steering);
    expect((await store.manifest(input.contextSessionId)).epoch).toBe(1);
    expect(inferenceCalls).toBe(1);
  });

  test("a failed pending summary cannot skip the durable model projection", async () => {
    const { coordinator, observation, store } = await fixture();
    await coordinator.observe(observation);
    await settle();
    await coordinator.modelContextMessages(observation);
    expect((await store.manifest(observation.contextSessionId)).epoch).toBe(1);
    const generated = deferred<{ text: string }>();
    const input = { ...observation, freshUsage: true, usedTokens: 100_000, piMessages: [...observation.piMessages, plain("user", "Continue with the correction")], infer: () => generated.promise };
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

describe("context token estimates", () => {
const dense = Array.from({ length: 270 }, (_, i) => createHash("sha256").update(`fixture:${i}`).digest("hex").repeat(3) + "\n").join("");
const measured = (stopReason = "toolUse", input = 244_000): BotMessage =>
  ({ role: "assistant", content: [], stopReason, usage: { input, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: input + 100 } });
const result: BotMessage = { role: "toolResult", toolCallId: "read-fixture", content: [{ type: "text", text: dense }] };

test("dense results cross capacity before another request instead of trusting chars/4", () => {
  expect(244_100 + Math.ceil(dense.length / 4)).toBeLessThan(272_000);
  expect(estimateBotMeasuredContextTokens([measured(), result])).toBeGreaterThan(272_000);
  const active = { contextSessionId: "qa", instructions: "system", modelRef: {},
    session: { messages: [measured(), result], getContextUsage: () => ({ tokens: 255_680, contextWindow: 272_000 }), getAllTools: () => [] } } as unknown as ActiveTurn;
  expect(compactionObservation(active).usedTokens).toBe(estimateBotMeasuredContextTokens([measured(), result]));
});

test("provider usage replaces estimates without recounting the measured prefix", () => {
  const messages = [result, measured(), result];
  const first = estimateBotMeasuredContextTokens(messages)!;
  expect(first).toBeGreaterThan(244_100);
  expect(estimateBotMeasuredContextTokens([...messages, measured("stop", 250_000)])).toBe(250_100);
  expect(estimateBotMeasuredContextTokens([result])).toBeNull();
  for (const reason of ["error", "aborted", "pending"])
    expect(estimateBotMeasuredContextTokens([...messages, measured(reason, 900_000)])).toBeLessThan(
      300_000
    );
});

test("Unicode and literal special-token strings are counted; image bytes are excluded", () => {
  expect(
    estimateBotContextTokens("", [{ role: "toolResult", content: "雪🙂λ".repeat(1000) }])
  ).toBeGreaterThan(2000);
  expect(
    estimateBotContextTokens("<|endoftext|>", [{ role: "user", content: "<|fim_suffix|>" }])
  ).toBeGreaterThan(0);
  const withImage = (data: string) =>
    estimateBotContextTokens("", [{ role: "toolResult", content: [{ type: "image", data }] }]);
  expect(withImage("small")).toBe(withImage("x".repeat(1_000_000)));
});
});

describe("external summary prompts", () => {
test("the request and everything after it stay verbatim unless that tail fills the window", () => {
  const userInfo = botUserInfoMessage("<user_info>x</user_info>", 0);
  const messages = [userInfo, plain("user", "goal"), plain("assistant", "a"), plain("user", "latest"), plain("assistant", "working")];
  const partition = partitionForExternalSummary(messages, 100_000)!;
  expect(partition.userInfoMessage).toEqual(userInfo);
  expect(partition.tailStart).toBe(3);
  expect(partition.messagesToSummarize.map((message) => message.content)).toEqual(["goal", "a", "latest"]);
  expect(partition.requestAfterSummary).toBeNull();
  // A tail as large as the window is summarized too; the request comes back after the summary.
  const huge = partitionForExternalSummary([...messages, plain("assistant", "y".repeat(400_000))], 50_000)!;
  expect(huge.tailStart).toBe(6);
  expect(huge.requestAfterSummary?.content).toBe("latest");
});

test("over budget, each message keeps a fair share and the request text survives", () => {
  const messages = [plain("user", `<user_query>\nkeep me\n</user_query>${"u".repeat(40_000)}`), plain("assistant", "a".repeat(40_000)), plain("assistant", "short")];
  const full = buildExternalSummaryPrompt(messages, { budget: 1_000_000 });
  expect(full).toStartWith("user: <user_query>");
  expect(full).toContain("\n<summarization_request>What you see above is the conversation so far");
  expect(full).not.toContain("subscription");
  const cut = buildExternalSummaryPrompt(messages, { budget: 30_000, shorter: true });
  expect(cut.length).toBeLessThanOrEqual(30_000);
  expect(cut).toContain("<user_query>\nkeep me\n</user_query>\n[... truncated,");
  expect(cut).toContain("assistant: short");
  expect(cut).toContain("Additional instruction: Write a shorter summary");
  expect(reduceExternalPromptChars(1_000_000, 1, 800_000)).toBe(500_000);
  expect(reduceExternalPromptChars(1_000_000, 2)).toBe(333_333);
  expect(reduceExternalPromptChars(60_000, 2)).toBe(50_000);
  expect(externalPromptChars(200_000, 32_000)).toBe(498_000);
  expect(externalPromptChars(2_000_000, 32_000)).toBe(2_800_000);
});
});
