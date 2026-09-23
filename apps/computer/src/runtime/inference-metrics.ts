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
      pi.on("before_provider_request", (event, ctx) => {
        const payload = event.payload as {
          model?: string;
          reasoning?: { effort?: string };
          service_tier?: string;
          input?: unknown[];
          tools?: unknown[];
          parallel_tool_calls?: boolean;
        };
        startedAt = performance.now();
        firstDeltaMs = null;
        request = {
          runId,
          ordinal: ++ordinal,
          model: payload.model,
          reasoning: payload.reasoning?.effort,
          serviceTier: payload.service_tier ?? "provider_default",
          inputItems: payload.input?.length,
          toolCount: payload.tools?.length,
          parallelToolCalls: payload.parallel_tool_calls,
          sessionId: ctx.sessionManager.getSessionId(),
        };
      });
      pi.on("message_update", () => {
        if (request && firstDeltaMs === null)
          firstDeltaMs = Math.round(performance.now() - startedAt);
      });
      pi.on("message_end", (event) => {
        if (!request || event.message.role !== "assistant") return;
        const message = event.message;
        console.info(
          JSON.stringify({
            event: "inference.metrics",
            ...request,
            durationMs: Math.round(performance.now() - startedAt),
            firstDeltaMs,
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
    },
  };
}
