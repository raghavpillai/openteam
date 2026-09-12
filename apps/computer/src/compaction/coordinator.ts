import { randomUUID } from "node:crypto";
import type { BotCompactionArchiveStore } from "./archive";
import {
  BOT_IMAGE_TRIGGER,
  BOT_TURN_TRIGGER,
  botDurableBlocks,
  botMessageDigest,
  botSummaryMessage,
  botSummaryRetryDirective,
  canonicalJson,
  closeBotPreservedTail,
  compactionEvent,
  countBotImages,
  countBotTurns,
  isSummary,
  messagesHavePrefixByValue,
  partitionForBotSummary,
  redactBotArchiveMessages,
  reduceBotSummaryInputMessages,
  replaceBotUserInfo,
  sha256,
  shouldStartBotSummary,
} from "./messages";
import type {
  BotArchiveBlob,
  BotCompactionEvent,
  BotCompactionReason,
  BotMessage,
  BotPartition,
  BotSummaryRequest,
  BotSummaryResult,
  BotSummaryUsage,
} from "./types";

export interface PendingSummary {
  contextSessionId: string;
  id: string;
  reason: BotCompactionReason;
  capturedMessages: BotMessage[];
  partition: BotPartition;
  durableBlocks: string[];
  prefixDigest: string;
  systemDigest: string;
  tokensBefore: number | null;
  imageCount: number;
  turnCount: number;
  startedAt: string;
  controller: AbortController | null;
  promise: Promise<BotSummaryResult>;
  result: BotSummaryResult | null;
  projectedMidLoop: boolean;
}

export interface BotObservation {
  contextSessionId: string;
  piMessages: readonly BotMessage[];
  systemPrompt: string;
  userInfoMessage?: BotMessage | null;
  usedTokens: number | null;
  maxTokens: number;
  projectRoot?: string;
  transcriptPath?: string;
  todoUpdate?: string;
  automationTrigger?: string;
  infer: (request: BotSummaryRequest, signal: AbortSignal) => Promise<BotSummaryResult>;
}

export interface BotPreparedCompaction {
  summary: string;
  firstKeptEntryId: string;
  retainedTail: BotMessage[];
  tokensBefore: number;
  usage?: BotSummaryUsage;
  details: {
    openteamBotCompaction: true;
    id: string;
    contextSessionId: string;
    reason: BotCompactionReason;
  };
}

export class BotCompactionCoordinator {
  private static readonly MAX_PENDING = 64;
  private readonly pending = new Map<string, PendingSummary>();
  private readonly forcedReasons = new Map<string, BotCompactionReason>();
  private readonly projectedEvents = new Map<string, BotCompactionEvent>();
  private readonly projectedCommits = new Set<string>();
  private readonly prepared = new Map<
    string,
    {
      pending: PendingSummary;
      result: BotSummaryResult;
      tail: BotMessage[];
      piPersisted: boolean;
    }
  >();

  constructor(
    private readonly store: BotCompactionArchiveStore,
    private readonly retryDelayMs = 2_000
  ) {}

  forceReason(contextSessionId: string, reason: BotCompactionReason): void {
    this.forcedReasons.set(contextSessionId, reason);
  }

  clearForcedReason(contextSessionId: string): void {
    this.forcedReasons.delete(contextSessionId);
  }

  private clearVolatile(contextSessionId: string): void {
    this.pending.get(contextSessionId)?.controller?.abort();
    this.pending.delete(contextSessionId);
    this.prepared.delete(contextSessionId);
    this.forcedReasons.delete(contextSessionId);
    this.projectedEvents.delete(contextSessionId);
    this.projectedCommits.delete(contextSessionId);
  }

  async failCompaction(contextSessionId: string): Promise<void> {
    const prepared = this.prepared.get(contextSessionId);
    this.clearVolatile(contextSessionId);
    if (!prepared?.piPersisted) await this.store.discardStaged(contextSessionId);
  }

  async remove(contextSessionId: string): Promise<void> {
    await this.failCompaction(contextSessionId);
    await this.store.remove(contextSessionId);
  }

  async stagedId(contextSessionId: string): Promise<string | null> {
    return this.store.stagedId(contextSessionId);
  }

  async recoverStaged(
    contextSessionId: string,
    piBaseMessageCount: number,
    persistedCompactionIds: readonly string[]
  ): Promise<BotArchiveBlob | null> {
    const stagedId = await this.store.stagedId(contextSessionId);
    if (!stagedId) return null;
    if (!persistedCompactionIds.includes(stagedId)) {
      await this.store.discardStaged(contextSessionId);
      this.clearVolatile(contextSessionId);
      return null;
    }
    const recovered = await this.store.commitStaged(contextSessionId, stagedId, piBaseMessageCount);
    this.clearVolatile(contextSessionId);
    return recovered;
  }

