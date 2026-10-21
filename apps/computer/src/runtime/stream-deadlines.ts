import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type StreamFunction = AgentSession["agent"]["streamFunction"];

/** The reference's DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS and per-stream wall clock (15 min). */
export const FIRST_OUTPUT_DEADLINE_MS = 150_000;
export const MODEL_STREAM_WALL_CLOCK_LIMIT_MS = 15 * 60_000;

export const firstOutputStallMessage = (deadlineMs: number) =>
  `The model provider did not start responding within ${Math.round(deadlineMs / 1000)}s.`;
export const wallClockCutMessage = (limitMs = MODEL_STREAM_WALL_CLOCK_LIMIT_MS) =>
  `Model stream exceeded the ${limitMs} ms wall-clock limit`;
export const wallClockLimitMessage = (limitMs = MODEL_STREAM_WALL_CLOCK_LIMIT_MS) =>
  `Model stream exceeded the ${limitMs} ms wall-clock limit again after one retry`;

const FIRST_OUTPUT_STALL = /^The model provider did not start responding within \d+s\.$/;
/** A first-output stall is retried like a transient provider failure, as the reference does. */
export const isFirstOutputStall = (message: { stopReason?: string; errorMessage?: string }) =>
  message.stopReason === "error" && FIRST_OUTPUT_STALL.test(message.errorMessage ?? "");

/** The first wall-clock cut of a turn continues as an output-limit stop. */
export const isWallClockCut = (message: { stopReason?: string; errorMessage?: string }) =>
  message.stopReason === "error" && message.errorMessage === wallClockCutMessage();

/** Model output, as the reference's stream watchdog and wall clock count it. */
const OUTPUT_EVENTS: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_start", "toolcall_delta", "toolcall_end"]);

export interface StreamTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
/** A pending deadline never keeps the process alive. */
const systemTimers: StreamTimers = {
  set: (callback, ms) => setTimeout(callback, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One turn's model stream deadlines, as in the reference:
 * - An attempt (each Pi agent run, including a retry) must produce its first output within
 *   150 s, doubled per retry so far. The deadline clears at the first output and is armed
 *   again only for a later call of the attempt that still has none (after a compaction).
 *   On expiry the call fails with a stall error Pi retries.
 * - Each model call may run 15 minutes, counted again from its first output. The turn's
 *   first cut ends the call as an output-limit stop; the second fails the turn.
 */
export function streamDeadlines(timers: StreamTimers = systemTimers) {
  let outputProduced = false;
  let retries = 0;
  let cuts = 0;
  return {
    observe(event: { type: string }) {
      if (event.type === "agent_start") outputProduced = false;
      else if (event.type === "auto_retry_start") retries += 1;
    },
    wrap(stream: StreamFunction): StreamFunction {
      return (model, context, options) => {
        const output = createAssistantMessageEventStream();
        const local = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
        let partial: AssistantMessage | undefined;
        let settled = false;
        let streaming = false;
        const deadlineMs = FIRST_OUTPUT_DEADLINE_MS * 2 ** retries;
        let stall: unknown;
        let wall: unknown;
        const clear = () => {
          if (stall !== undefined) timers.clear(stall);
          if (wall !== undefined) timers.clear(wall);
          stall = wall = undefined;
        };
        const fail = (errorMessage: string) => {
          if (settled) return;
          settled = true;
          clear();
          local.abort(new Error(errorMessage));
          const error: AssistantMessage = {
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            timestamp: Date.now(), ...partial, stopReason: "error", errorMessage,
          };
          output.push({ type: "error", reason: "error", error });
        };
        const cut = () => {
          cuts += 1;
          fail(cuts === 1 ? wallClockCutMessage() : wallClockLimitMessage());
        };
        // A stop ends the call through the provider's own abort; its deadlines go with it.
        options?.signal?.addEventListener("abort", clear, { once: true });
        if (!outputProduced) stall = timers.set(() => fail(firstOutputStallMessage(deadlineMs)), deadlineMs);
        wall = timers.set(cut, MODEL_STREAM_WALL_CLOCK_LIMIT_MS);
        void (async () => {
          try {
            const inner = await stream(model, context, { ...options, signal });
            for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
              if (settled) return;
              if ("partial" in event) partial = event.partial;
              if (OUTPUT_EVENTS.has(event.type)) {
                outputProduced = true;
                if (stall !== undefined) { timers.clear(stall); stall = undefined; }
                if (!streaming) {
                  streaming = true;
                  if (wall !== undefined) timers.clear(wall);
                  wall = timers.set(cut, MODEL_STREAM_WALL_CLOCK_LIMIT_MS);
                }
              }
              if (event.type === "done" || event.type === "error") {
                settled = true;
                clear();
              }
              output.push(event);
            }
            if (!settled) {
              settled = true;
              clear();
              output.end(await inner.result());
            }
          } catch (error) {
            if (settled) return;
            fail(error instanceof Error ? error.message : String(error));
          }
        })();
        return output;
      };
    },
  };
}

/** Pi retries by error text; a first-output stall is retryable too, as in the reference. */
export function retryFirstOutputStalls(session: AgentSession): void {
  const target = session as unknown as { _isRetryableError?: (message: AssistantMessage) => boolean };
  const retryable = target._isRetryableError?.bind(session);
  if (!retryable) throw new Error("Pi no longer exposes its retry classifier");
  target._isRetryableError = (message) => isFirstOutputStall(message) || retryable(message);
}
