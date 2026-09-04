import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  closeBotPreservedTail,
  countBotImages,
  countBotTurns,
  BotCompactionArchiveStore,
  BotCompactionCoordinator,
  type BotMessage,
  botBackgroundThreshold,
  botConversationSizeLimits,
  botDurableBlocks,
  botMessageDigest,
  botPersistThreshold,
  botPiPersistReserve,
  botSummaryMessage,
  botSummaryPrompt,
  botSummaryRetryDirective,
  botSummarySystemPrompt,
  botUserInfoMessage,
  partitionForBotSummary,
  reduceBotSummaryInputMessages,
  replaceBotUserInfo,
  shouldPersistBotSummary,
  shouldStartBotSummary,
  stripEmptyTrailingAssistantMessages,
} from "../src/bot-compaction";

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
  test("starts and persists on the first matching absolute-or-percent boundary", () => {
    expect(botBackgroundThreshold(272_000)).toBe(244_800);
    expect(botPersistThreshold(272_000)).toBe(258_400);
    expect(botPiPersistReserve(272_000)).toBe(13_601);
    expect(shouldStartBotSummary(244_799, 272_000)).toBe(false);
    expect(shouldStartBotSummary(244_800, 272_000)).toBe(true);
    expect(shouldPersistBotSummary(258_399, 272_000)).toBe(false);
    expect(shouldPersistBotSummary(258_400, 272_000)).toBe(true);
    expect(botBackgroundThreshold(64_000)).toBe(54_000);
    expect(botPersistThreshold(64_000)).toBe(59_000);
  });

  test("supports Bot's byte-limit environment overrides with safe fallbacks", () => {
    expect(
      botConversationSizeLimits({
        SAND_CONVERSATION_SOFT_LIMIT_BYTES: "1024",
        SAND_CONVERSATION_HARD_LIMIT_BYTES: "4096",
      })
    ).toEqual({ soft: 1024, hard: 4096 });
    expect(
      botConversationSizeLimits({
        SAND_CONVERSATION_SOFT_LIMIT_BYTES: "-1",
        SAND_CONVERSATION_HARD_LIMIT_BYTES: "not-a-number",
      })
    ).toEqual({ soft: 256 * 1024 * 1024, hard: 1024 * 1024 * 1024 });
  });
});

