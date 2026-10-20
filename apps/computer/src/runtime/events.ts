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

const isBackgroundDispatch = (toolName: string, args: unknown): boolean =>
  toolName === "Task" && (args as { run_in_background?: unknown } | null)?.run_in_background !== false;

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
    // Capture the response's calls before any executes. A send that ends the
    // turn still runs the calls emitted with it, once each; later responses get none.
    active.pendingResponseCalls = new Map();
    active.failedResponseCalls = [];
    active.failedResponseSends = new Set();
    if (!active.endTurnRequested) {
      active.finishResponseCalls = false;
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (part?.type === "toolCall" && typeof part.id === "string")
          active.pendingResponseCalls.set(part.id, JSON.stringify(part.arguments));
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
    // A call emitted with the closing reply owes nothing more unless it fails.
    const responseCall = active.pendingResponseCalls?.get(event.toolCallId) === JSON.stringify(event.args);
    const afterEndTurn = responseCall && active.endTurnRequested === true && active.finishResponseCalls === true;
    if (active.sentMessageCount > 0 && !afterEndTurn && event.toolName !== "GetDynamicTools" &&
        !isBackgroundStatusCheck(event.toolName, event.args) && !isBackgroundDispatch(event.toolName, event.args)) {
      active.toolActivityAfterLastSend = true;
    }
    active.toolArgs.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      responseCall,
      afterEndTurn,
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
    const failed = event.isError || (event.result as {isError?: boolean} | undefined)?.isError === true;
    if (stored?.responseCall && failed) active.failedResponseCalls?.push(event.toolCallId);
    if (stored?.afterEndTurn && failed) active.toolActivityAfterLastSend = true;
    const background = stored && (isBackgroundStatusCheck(stored.toolName, stored.args)
      ? "CheckSubagent" : isBackgroundDispatch(stored.toolName, stored.args) ? "Task" : null);
    if (background && active.sentMessageCount > 0) {
      const result = event.result as {details?: {tool?: string; pendingBackgroundWork?: boolean}} | undefined;
      if (event.isError || result?.details?.tool !== background || result.details.pendingBackgroundWork !== true) {
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
