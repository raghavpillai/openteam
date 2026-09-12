import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PiModelRef } from "@openteam/contracts";
import type { BotCompactionEvent } from "../bot-compaction";
import {
  type BotCompactionCoordinator,
  type BotMessage,
  botSummaryPrompt,
  type BotSummaryRequest,
  type BotSummaryResult,
  botSummarySystemPrompt,
} from "../bot-compaction";
import { textFromContent } from "./content";
import type { RuntimeTools } from "./tools";
import type { ActiveTurn } from "./types";

export const modelVisibleSummaryTools = (
  tools: ReadonlyArray<{
    name: string;
    description: string;
    parameters: unknown;
    constrainedSampling?: unknown;
  }>
) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  }));

export function compactionExtension(
  compaction: BotCompactionCoordinator,
  inferCompaction: (
    active: ActiveTurn,
    request: BotSummaryRequest,
    signal: AbortSignal
  ) => Promise<BotSummaryResult>,
  sessionManager: SessionManager,
  active: ActiveTurn
): { name: string; hidden: boolean; factory: ExtensionFactory } {
  const infer = (request: BotSummaryRequest, signal: AbortSignal) =>
    inferCompaction(active, request, signal);
  return {
    name: "openteam-bot-compaction",
    hidden: true,
    factory: (pi) => {
      pi.on("context", async (event) => {
        const usage = active.session?.getContextUsage();
        const messages = await compaction.modelContextMessages({
          contextSessionId: active.contextSessionId,
          piMessages: event.messages as BotMessage[],
          systemPrompt: active.instructions,
          userInfoMessage: active.userInfoMessage,
          usedTokens: usage?.tokens ?? null,
          maxTokens: usage?.contextWindow ?? active.session?.model?.contextWindow ?? 0,
        });
        const adopted = compaction.takeProjectedEvent(active.contextSessionId);
        if (adopted) {
          publishCompaction(active, adopted);
        }
        return {
          messages: messages as typeof event.messages,
        };
      });
      pi.on("message_start", async (event) => {
        if (event.message.role !== "user" || !active.session) return;
        const usage = active.session.getContextUsage();
        await compaction.observe({
          contextSessionId: active.contextSessionId,
          piMessages: active.session.messages as BotMessage[],
          systemPrompt: active.instructions,
          userInfoMessage: active.userInfoMessage,
          usedTokens: usage?.tokens ?? null,
          maxTokens: usage?.contextWindow ?? active.session.model?.contextWindow ?? 0,
          projectRoot: active.cwd,
          transcriptPath: active.sessionPath ?? undefined,
          todoUpdate: active.todoUpdate ?? undefined,
          automationTrigger: active.automationTrigger ?? undefined,
          infer,
        });
      });
      pi.on("session_before_compact", async (event) => {
        const prepared = await compaction.beforePiCompaction({
          contextSessionId: active.contextSessionId,
          piMessages: sessionManager.buildSessionContext().messages as BotMessage[],
          reason: event.reason,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          systemPrompt: active.instructions,
          userInfoMessage: active.userInfoMessage,
          projectRoot: active.cwd,
          transcriptPath: active.sessionPath ?? undefined,
          todoUpdate: active.todoUpdate ?? undefined,
          automationTrigger: active.automationTrigger ?? undefined,
          infer,
          signal: event.signal,
        });
        return prepared ? { compaction: prepared as never } : { cancel: true };
      });
      pi.on("session_compact", async (event) => {
        const piMessages = sessionManager.buildSessionContext().messages as BotMessage[];
        const retryError = event.willRetry ? piMessages.at(-1) : undefined;
        const piBaseMessageCount =
          retryError?.role === "assistant" &&
          ["error", "length"].includes(String(retryError.stopReason ?? ""))
            ? piMessages.length - 1
            : piMessages.length;
        const adopted = await compaction.afterPiCompaction({
          contextSessionId: active.contextSessionId,
          piBaseMessageCount,
        });
        if (!adopted) return;
        publishCompaction(active, adopted);
      });
      pi.on("session_compact_failed", async () => {
        await compaction.failCompaction(active.contextSessionId);
      });
    },
  };
}

export async function inferCompaction(
  modelRuntime: ModelRuntime | null,
  resolveModel: (ref: PiModelRef) => NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  customTools: RuntimeTools["customTools"],
  active: ActiveTurn,
  request: BotSummaryRequest,
  signal: AbortSignal
): Promise<BotSummaryResult> {
  if (!modelRuntime) throw new Error("Pi model runtime is not initialized");
  const model = resolveModel(active.modelRef);
  const thinkingLevel = clampThinkingLevel(model, active.reasoning);
  if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");

  // The summarization wrapper sends the normal model-visible schemas through
  // a stream-only session. Calling the model runtime directly gives us the same
  // surface while making tool execution structurally impossible.
  const result = await modelRuntime.completeSimple(
    model,
    {
      systemPrompt: botSummarySystemPrompt(request.systemPrompt),
      messages: [
        ...(request.userInfoMessage ? [request.userInfoMessage] : []),
        ...request.messagesToSummarize,
        {
          role: "user",
          content: [{ type: "text", text: botSummaryPrompt(request.shorter) }],
          timestamp: Date.now(),
        },
      ] as never,
      tools: modelVisibleSummaryTools(customTools(active)) as never,
    },
    {
      signal,
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
    }
  );
  if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
  // The coordinator owns the special empty-output retry path.
  return {
    text: textFromContent(result.content),
    usage: result.usage as never,
  };
}

function publishCompaction(active: ActiveTurn, adopted: BotCompactionEvent): void {
  active.queue.push({
    type: "compaction",
    turnId: active.turnId,
    contextSessionId: adopted.contextSessionId,
    compactionId: adopted.compactionId,
    epoch: adopted.epoch,
    reason: adopted.reason,
    prefixDigest: adopted.prefixDigest,
    summaryDigest: adopted.summaryDigest,
    tokensBefore: adopted.tokensBefore,
    tokensAfter: adopted.tokensAfter,
    imageCount: adopted.imageCount,
    turnCount: adopted.turnCount,
    startedAt: adopted.startedAt,
    completedAt: adopted.completedAt,
  });
}