  async beginUserQuery(contextSessionId: string, resetSelfSummaryCount = true): Promise<void> {
    this.projectedEvents.delete(contextSessionId);
    this.projectedCommits.delete(contextSessionId);
    if (resetSelfSummaryCount) await this.store.beginUserQuery(contextSessionId);
  }

  takeProjectedEvent(contextSessionId: string): BotCompactionEvent | null {
    const event = this.projectedEvents.get(contextSessionId) ?? null;
    this.projectedEvents.delete(contextSessionId);
    return event;
  }

  consumeProjectedCommit(contextSessionId: string): boolean {
    const committed = this.projectedCommits.delete(contextSessionId);
    return committed;
  }

  discardBackground(contextSessionId: string): void {
    const pending = this.pending.get(contextSessionId);
    pending?.controller?.abort();
    this.pending.delete(contextSessionId);
  }

  async contextMessages(
    contextSessionId: string,
    piMessages: readonly BotMessage[]
  ): Promise<BotMessage[]> {
    return this.store.contextMessages(contextSessionId, piMessages);
  }

  async modelContextMessages(input: {
    contextSessionId: string;
    piMessages: readonly BotMessage[];
    systemPrompt: string;
    userInfoMessage?: BotMessage | null;
    usedTokens: number | null;
    maxTokens: number;
  }): Promise<BotMessage[]> {
    const current = replaceBotUserInfo(
      await this.contextMessages(input.contextSessionId, input.piMessages),
      input.userInfoMessage ?? null
    );
    const pending = this.pending.get(input.contextSessionId);
    if (!pending?.result) return current;
    if (
      pending.systemDigest !== sha256(input.systemPrompt) ||
      !messagesHavePrefixByValue(pending.capturedMessages, current)
    ) {
      pending.controller?.abort();
      this.pending.delete(input.contextSessionId);
      return current;
    }
    const warrantsMidLoopPersist =
      countBotImages(current) >= BOT_IMAGE_TRIGGER ||
      (input.usedTokens !== null && shouldStartBotSummary(input.usedTokens, input.maxTokens));
    if (!warrantsMidLoopPersist) return current;
    pending.projectedMidLoop = true;
    const tail = closeBotPreservedTail(pending.capturedMessages.length, current);
    const completedAt = new Date().toISOString();
    const tokensAfter = Math.ceil(
      canonicalJson([
        pending.partition.userInfoMessage,
        pending.partition.lastUserMessage,
        pending.result.text,
        pending.durableBlocks,
        tail,
      ]).length / 4
    );
    const blob = await this.store.commit(input.contextSessionId, {
      id: pending.id,
      reason: pending.reason,
      summary: pending.result.text,
      prefixDigest: pending.prefixDigest,
      piBaseMessageCount: input.piMessages.length,
      userInfoMessage: pending.partition.userInfoMessage,
      lastUserMessage: pending.partition.lastUserMessage,
      preservedTailMessages: tail,
      durableBlocks: pending.durableBlocks,
      summarizedMessages: redactBotArchiveMessages(
        pending.partition.messagesToSummarize.filter((message) => !isSummary(message))
      ),
      tokensBefore: pending.tokensBefore,
      tokensAfter,
      imageCount: pending.imageCount,
      turnCount: pending.turnCount,
      usage: pending.result.usage ?? null,
      startedAt: pending.startedAt,
      completedAt,
    });
    this.pending.delete(input.contextSessionId);
    this.projectedEvents.set(input.contextSessionId, compactionEvent(input.contextSessionId, blob));
    this.projectedCommits.add(input.contextSessionId);
    return [
      ...(blob.userInfoMessage ? [structuredClone(blob.userInfoMessage)] : []),
      structuredClone(blob.lastUserMessage),
      botSummaryMessage(
        blob.summary,
        blob.selfSummaryCount,
        new Date(blob.completedAt).getTime(),
        blob.durableBlocks ?? []
      ),
      ...tail,
    ];
  }

  projectedReason(contextSessionId: string): BotCompactionReason | null {
    const pending = this.pending.get(contextSessionId);
    return pending?.projectedMidLoop ? pending.reason : null;
  }

