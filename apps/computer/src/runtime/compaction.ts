import { fenceToolResults } from "./untrusted-results";
import type {
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { PiModelRef } from "@openteam/contracts";
import type { BotCompactionEvent } from "../bot-compaction";
import {
  type BotCompactionCoordinator,
  type BotMessage,
  type BotObservation,
  botSummaryPrompt,
  type BotSummaryRequest,
  type BotSummaryResult,
  botSummarySystemPrompt,
  botSummaryResponse,
  replaceBotUserInfo,
  canonicalJson,
  isValidBotEarlyThreshold,
  sha256,
} from "../bot-compaction";
import { textFromContent } from "./content";
import { inferenceReasoningOptions } from "./reasoning";
import type { RuntimeTools } from "./tools";
import type { ActiveTurn } from "./types";
import { communicationReminder, promptFingerprint } from "./prompt-context";
import { compactRepeatedDiscovery } from "./discovery-context";
import { graphicalProgressReminder } from "./graphical-completion";

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

/** Use one context shape for every summary entry point. */
export function compactionObservation(active: ActiveTurn): Omit<BotObservation, "infer"> {
  const usage = active.session?.getContextUsage();
  const hasProviderUsage = active.session?.messages.some(
    (message) =>
      message.role === "assistant" &&
      !["error", "aborted", "pending"].includes(message.stopReason) &&
      responseTokens(message as unknown as BotMessage, true) > 0
  );
  const tools = modelVisibleSummaryTools(
    (active.session?.getAllTools() ?? []).filter((tool) =>
      active.session?.getActiveToolNames().includes(tool.name)
    )
  );
  return {
    contextSessionId: active.contextSessionId,
    piMessages:
      active.compactionReadPiMessages?.() ?? ((active.session?.messages ?? []) as BotMessage[]),
    systemPrompt: active.instructions,
    userInfoMessage: active.userInfoMessage,
    usedTokens: hasProviderUsage ? (usage?.tokens ?? null) : null,
    maxTokens: usage?.contextWindow ?? active.session?.model?.contextWindow ?? 0,
    modelKey: sha256(canonicalJson({ model: active.modelRef, reasoning: active.reasoning, tools })),
    earlyThreshold: active.compactionEarlyThreshold,
    tools,
    projectRoot: active.cwd,
    isRootProject: active.isRootProject,
    transcriptPath: active.sessionPath ?? undefined,
    todoUpdate: active.todoUpdate ?? undefined,
    automationTrigger: active.automationTrigger ?? undefined,
  };
}

const responseTokens = (message: BotMessage, includeOutput: boolean): number => {
  const usage = message.usage as Record<string, unknown> | undefined;
  return ["input", "cacheRead", "cacheWrite", ...(includeOutput ? ["output"] : [])].reduce(
    (sum, key) =>
      sum +
      (typeof usage?.[key] === "number" && Number.isFinite(usage[key]) && usage[key] > 0
        ? usage[key]
        : 0),
    0
  );
};

export function compactionExtension(
  compaction: BotCompactionCoordinator,
  inferCompaction: (
    active: ActiveTurn,
    request: BotSummaryRequest,
    signal: AbortSignal
  ) => Promise<BotSummaryResult>,
  sessionManager: SessionManager,
  active: ActiveTurn,
  refreshContext?: (epoch: number) => Promise<void>,
  acknowledgeToolOutcomes?: (messages: BotMessage[]) => Promise<void>
): { name: string; hidden: boolean; factory: ExtensionFactory } {
  const readPiMessages = () => sessionManager.buildSessionContext().messages as BotMessage[];
  active.compactionReadPiMessages = readPiMessages;
  const infer = (request: BotSummaryRequest, signal: AbortSignal) =>
    inferCompaction(active, request, signal);
  let deferredAutomatic = false;
  return {
    name: "openteam-bot-compaction",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async () => ({ systemPrompt: active.instructions }));
      pi.on("context", async (event) => {
        await acknowledgeToolOutcomes?.(event.messages as BotMessage[]);
        const graphicalReminder = graphicalProgressReminder(event.messages as BotMessage[], active);
        if (graphicalReminder && active.session) {
          await active.session.sendCustomMessage({
            customType: "openteam-graphical-progress",
            content: graphicalReminder,
            display: false,
            details: { origin: "host" },
          }, { triggerTurn: false });
          event.messages = [...event.messages, active.session.messages.at(-1)!];
        }
        const reminder = communicationReminder(event.messages as BotMessage[], active);
        if (reminder && active.session) {
          await active.session.sendCustomMessage(
            {
              customType: "openteam-communication-reminder",
              content: reminder.content,
              display: false,
              details: { kind: reminder.kind, origin: "host" },
            },
            { triggerTurn: false }
          );
          event.messages = [...event.messages, active.session.messages.at(-1)!];
        }
        const observation = {
          ...compactionObservation(active),
          piMessages: readPiMessages(),
          infer,
        };
        await compaction.observe(observation);
        let messages = await compaction.modelContextMessages({
          ...observation,
        });
        const adopted = compaction.takeProjectedEvent(active.contextSessionId);
        if (adopted) {
          active.compactionEarlyThreshold = undefined;
          publishCompaction(active, adopted);
          await refreshContext?.(adopted.epoch);
          // Refresh may append durable update notes after the projection's base
          // was committed. Re-read that tail before acknowledging it to the model.
          messages = replaceBotUserInfo(
            await compaction.contextMessages(active.contextSessionId, readPiMessages()),
            active.userInfoMessage
          );
        }
        active.compactionRequestMessages = structuredClone(readPiMessages());
        messages = compactRepeatedDiscovery(messages);
        active.dynamicDiscoveryMessages = messages;
        const fingerprint = promptFingerprint(
          active.instructions,
          textFromContent(active.userInfoMessage?.content),
          modelVisibleSummaryTools(
            (active.session?.getAllTools() ?? []).filter((tool) =>
              active.session?.getActiveToolNames().includes(tool.name)
            )
          ),
          Number(
            (active.userInfoMessage?.providerOptions?.cursor as Record<string, unknown> | undefined)
              ?.userInfoSummarizationEpoch ?? 0
          )
        );
        const signature = JSON.stringify(fingerprint);
        if (active.lastPromptFingerprint !== signature) {
          active.lastPromptFingerprint = signature;
          active.queue.push({
            type: "item.completed",
            turnId: active.turnId,
            item: {
              id: `prompt:${active.turnId}:${fingerprint.systemSha}:${fingerprint.userInfoSha}:${fingerprint.toolsSha}`,
              type: "promptFingerprint",
              status: "completed",
              ...fingerprint,
            },
          });
        }
        return {
          messages: messages as typeof event.messages,
        };
      });
      pi.on("message_start", async (event) => {
        if (event.message.role === "assistant") {
          active.compactionEarlyThreshold = undefined;
          active.compactionUsageSignature = undefined;
        }
        if (event.message.role !== "user" || !active.session) return;
        await compaction.observe({ ...compactionObservation(active), infer });
      });
      pi.on("message_update", async (event) => {
        const update = event.assistantMessageEvent;
        if (!("partial" in update) || !active.compactionRequestMessages) return;
        const partial = update.partial as unknown as BotMessage;
        if (partial.stopReason === "error" || partial.stopReason === "aborted") return;
        const observation = compactionObservation(active);
        const inputTokens = responseTokens(partial, false);
        if (inputTokens <= 0) return;
        // Only consume an explicit provider-reported field. Providers that do
        // not expose it keep the normal headroom policy; no guessed headers.
        const early = partial.earlyCompactionContextTokenThreshold;
        if (isValidBotEarlyThreshold(early, observation.maxTokens) && inputTokens >= early) {
          active.compactionEarlyThreshold = early;
        }
        const signature = `${inputTokens}:${active.compactionEarlyThreshold}`;
        if (signature === active.compactionUsageSignature) return;
        active.compactionUsageSignature = signature;
        await compaction.observe({
          ...observation,
          infer,
          piMessages: active.compactionRequestMessages,
          usedTokens: inputTokens,
          freshUsage: true,
          earlyThreshold: active.compactionEarlyThreshold,
        });
      });
      pi.on("message_end", async (event) => {
        if (event.message.role !== "assistant" || !active.session) return;
        const message = event.message as unknown as BotMessage;
        if (["error", "aborted"].includes(String(message.stopReason))) return;
        const observation = compactionObservation(active);
        const usedTokens = responseTokens(message, true);
        const early = message.earlyCompactionContextTokenThreshold;
        if (
          isValidBotEarlyThreshold(early, observation.maxTokens) &&
          responseTokens(message, false) >= early
        ) {
          active.compactionEarlyThreshold = early;
        }
        await compaction.observe({
          ...observation,
          infer,
          // Pi emits this extension hook before appending the completed message.
          piMessages: [...observation.piMessages, message],
          usedTokens: usedTokens > 0 ? usedTokens : observation.usedTokens,
          freshUsage: usedTokens > 0,
          earlyThreshold: active.compactionEarlyThreshold,
        });
      });
      pi.on("session_before_compact", async (event) => {
        deferredAutomatic = false;
        const observation = compactionObservation(active);
        const prepared = await compaction.beforePiCompaction({
          ...observation,
          piMessages: readPiMessages(),
          readPiMessages,
          reason: event.reason,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: observation.usedTokens ?? event.preparation.tokensBefore,
          infer,
          signal: event.signal,
        });
        deferredAutomatic = event.reason !== "manual" && !prepared;
        return prepared ? { compaction: prepared as never } : { cancel: true };
      });
      pi.on("session_compact", async () => {
        // Counts always describe the durable transcript, including retry errors.
        // The model projection removes this entire prefix on every entry point.
        const piBaseMessageCount = readPiMessages().length;
        const adopted = await compaction.afterPiCompaction({
          contextSessionId: active.contextSessionId,
          piBaseMessageCount,
        });
        if (!adopted) return;
        active.compactionEarlyThreshold = undefined;
        publishCompaction(active, adopted);
        await refreshContext?.(adopted.epoch);
      });
      pi.on("session_compact_failed", async () => {
        if (deferredAutomatic) {
          deferredAutomatic = false;
          return;
        }
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
  if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");

  // The summarization wrapper sends the normal model-visible schemas through
  // a stream-only session. Calling the model runtime directly gives us the same
  // surface while making tool execution structurally impossible.
  const result = await modelRuntime.completeSimple(
    model,
    {
      systemPrompt: botSummarySystemPrompt(request.systemPrompt),
      messages: convertToLlm(fenceToolResults([
        ...(request.userInfoMessage ? [request.userInfoMessage] : []),
        ...request.messagesToSummarize,
        {
          role: "user",
          content: [{ type: "text", text: botSummaryPrompt(request.shorter) }],
          timestamp: Date.now(),
        },
      ] as never) as never),
      tools: (request.tools ?? modelVisibleSummaryTools(customTools(active))) as never,
    },
    {
      signal,
      ...inferenceReasoningOptions(model, active.reasoning),
    }
  );
  if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
  // Pi resolves failed streams to assistant-message values, including partial
  // output. Never let failed prose satisfy the coordinator's success check.
  if (result.stopReason === "aborted")
    throw new DOMException(result.errorMessage ?? "Compaction aborted", "AbortError");
  let responseError: Error | undefined;
  if (result.stopReason === "error" || result.stopReason === "length") {
    responseError = new Error(
      result.errorMessage ??
        (result.stopReason === "length"
          ? "Summary exceeded the output token limit"
          : "Summary provider failed")
    );
    if (result.stopReason === "length") responseError.name = "OutputTokensLimitExceededError";
  }
  // The coordinator owns the special empty-output retry path.
  return botSummaryResponse({
    messages: [result as unknown as BotMessage],
    usage: result.usage as never,
    error: responseError,
  });
}

function publishCompaction(active: ActiveTurn, adopted: BotCompactionEvent): void {
  // Schemas removed by compaction must be discovered again. Still-visible full
  // descriptors can be recovered from the next model projection at invocation.
  active.discoveredDynamicTools.clear();
  active.dynamicDiscoveryMessages = undefined;
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