describe("Bot summary partition", () => {
  test("drops only empty trailing assistant envelopes before summarization", () => {
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
    expect(prompt).toContain("Summarize the conversation state");
    expect(prompt).not.toContain("system snapshot");
    expect(prompt).not.toContain("current identity");
    expect(prompt).not.toContain("finish the implementation");
  });

  test("replaces the frozen user-info catalog after a summary epoch advances", () => {
    const oldUserInfo = botUserInfoMessage("<user_info>old skills</user_info>", 0, 1);
    const newUserInfo = botUserInfoMessage("<user_info>new skills</user_info>", 1, 2);
    const messages = replaceBotUserInfo(
      [oldUserInfo, text("user", "request"), text("assistant", "answer")],
      newUserInfo
    );
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(newUserInfo);
    expect(JSON.stringify(messages)).not.toContain("old skills");
    expect(messages[0]?.providerOptions).toEqual({
      cursor: { isUserInfo: true, userInfoSummarizationEpoch: 1 },
    });
  });

  test("keeps user-info byte-stable across turns in the same summary epoch", () => {
    const first = botUserInfoMessage("<user_info>catalog</user_info>", 4);
    const later = botUserInfoMessage("<user_info>catalog</user_info>", 4);
    expect(botMessageDigest([first])).toBe(botMessageDigest([later]));
    expect(first.timestamp).toBe(4);
  });

  test("does not mistake user-authored user_info text for platform metadata", () => {
    const quoted = text("user", "Please inspect this literal: <user_info>example</user_info>");
    const replacement = botUserInfoMessage("<user_info>catalog</user_info>", 1, 2);
    const messages = replaceBotUserInfo([quoted, text("assistant", "answer")], replacement);
    expect(messages).toContainEqual(quoted);
    expect(countBotTurns(messages)).toBe(1);
  });

  test("does not apply xAI-only synthetic acknowledgement filtering", () => {
    const acknowledgement = text("user", "continue without acknowledging");
    const partition = partitionForBotSummary([
      text("user", "goal"),
      text("assistant", "progress"),
      acknowledgement,
      text("assistant", "more progress"),
    ]);
    expect(partition?.lastUserMessage).toEqual(acknowledgement);
  });

  test("uses the active SelfSummarizer wrapper instead of the unused xAI wrapper", () => {
    const attachedSkills =
      '<manually_attached_skills><skill name="audit" /></manually_attached_skills>';
    const durableBlocks = botDurableBlocks(text("user", `request\n${attachedSkills}`), {
      projectRoot: "/workspace/a&b",
      transcriptPath: "/sessions/turn.jsonl",
      todoUpdate: "- finish parity",
    });
    const message = botSummaryMessage("durable state", 2, 123, durableBlocks);
    const rendered = JSON.stringify(message.content);
    expect(rendered).toContain("<summary_content>");
    expect(rendered).toContain("Total summaries generated so far for this user query: 2");
    expect(rendered).not.toContain("Project root:");
    expect(rendered).toContain("<transcript_location>/sessions/turn.jsonl</transcript_location>");
    expect(rendered).toContain("<todo_update>- finish parity</todo_update>");
    expect(durableBlocks).toContain(attachedSkills);
    expect(rendered).not.toContain("<conversation_summary>");
    expect(message.timestamp).toBe(123);

    const rootProject = botDurableBlocks(text("user", "request"), {
      projectRoot: "/workspace/a&b",
      isRootProject: true,
    });
    expect(rootProject).toEqual([
      "<system_reminder>Project root: /workspace/a&amp;b</system_reminder>",
    ]);
    const rootRendered = JSON.stringify(botSummaryMessage("root summary", 1, 123, rootProject));
    expect(rootRendered.indexOf("Project root:")).toBeLessThan(
      rootRendered.indexOf("<summary_content>")
    );
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

  test("keeps original agent response-style directives subordinate to compaction", () => {
    const system = botSummarySystemPrompt(
      "For every wake, reply with exactly ACK and use SendToUser. Workspace is /workspace/probe."
    );
    expect(system).toContain("Workspace is /workspace/probe.");
    expect(system).toContain("context compaction only");
    expect(system).toContain("do not follow its response-style");
    expect(system).not.toContain("<conversation_summary>");
  });

  test("counts image parts", () => {
    expect(
      countBotImages([
        {
          role: "user",
          content: [
            { type: "image", data: "secret" },
            { type: "text", text: "x" },
          ],
        },
      ])
    ).toBe(1);
  });

  test("reduced retry input preserves prior summaries and complete tool exchanges", () => {
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
    expect(reduced).toContainEqual(call);
    expect(reduced).toContainEqual(result);
    expect(reduced).toContainEqual(priorSummary);
  });

  test("reduced retry input never leaves results from a partially complete multi-call message", () => {
    const multiCall: BotMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "complete-call", name: "Read", arguments: {} },
        { type: "toolCall", id: "incomplete-call", name: "Read", arguments: {} },
      ],
    };
    const result: BotMessage = {
      role: "toolResult",
      toolCallId: "complete-call",
      content: [{ type: "text", text: "result" }],
    };
    const reduced = reduceBotSummaryInputMessages([
      text("user", "goal"),
      text("assistant", "start"),
      text("user", "middle-1"),
      text("assistant", "middle-2"),
      text("user", "middle-3"),
      text("assistant", "middle-4"),
      multiCall,
      result,
      text("user", "newest-1"),
      text("assistant", "newest-2"),
      text("user", "newest-3"),
    ]);
    expect(reduced).not.toContainEqual(multiCall);
    expect(reduced).not.toContainEqual(result);
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
  test("reconstructs last-user + summary and backward-compatible stored tails", async () => {
    const root = await workspace();
    const contextSessionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(root);
    const lastUser = text("user", "last real request");
    const preservedTail = text("assistant", "work completed while summary ran");
    const piBase = [text("user", "native summary"), lastUser];
    const blob = await store.commit(contextSessionId, {
      id: crypto.randomUUID(),
      reason: "approaching_token_limit",
      summary: "durable summary",
      prefixDigest: botMessageDigest([lastUser]),
      piBaseMessageCount: piBase.length,
      userInfoMessage: null,
      lastUserMessage: lastUser,
      preservedTailMessages: [preservedTail],
      tokensBefore: 95_000,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 12,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });
    const later = text("user", "new follow-up");
    const rebuilt = await store.contextMessages(contextSessionId, [...piBase, later]);
    const rebuiltAgain = await store.contextMessages(contextSessionId, [...piBase, later]);
    expect(blob.sequence).toBe(1);
    expect(rebuilt[0]).toEqual(lastUser);
    expect(rebuilt[1]?.providerOptions).toEqual({ cursor: { isSummary: true } });
    expect(rebuilt[2]).toEqual(preservedTail);
    expect(rebuilt[3]).toEqual(later);
    expect(botMessageDigest(rebuiltAgain)).toBe(botMessageDigest(rebuilt));
    expect((await store.manifest(contextSessionId)).epoch).toBe(1);
  });

  test("repairs a legacy archive whose captured prefix split a tool exchange", async () => {
    const root = await workspace();
    const contextSessionId = crypto.randomUUID();
    const store = new BotCompactionArchiveStore(root);
    const lastUser = text("user", "last request");
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
    const nativeBase = [text("user", "native summary"), completed];
    await store.commit(contextSessionId, {
      id: crypto.randomUUID(),
      reason: "approaching_image_limit",
      summary: "durable summary",
      prefixDigest: botMessageDigest([lastUser, call]),
      piBaseMessageCount: nativeBase.length,
      userInfoMessage: null,
      lastUserMessage: lastUser,
      summarizedMessages: [call],
      preservedTailMessages: [result, completed],
      tokensBefore: 10_000,
      tokensAfter: 1_000,
      imageCount: 85,
      turnCount: 12,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });

    const later = text("user", "follow-up");
    const rebuilt = await store.contextMessages(contextSessionId, [...nativeBase, later]);
    expect(rebuilt.slice(2)).toEqual([call, result, completed, later]);
  });

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

  test("does not reset the per-query summary count for a simulated continuation", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store);
    const contextSessionId = crypto.randomUUID();
    const commit = (label: string) =>
      store.commit(contextSessionId, {
        id: crypto.randomUUID(),
        reason: "approaching_token_limit",
        summary: label,
        prefixDigest: botMessageDigest([text("user", label)]),
        piBaseMessageCount: 0,
        userInfoMessage: null,
        lastUserMessage: text("user", label),
        preservedTailMessages: [],
        tokensBefore: 10_000,
        tokensAfter: 1_000,
        imageCount: 0,
        turnCount: 1,
        usage: null,
        startedAt: new Date(1).toISOString(),
        completedAt: new Date(2).toISOString(),
      });

    expect((await commit("first")).selfSummaryCount).toBe(1);
    await coordinator.beginUserQuery(contextSessionId, false);
    expect((await commit("simulated continuation")).selfSummaryCount).toBe(2);
    await coordinator.beginUserQuery(contextSessionId, true);
    expect((await commit("new user query")).selfSummaryCount).toBe(1);
  });

  test("fails closed when the hard byte cap remains exceeded", async () => {
    const root = await workspace();
    const contextSessionId = crypto.randomUUID();
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, "x".repeat(128));
    const store = new BotCompactionArchiveStore(join(root, "archives"));
    await expect(
      store.enforceSizeLimit(contextSessionId, sessionPath, { soft: 32, hard: 64 })
    ).rejects.toThrow("SAND-E0414 conversationTooLarge");
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

  test("rejects a manifest whose latest pointer is not the final archive", async () => {
    const root = await workspace();
    const store = new BotCompactionArchiveStore(root);
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
    await commit("first");
    await commit("second");
    const manifestPath = join(root, contextSessionId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      latestArchiveId: string;
      archives: Array<{ id: string }>;
    };
    const firstArchive = manifest.archives[0];
    if (!firstArchive) throw new Error("Expected the first archive");
    manifest.latestArchiveId = firstArchive.id;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(store.manifest(contextSessionId)).rejects.toThrow("Invalid compaction manifest");
  });

  test("rejects invalid archive metrics before database projection", async () => {
    const root = await workspace();
    const store = new BotCompactionArchiveStore(root);
    const contextSessionId = crypto.randomUUID();
    await store.commit(contextSessionId, {
      id: crypto.randomUUID(),
      reason: "approaching_token_limit",
      summary: "summary",
      prefixDigest: botMessageDigest([text("user", "goal")]),
      piBaseMessageCount: 1,
      userInfoMessage: null,
      lastUserMessage: text("user", "goal"),
      preservedTailMessages: [],
      tokensBefore: 95_000,
      tokensAfter: 2_000,
      imageCount: 0,
      turnCount: 12,
      usage: null,
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
    });
    const manifestPath = join(root, contextSessionId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      archives: Array<{ tokensAfter: number }>;
    };
    const archive = manifest.archives[0];
    if (!archive) throw new Error("Expected an archive");
    archive.tokensAfter = -1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(store.manifest(contextSessionId)).rejects.toThrow("Invalid compaction manifest");
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
  test("starts turn-only background work at 1,000 users without projecting it", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = Array.from({ length: 1_000 }, (_, index) => text("user", `turn-${index}`));
    let calls = 0;
    const infer = async () => ({ text: `turn-summary-${++calls}` });
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: null,
      maxTokens: 100_000,
      infer,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(
      await coordinator.modelContextMessages({
        contextSessionId,
        piMessages: messages,
        systemPrompt: "system-v1",
        usedTokens: null,
        maxTokens: 100_000,
      })
    ).toEqual(messages);
    expect(coordinator.projectedReason(contextSessionId)).toBeNull();

    coordinator.discardBackground(contextSessionId);
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: null,
      maxTokens: 100_000,
      infer,
    });
    expect(calls).toBe(2);
  });

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

  test("projects a valid tool exchange when a completed summary boundary ends on its call", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const call: BotMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "SendToUser", arguments: {} }],
    };
    const captured = [text("user", "goal"), text("user", "latest request"), call];
    await coordinator.observe({
      contextSessionId,
      piMessages: captured,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer: async () => ({ text: "settled background summary" }),
    });
    await Promise.resolve();
    const result: BotMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "delivered" }],
    };
    const projected = await coordinator.modelContextMessages({
      contextSessionId,
      piMessages: [...captured, result],
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
    });
    expect(projected.slice(2)).toEqual([call, result]);
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

  test("keeps background inference when only a suffix was appended", async () => {
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
    const toolResult = text("assistant", "tool result and later work");
    await coordinator.observe({
      contextSessionId,
      piMessages: [...initial, toolResult],
      systemPrompt: "system-v1",
      usedTokens: 91_000,
      maxTokens: 100_000,
      infer,
    });
    expect(requests).toHaveLength(1);

    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: [...initial, toolResult],
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer,
      signal: new AbortController().signal,
    });
    expect(prepared?.summary).toBe("summary-1");
    expect(requests).toHaveLength(1);
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: 2 });
    expect((await store.latest(contextSessionId))?.preservedTailMessages).toEqual([toolResult]);
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

  test("reuses a background result and preserves messages appended after its prefix", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [text("user", "goal"), text("assistant", "progress"), text("user", "latest")];
    const requests: Array<{ messagesToSummarize: BotMessage[] }> = [];
    const infer = async (request: { messagesToSummarize: BotMessage[] }) => {
      requests.push(request);
      return { text: requests.length === 1 ? "stale result" : "fresh result" };
    };
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer,
    });
    const appended = text("assistant", "work after background capture");
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: [...messages, appended],
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer,
      signal: new AbortController().signal,
    });
    expect(prepared?.summary).toBe("stale result");
    expect(requests).toHaveLength(1);
    await coordinator.afterPiCompaction({ contextSessionId, piBaseMessageCount: 2 });
    expect((await store.latest(contextSessionId))?.preservedTailMessages).toEqual([appended]);
  });

  test("clears captured history after a failed Pi compaction", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [text("user", "goal"), text("assistant", "progress"), text("user", "latest")];
    let calls = 0;
    const infer = async () => ({ text: `result-${++calls}` });
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer,
    });
    await coordinator.failCompaction(contextSessionId);
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
    expect(prepared?.summary).toBe("result-2");
    expect(calls).toBe(2);
  });

  test("aborts pending inference when its context is deleted", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    let aborted = false;
    await coordinator.observe({
      contextSessionId,
      piMessages: [text("user", "goal"), text("assistant", "progress"), text("user", "latest")],
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer: async (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true }
          );
        }),
    });
    await coordinator.remove(contextSessionId);
    expect(aborted).toBe(true);
    expect((await store.manifest(contextSessionId)).epoch).toBe(0);
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

  test("records overflow as fallback even when token background work already exists", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [text("user", "goal"), text("assistant", "progress"), text("user", "latest")];
    await coordinator.observe({
      contextSessionId,
      piMessages: messages,
      systemPrompt: "system-v1",
      usedTokens: 90_000,
      maxTokens: 100_000,
      infer: async () => ({ text: "background state" }),
    });
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "overflow",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 100_001,
      systemPrompt: "system-v1",
      infer: async () => ({ text: "unused" }),
      signal: new AbortController().signal,
    });
    expect(prepared?.details.reason).toBe("fallback_on_limit_error");
  });

  test("recovers a durable intent after Pi persisted but manifest adoption failed", async () => {
    const root = await workspace();
    const store = new BotCompactionArchiveStore(root);
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages = [
      text("user", "goal"),
      text("assistant", "progress"),
      text("user", "latest request"),
    ];
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "threshold",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 95_000,
      systemPrompt: "system-v1",
      infer: async () => ({ text: "recoverable state" }),
      signal: new AbortController().signal,
    });
    const compactionId = prepared?.details.id;
    if (!compactionId) throw new Error("Expected a staged compaction");
    expect(await store.stagedId(contextSessionId)).toBe(compactionId);

    // Simulate a process restart after Pi synchronously appended its entry but
    // before the session_compact handler advanced the manifest.
    const restarted = new BotCompactionCoordinator(new BotCompactionArchiveStore(root), 0);
    const recovered = await restarted.recoverStaged(contextSessionId, 2, [compactionId]);
    expect(recovered?.id).toBe(compactionId);
    expect(recovered?.piBaseMessageCount).toBe(2);
    expect((await store.manifest(contextSessionId)).epoch).toBe(1);
    expect(await store.stagedId(contextSessionId)).toBeNull();
  });

  test("discards an intent when Pi never persisted its matching compaction", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    await coordinator.beforePiCompaction({
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
      infer: async () => ({ text: "unpersisted state" }),
      signal: new AbortController().signal,
    });
    expect(await store.stagedId(contextSessionId)).not.toBeNull();
    expect(await coordinator.recoverStaged(contextSessionId, 0, [])).toBeNull();
    expect(await store.stagedId(contextSessionId)).toBeNull();
    expect((await store.manifest(contextSessionId)).epoch).toBe(0);
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

  test("retries transient errors with reduction but retries empty output immediately in full", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 0);
    const contextSessionId = crypto.randomUUID();
    const messages: BotMessage[] = [text("user", "goal")];
    for (let index = 0; index < 12; index += 1) {
      messages.push(text(index % 2 ? "assistant" : "user", `message-${index}`));
    }
    messages.push(text("user", "latest"), text("assistant", "current work"));
    const promptSizes: number[] = [];
    const shorter: boolean[] = [];
    const prepared = await coordinator.beforePiCompaction({
      contextSessionId,
      piMessages: messages,
      reason: "overflow",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 100_000,
      systemPrompt: "system-v1",
      infer: async (request) => {
        promptSizes.push(request.messagesToSummarize.length);
        shorter.push(request.shorter);
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
    expect(promptSizes.at(1) ?? 0).toBeLessThan(promptSizes.at(0) ?? 0);
    expect(promptSizes.at(2)).toBe(promptSizes.at(0));
    expect(shorter).toEqual([false, false, false]);
  });

  test("does not enter the configured retry delay for empty output", async () => {
    const store = new BotCompactionArchiveStore(await workspace());
    const coordinator = new BotCompactionCoordinator(store, 60_000);
    const contextSessionId = crypto.randomUUID();
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
      infer: async () => ({ text: "" }),
      signal: new AbortController().signal,
    });
    await expect(
      Promise.race([
        compaction,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("empty output entered retry delay")), 1_000)
        ),
      ])
    ).rejects.toThrow("Self-summary returned no content");
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