  async observe(input: BotObservation): Promise<void> {
    const messages = replaceBotUserInfo(
      await this.contextMessages(input.contextSessionId, input.piMessages),
      input.userInfoMessage ?? null
    );
    const imageCount = countBotImages(messages);
    const turnCount = countBotTurns(messages);
    const reason: BotCompactionReason | null =
      imageCount >= BOT_IMAGE_TRIGGER
        ? "approaching_image_limit"
        : turnCount >= BOT_TURN_TRIGGER ||
            (input.usedTokens !== null && shouldStartBotSummary(input.usedTokens, input.maxTokens))
          ? "approaching_token_limit"
          : null;
    if (!reason) return;
    const existing = this.pending.get(input.contextSessionId);
    if (existing) {
      if (
        existing.systemDigest === sha256(input.systemPrompt) &&
        messagesHavePrefixByValue(existing.capturedMessages, messages)
      ) {
        return;
      }
      existing.controller?.abort();
      this.pending.delete(input.contextSessionId);
    }
    const partition = partitionForBotSummary(messages);
    if (!partition) return;
    const controller = new AbortController();
    const pending: PendingSummary = {
      contextSessionId: input.contextSessionId,
      id: randomUUID(),
      reason,
      capturedMessages: messages,
      partition,
      durableBlocks: botDurableBlocks(partition.lastUserMessage, input),
      prefixDigest: botMessageDigest(messages),
      systemDigest: sha256(input.systemPrompt),
      tokensBefore: input.usedTokens,
      imageCount,
      turnCount,
      startedAt: new Date().toISOString(),
      controller,
      promise: this.generate(partition, input.systemPrompt, input.infer, controller.signal),
      result: null,
      projectedMidLoop: false,
    };
    if (this.pending.size >= BotCompactionCoordinator.MAX_PENDING) {
      const oldest = this.pending.entries().next().value as [string, PendingSummary] | undefined;
      if (oldest) {
        oldest[1].controller?.abort();
        this.pending.delete(oldest[0]);
      }
    }
    this.pending.set(input.contextSessionId, pending);
    void pending.promise
      .then((result) => {
        if (this.pending.get(input.contextSessionId) === pending) pending.result = result;
      })
      .catch(() => {
        if (this.pending.get(input.contextSessionId) === pending) {
          this.pending.delete(input.contextSessionId);
        }
      });
  }

