import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { BotAgentStore } from "../bot-agent-store";
import { safeToolResult, textFromContent, thinkingFromContent, toolItem } from "./content";
import type { ActiveTurn } from "./types";

function isBackgroundStatusCheck(toolName: string, args: unknown): boolean {
  if (toolName === "CheckSubagent") return true;
  if (toolName !== "CallDynamicTool" || !args || typeof args !== "object") return false;
  const input = args as Record<string, unknown>;
  return input.namespace === "cursor" && input.toolName === "CheckSubagent";
}

export function startAgentMessage(active: ActiveTurn, itemId: string): void {
  if (active.startedItems.has(itemId)) return;
  active.startedItems.add(itemId);
  active.queue.push({
    type: "item.started",
    turnId: active.turnId,
    item: {
      type: "agentMessage",
      id: itemId,
      text: "",
      status: "inProgress",
    },
  });
}

export function attachSession(active: ActiveTurn): void {
  if (
    active.sessionAttached ||
    !active.session ||
    !active.sessionPath ||
    !existsSync(active.sessionPath)
  ) {
    return;
  }
  active.sessionAttached = true;
  active.queue.push({
    type: "session.attached",
    runtimeEngine: "pi",
    inferenceProvider: active.modelRef.providerId,
    contextSessionId: active.contextSessionId,
    sessionId: active.session.sessionId,
    sessionPath: active.sessionPath,
    model: active.modelRef.modelId,
  });
}

export function startReasoning(active: ActiveTurn, itemId: string): void {
  if (active.startedItems.has(itemId)) return;
  active.startedItems.add(itemId);
  active.queue.push({
    type: "item.started",
    turnId: active.turnId,
    item: { type: "reasoning", id: itemId, text: "", status: "inProgress" },
  });
}

