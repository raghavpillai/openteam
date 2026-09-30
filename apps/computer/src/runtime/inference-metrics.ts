import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";

/** Content-free timings: never log prompts, output, headers, or credentials. */
export function inferenceMetricsExtension(runId: string): {
  name: string;
  hidden: boolean;
  factory: ExtensionFactory;
} {
  return {
    name: "openteam-inference-metrics",
    hidden: true,
    factory(pi) {
      let request: Record<string, unknown> | null = null;
      let startedAt = 0;
      let firstDeltaMs: number | null = null;
      let ordinal = 0;
      let updates = 0;
      let lastUpdateAt = 0;
      let textCharacters = 0;
      let thinkingCharacters = 0;
      let toolArgumentCharacters = 0;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const stopProgress = () => {
        if (progressTimer !== undefined) clearInterval(progressTimer);
        progressTimer = undefined;
      };
      const progress = () => ({
        updates, textCharacters, thinkingCharacters, toolArgumentCharacters,
        lastUpdateMs: updates ? Math.round(lastUpdateAt - startedAt) : null,
        idleMs: Math.round(performance.now() - (updates ? lastUpdateAt : startedAt)),
      });
      pi.on("before_provider_request", (event, ctx) => {
        const payload = event.payload as {
          model?: string;
          reasoning?: { effort?: string };
          service_tier?: string;
          input?: unknown[];
          messages?: unknown[];
          tools?: unknown[];
          parallel_tool_calls?: boolean;
        };
        stopProgress();
        startedAt = performance.now();
        firstDeltaMs = null;
        updates = textCharacters = thinkingCharacters = toolArgumentCharacters = 0;
        lastUpdateAt = startedAt;
        request = {
          runId,
          ordinal: ++ordinal,
          model: payload.model,
          reasoning: payload.reasoning?.effort,
          serviceTier: payload.service_tier ?? "provider_default",
          inputItems: payload.input?.length ?? payload.messages?.length,
          toolCount: payload.tools?.length,
          parallelToolCalls: payload.parallel_tool_calls,
          sessionId: ctx.sessionManager.getSessionId(),
        };
        console.info(JSON.stringify({ event: "inference.started", ...request }));
        progressTimer = setInterval(() => {
          if (request) console.info(JSON.stringify({ event: "inference.progress", ...request,
            durationMs: Math.round(performance.now() - startedAt), ...progress() }));
        }, 30_000);
        progressTimer.unref?.();
      });
      pi.on("message_update", (event) => {
        if (!request) return;
        updates++;
        lastUpdateAt = performance.now();
        const delta = event.assistantMessageEvent;
        // Count only lengths; never retain or emit streamed content, including
        // reasoning and partial tool arguments which may contain private data.
        if (delta?.type === "text_delta") textCharacters += delta.delta.length;
        if (delta?.type === "thinking_delta") thinkingCharacters += delta.delta.length;
        if (delta?.type === "toolcall_delta") toolArgumentCharacters += delta.delta.length;
        const hasOutput = (delta?.type === "text_delta" || delta?.type === "thinking_delta"
          || delta?.type === "toolcall_delta") && delta.delta.length > 0;
        if (hasOutput && firstDeltaMs === null) {
          firstDeltaMs = Math.round(performance.now() - startedAt);
          console.info(JSON.stringify({ event: "inference.first_delta", ...request, firstDeltaMs }));
        }
      });
      pi.on("message_end", (event) => {
        if (!request || event.message.role !== "assistant") return;
        stopProgress();
        const message = event.message;
        console.info(
          JSON.stringify({
            event: "inference.metrics",
            ...request,
            durationMs: Math.round(performance.now() - startedAt),
            firstDeltaMs,
            responseId: message.responseId,
            ...progress(),
            stopReason: message.stopReason,
            inputTokens: message.usage.input,
            cachedInputTokens: message.usage.cacheRead,
            outputTokens: message.usage.output,
            reasoningTokens: message.usage.reasoning,
            toolCalls: message.content.filter((part) => part.type === "toolCall").length,
            transport: getOpenAICodexWebSocketDebugStats(String(request.sessionId)),
          })
        );
        request = null;
      });
      const stop = () => { stopProgress(); request = null; };
      pi.on("agent_end", stop);
      pi.on("session_shutdown", stop);
    },
  };
}
