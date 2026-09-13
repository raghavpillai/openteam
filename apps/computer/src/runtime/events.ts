import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { BotAgentStore } from "../bot-agent-store";
import { safeToolResult, textFromContent, thinkingFromContent, toolItem } from "./content";
import type { ActiveTurn } from "./types";

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
    if (active.sentMessageCount > 0) {
      active.toolActivityAfterLastSend = true;
    }
    active.toolArgs.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
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
    active.queue.push({
      type: "item.completed",
      turnId: active.turnId,
      item: toolItem(
        event.toolCallId,
        stored?.toolName ?? event.toolName,
        stored?.args ?? {},
        event.isError ? "failed" : "completed",
        safeToolResult(event.result)
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