export function routeEvent(
  botStore: BotAgentStore | undefined,
  active: ActiveTurn,
  event: AgentSessionEvent
): void {
  if (event.type === "message_start") {
    const message = event.message as { role?: string };
    if (message.role === "assistant") {
      active.assistantOrdinal += 1;
      active.currentAssistantId = `assistant:${active.runId}:${active.assistantOrdinal}`;
      active.currentReasoningId = `reasoning:${active.runId}:${active.assistantOrdinal}`;
    }
    return;
  }

  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && active.currentAssistantId) {
      startAgentMessage(active, active.currentAssistantId);
      active.queue.push({
        type: "agent.delta",
        turnId: active.turnId,
        itemId: active.currentAssistantId,
        delta: update.delta,
      });
    }
    return;
  }

  if (event.type === "message_end") {
    const message = event.message as {
      role?: string;
      content?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role === "user") {
      if (!active.initialUserStarted) {
        if (active.initialUserClientId) active.session?.sessionManager.appendCustomEntry("openteam-input-receipt", { messageId: `input:${active.initialUserClientId}` });
        active.initialUserStarted = true;
        active.queue.push({ type: "prompt.delivered", turnId: active.turnId });
        return;
      }
      const steer = active.pendingSteers.shift();
      if (steer) {
        active.session?.sessionManager?.appendCustomEntry("openteam-input-receipt", { messageId: `input:${steer.clientMessageId}` });
        active.queue.push({
          type: "input.delivered",
          turnId: active.turnId,
          inboxId: steer.inboxId,
          clientMessageId: steer.clientMessageId,
        });
      }
      return;
    }
    if (message.role !== "assistant") return;
    // Capture the finite delivery batch before any tool executes. A text reply
    // ending the turn must not discard attachments already emitted with it.
    if (!active.endTurnRequested) {
      active.finishDeliveryAttachments = false;
      active.pendingDeliveryAttachments = new Map();
      active.pendingDeliveryCleanup = new Map();
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (part?.type === "toolCall" && part.name === "SendToUser" &&
            part.arguments?.type === "attachment" && typeof part.id === "string") {
          active.pendingDeliveryAttachments.set(part.id, JSON.stringify(part.arguments));
        }
        if (part?.type === "toolCall" && part.name === "CallDynamicTool" &&
            part.arguments?.namespace === "cursor" && part.arguments?.toolName === "StopSubagent" &&
            typeof part.id === "string") {
          active.pendingDeliveryCleanup.set(part.id, JSON.stringify(part.arguments));
        }
      }
    }
    active.lastStopReason = message.stopReason ?? null;
    active.lastErrorMessage = message.errorMessage ?? null;
    const text = textFromContent(message.content);
    void botStore?.appendConversationEnvelope(active.botId, {
      role: "assistant",
      content: message.content,
      stopReason: message.stopReason ?? null,
      contextSessionId: active.contextSessionId,
      turnId: active.turnId,
    });
    if (text && active.currentAssistantId) {
      startAgentMessage(active, active.currentAssistantId);
      active.queue.push({
        type: "item.completed",
        turnId: active.turnId,
        item: {
          type: "agentMessage",
          id: active.currentAssistantId,
          text,
          status: "completed",
        },
      });
    }
    const thinking = thinkingFromContent(message.content);
    if (thinking && active.currentReasoningId) {
      startReasoning(active, active.currentReasoningId);
      active.queue.push({
        type: "item.completed",
        turnId: active.turnId,
        item: {
          type: "reasoning",
          id: active.currentReasoningId,
          text: thinking,
          status: "completed",
        },
      });
    }
    if (message.stopReason === "error" && message.errorMessage) {
      active.queue.push({
        type: "runtime.error",
        turnId: active.turnId,
        message: message.errorMessage,
        retrying: false,
      });
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    // Schema discovery and a status-only poll may leave an already-announced
    // background handoff intact. Loading metadata does not produce a task result.
    // Defer its delivery obligation until the host's result proves it is pending.
    const deliveryCleanup = active.endTurnRequested === true && active.finishDeliveryAttachments === true &&
      event.toolName === "CallDynamicTool" &&
      active.pendingDeliveryCleanup?.get(event.toolCallId) === JSON.stringify(event.args);
    if (active.sentMessageCount > 0 && !deliveryCleanup && event.toolName !== "GetDynamicTools" && !isBackgroundStatusCheck(event.toolName, event.args)) {
      active.toolActivityAfterLastSend = true;
    }
    active.toolArgs.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      deliveryCleanup,
    });
    active.queue.push({
      type: "item.started",
      turnId: active.turnId,
      item: toolItem(event.toolCallId, event.toolName, event.args, "inProgress"),
    });
    return;
  }

  if (event.type === "tool_execution_end") {
    const stored = active.toolArgs.get(event.toolCallId);
    if (stored?.toolName === "GetDynamicTools" && active.sentMessageCount > 0) {
      const result = event.result as {isError?: boolean} | undefined;
      if (event.isError || result?.isError) active.toolActivityAfterLastSend = true;
      // Successful discovery never clears earlier work or a failed delivery.
    }
    if (stored?.deliveryCleanup) {
      const result = event.result as {details?: {deliveryCleanup?: boolean}; isError?: boolean} | undefined;
      if (event.isError || result?.isError || result?.details?.deliveryCleanup !== true)
        active.toolActivityAfterLastSend = true;
    }
    if (stored && isBackgroundStatusCheck(stored.toolName, stored.args) && active.sentMessageCount > 0) {
      const result = event.result as {details?: {tool?: string; pendingBackgroundWork?: boolean}} | undefined;
      if (event.isError || result?.details?.tool !== "CheckSubagent" || result.details.pendingBackgroundWork !== true) {
        active.toolActivityAfterLastSend = true;
      }
      // Never clear prior/concurrent activity: a pending worker cannot excuse
      // another undelivered result or a failed SendToUser call.
    }
    active.queue.push({
      type: "item.completed",
      turnId: active.turnId,
      item: toolItem(
        event.toolCallId,
        stored?.toolName ?? event.toolName,
        stored?.args ?? {},
        event.isError ? "failed" : "completed",
        safeToolResult(event.result, event.isError)
      ),
    });
    active.toolArgs.delete(event.toolCallId);
    return;
  }

  if (event.type === "auto_retry_start") {
    active.queue.push({
      type: "runtime.error",
      turnId: active.turnId,
      message: event.errorMessage,
      retrying: true,
    });
  }
}