  private async generate(
    partition: BotPartition,
    systemPrompt: string,
    infer: BotObservation["infer"],
    signal: AbortSignal
  ): Promise<BotSummaryResult> {
    let lastError: unknown;
    let reduceInputs = false;
    let shorter = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
      try {
        const retryPartition =
          !reduceInputs || partition.messagesToSummarize.length <= 8
            ? partition
            : {
                ...partition,
                messagesToSummarize: reduceBotSummaryInputMessages(partition.messagesToSummarize),
              };
        const result = await infer(
          {
            systemPrompt,
            userInfoMessage: retryPartition.userInfoMessage,
            messagesToSummarize: retryPartition.messagesToSummarize,
            shorter,
          },
          signal
        );
        if (!result.text.trim()) {
          lastError = new Error("Self-summary returned no content");
          if (attempt === 2) break;
          // Empty output is its own Bot retry path: immediate, full input, and
          // no shorter-output request. It never passes through the error classifier.
          reduceInputs = false;
          shorter = false;
          continue;
        }
        return { ...result, text: result.text.trim() };
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
        const directive = botSummaryRetryDirective(error);
        if (!directive.retry || attempt === 2) break;
        reduceInputs = directive.reduceInputs;
        shorter = directive.shorter;
        if (!directive.delay) continue;
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const onAbort = () => {
            clearTimeout(timer);
            rejectDelay(new DOMException("Compaction aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolveDelay();
          }, this.retryDelayMs);
          timer.unref();
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async beforePiCompaction(input: {
    contextSessionId: string;
    piMessages: readonly BotMessage[];
    reason: "manual" | "threshold" | "overflow";
    firstKeptEntryId: string;
    tokensBefore: number;
    systemPrompt: string;
    userInfoMessage?: BotMessage | null;
    projectRoot?: string;
    transcriptPath?: string;
    todoUpdate?: string;
    automationTrigger?: string;
    infer: BotObservation["infer"];
    signal: AbortSignal;
  }): Promise<BotPreparedCompaction | null> {
    const current = replaceBotUserInfo(
      await this.contextMessages(input.contextSessionId, input.piMessages),
      input.userInfoMessage ?? null
    );
    let pending = this.pending.get(input.contextSessionId);
    if (
      !pending ||
      pending.systemDigest !== sha256(input.systemPrompt) ||
      !messagesHavePrefixByValue(pending.capturedMessages, current)
    ) {
      if (pending) {
        pending.controller?.abort();
        this.pending.delete(input.contextSessionId);
      }
      const partition = partitionForBotSummary(current);
      if (!partition) return null;
      const forced = this.forcedReasons.get(input.contextSessionId);
      const reason: BotCompactionReason =
        forced ??
        (input.reason === "overflow" ? "fallback_on_limit_error" : "approaching_token_limit");
      pending = {
        contextSessionId: input.contextSessionId,
        id: randomUUID(),
        reason,
        capturedMessages: current,
        partition,
        durableBlocks: botDurableBlocks(partition.lastUserMessage, input),
        prefixDigest: botMessageDigest(current),
        systemDigest: sha256(input.systemPrompt),
        tokensBefore: input.tokensBefore,
        imageCount: countBotImages(current),
        turnCount: countBotTurns(current),
        startedAt: new Date().toISOString(),
        controller: null,
        promise: this.generate(partition, input.systemPrompt, input.infer, input.signal),
        result: null,
        projectedMidLoop: false,
      };
      this.pending.set(input.contextSessionId, pending);
    }
    const forcedReason = this.forcedReasons.get(input.contextSessionId);
    if (forcedReason) pending.reason = forcedReason;
    else if (input.reason === "overflow") pending.reason = "fallback_on_limit_error";
    else if (input.reason === "threshold" && !pending.projectedMidLoop) {
      pending.reason = "self_summary_completed";
    }
    const result = await pending.promise;
    pending.result = result;
    const refreshed = replaceBotUserInfo(
      await this.contextMessages(input.contextSessionId, input.piMessages),
      input.userInfoMessage ?? null
    );
    if (!messagesHavePrefixByValue(pending.capturedMessages, refreshed)) {
      this.pending.delete(input.contextSessionId);
      return null;
    }
    const tail = closeBotPreservedTail(pending.capturedMessages.length, refreshed);
    const completedAt = new Date().toISOString();
    const tokensAfter = Math.ceil(
      canonicalJson([
        pending.partition.userInfoMessage,
        pending.partition.lastUserMessage,
        result.text,
        pending.durableBlocks,
        tail,
      ]).length / 4
    );
    await this.store.stage(input.contextSessionId, {
      id: pending.id,
      reason: pending.reason,
      summary: result.text,
      prefixDigest: pending.prefixDigest,
      userInfoMessage: pending.partition.userInfoMessage,
      lastUserMessage: pending.partition.lastUserMessage,
      preservedTailMessages: tail,
      durableBlocks: pending.durableBlocks,
      summarizedMessages: redactBotArchiveMessages(
        pending.partition.messagesToSummarize.filter((message) => !isSummary(message))
      ),
      tokensBefore: pending.tokensBefore,
      tokensAfter,
      imageCount: pending.imageCount,
      turnCount: pending.turnCount,
      usage: result.usage ?? null,
      startedAt: pending.startedAt,
      completedAt,
    });
    this.prepared.set(input.contextSessionId, {
      pending,
      result,
      tail,
      piPersisted: false,
    });
    this.forcedReasons.delete(input.contextSessionId);
    return {
      summary: result.text,
      firstKeptEntryId: input.firstKeptEntryId,
      retainedTail: tail,
      tokensBefore: input.tokensBefore,
      usage: result.usage,
      details: {
        openteamBotCompaction: true,
        id: pending.id,
        contextSessionId: input.contextSessionId,
        reason: pending.reason,
      },
    };
  }

  async afterPiCompaction(input: {
    contextSessionId: string;
    piBaseMessageCount: number;
  }): Promise<BotCompactionEvent | null> {
    const prepared = this.prepared.get(input.contextSessionId);
    if (!prepared) return null;
    prepared.piPersisted = true;
    const blob = await this.store.commitStaged(
      input.contextSessionId,
      prepared.pending.id,
      input.piBaseMessageCount
    );
    this.prepared.delete(input.contextSessionId);
    this.pending.delete(input.contextSessionId);
    return compactionEvent(input.contextSessionId, blob);
  }
}

export const isContextLimitError = (value: unknown): boolean => {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /context[_ -]?length[_ -]?exceeded|prompt is too long|input.{0,40}(?:context window|too long)|request.{0,20}size.{0,20}bytes|input\s*\+\s*max_tokens/i.test(
    text
  );
};
