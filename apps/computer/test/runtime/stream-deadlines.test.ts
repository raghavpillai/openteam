import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { owesOutputLimitReminder } from "../../src/runtime/prompt-context";
import {
  FIRST_OUTPUT_DEADLINE_MS,
  MODEL_STREAM_WALL_CLOCK_LIMIT_MS,
  streamDeadlines,
  type StreamTimers,
} from "../../src/runtime/stream-deadlines";

/** A clock the test advances by hand. */
const manualClock = () => {
  let now = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  const timers: StreamTimers = {
    set: (callback, ms) => (pending.set(++next, { at: now + ms, callback }), next),
    clear: (handle) => void pending.delete(handle as number),
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at))
      if (timer.at <= now && pending.delete(id)) timer.callback();
    await Bun.sleep(0);
  };
  return { timers, advance, pending };
};

const model: any = { id: "deadline-fixture", api: "openai-completions", provider: "openai" };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: 1 });

/** A provider stream the test drives; it never ends on its own. */
const scripted = () => {
  const streams: Array<ReturnType<typeof createAssistantMessageEventStream>> = [];
  const signals: AbortSignal[] = [];
  const stream = ((_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
    const events = createAssistantMessageEventStream();
    streams.push(events);
    signals.push(options.signal!);
    events.push({ type: "start", partial: message([]) });
    return events;
  }) as any;
  return { stream, streams, signals };
};

const drain = async (stream: AsyncIterable<any> & { result(): Promise<AssistantMessage> }) => {
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  return { types, result: await stream.result() };
};

test("a model call that never starts responding fails with the reference's stall text, and each retry doubles the deadline", async () => {
  const clock = manualClock();
  const deadlines = streamDeadlines(clock.timers);
  const provider = scripted();
  const wrapped = deadlines.wrap(provider.stream);
  deadlines.observe({ type: "agent_start" });
  const first = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS - 1);
  expect(provider.signals[0]!.aborted).toBe(false);
  await clock.advance(1);
  const stalled = await first;
  expect(stalled.types).toEqual(["start", "error"]);
  expect(stalled.result).toMatchObject({ stopReason: "error", errorMessage: "The model provider did not start responding within 150s." });
  expect(provider.signals[0]!.aborted).toBe(true);

  deadlines.observe({ type: "auto_retry_start" });
  deadlines.observe({ type: "agent_start" });
  const retry = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS);
  expect(provider.signals[1]!.aborted).toBe(false);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS);
  expect((await retry).result.errorMessage).toBe("The model provider did not start responding within 300s.");
});

test("the first output clears the deadline for the rest of the attempt, and a new attempt arms it again", async () => {
  const clock = manualClock();
  const deadlines = streamDeadlines(clock.timers);
  const provider = scripted();
  const wrapped = deadlines.wrap(provider.stream);
  deadlines.observe({ type: "agent_start" });
  const first = drain(wrapped(model, {} as any, {}) as any);
  await Bun.sleep(0);
  provider.streams[0]!.push({ type: "text_delta", contentIndex: 0, delta: "On it", partial: message([{ type: "text", text: "On it" }]) });
  await Bun.sleep(0);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS * 2);
  const done = message([{ type: "text", text: "On it" }]);
  provider.streams[0]!.push({ type: "done", reason: "stop", message: done });
  expect((await first).result).toEqual(done);

  // A later step of the same attempt has no first-output deadline.
  const later = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS * 2);
  expect(provider.signals[1]!.aborted).toBe(false);
  provider.streams[1]!.push({ type: "done", reason: "stop", message: done });
  await later;

  deadlines.observe({ type: "agent_start" });
  const next = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(FIRST_OUTPUT_DEADLINE_MS);
  expect((await next).result.errorMessage).toBe("The model provider did not start responding within 150s.");
});

test("a call past the 15-minute wall clock is cut once as an output-limit stop, then fails the turn", async () => {
  const clock = manualClock();
  const deadlines = streamDeadlines(clock.timers);
  const provider = scripted();
  const wrapped = deadlines.wrap(provider.stream);
  deadlines.observe({ type: "agent_start" });
  const first = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(60_000);
  const partial = message([{ type: "text", text: "Writing" }]);
  provider.streams[0]!.push({ type: "text_delta", contentIndex: 0, delta: "Writing", partial });
  await Bun.sleep(0);
  // The clock counts again from the first output.
  await clock.advance(MODEL_STREAM_WALL_CLOCK_LIMIT_MS - 1);
  expect(provider.signals[0]!.aborted).toBe(false);
  await clock.advance(1);
  const cut = (await first).result;
  expect(cut).toMatchObject({ stopReason: "error", errorMessage: "Model stream exceeded the 900000 ms wall-clock limit", content: partial.content });
  expect(provider.signals[0]!.aborted).toBe(true);
  expect(owesOutputLimitReminder([cut] as any, {})).toBe(true);
  expect(owesOutputLimitReminder([cut] as any, { outputLimitReminded: true })).toBe(false);

  // A call that never outputs anything is cut by the same clock once its stall deadline is gone.
  const second = drain(wrapped(model, {} as any, {}) as any);
  await clock.advance(MODEL_STREAM_WALL_CLOCK_LIMIT_MS);
  const failed = (await second).result;
  expect(failed.errorMessage).toBe("Model stream exceeded the 900000 ms wall-clock limit again after one retry");
  expect(owesOutputLimitReminder([failed] as any, {})).toBe(false);
  expect(clock.pending.size).toBe(0);
});

test("a stop passes through as Pi's own abort", async () => {
  const clock = manualClock();
  const deadlines = streamDeadlines(clock.timers);
  const provider = scripted();
  const stop = new AbortController();
  const call = drain(deadlines.wrap(provider.stream)(model, {} as any, { signal: stop.signal }) as any);
  await Bun.sleep(0);
  stop.abort();
  expect(provider.signals[0]!.aborted).toBe(true);
  provider.streams[0]!.push({ type: "error", reason: "aborted", error: message([], "aborted") });
  expect((await call).result.stopReason).toBe("aborted");
  expect(clock.pending.size).toBe(0);
});

test("Pi retries a stalled first call and the turn goes on", async () => {
  const root = await mkdtemp(join(tmpdir(), "stream-stall-"));
  const clock = manualClock();
  const calls: number[] = [];
  let session: any;
  try {
    const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (() => {
      calls.push(calls.length);
      const events = createAssistantMessageEventStream();
      if (calls.length === 2) {
        const done = message([{ type: "text", text: "Recovered." }]);
        queueMicrotask(() => {
          events.push({ type: "text_delta", contentIndex: 0, delta: "Recovered.", partial: done });
          events.push({ type: "done", reason: "stop", message: done });
        });
      }
      return events;
    }) as any;
    const fixture: any = { ...model, name: "Deadline", baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const runtime = new ComputerRuntime() as any;
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => fixture;
    runtime.streamTimers = clock.timers;
    runtime.compactionExtension = () => ({ name: "fixture-compaction", hidden: true, factory() {} });
    runtime.tools = { customTools: () => [], acknowledgeToolOutcomes: async () => {} };
    const active: any = {
      contextSessionId: crypto.randomUUID(), runId: crypto.randomUUID(), modelRef: { providerId: fixture.provider, modelId: fixture.id },
      reasoning: "off", cwd: root, instructions: "Work.", subagentType: null, requestSource: "subagent", userInfoMessage: null,
      pluginAbortController: new AbortController(), queue: { push() {} },
    };
    session = await runtime.createStandaloneSession(root, active.instructions, SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId }), active, active.modelRef);
    const running = session.prompt("Start.");
    for (let i = 0; i < 100 && clock.pending.size < 2; i++) await Bun.sleep(5);
    await clock.advance(FIRST_OUTPUT_DEADLINE_MS);
    await running;
    expect(calls).toHaveLength(2);
    const texts = session.messages.filter((entry: any) => entry.role === "assistant").map((entry: any) => entry.content.map((part: any) => part.text).join(""));
    expect(texts.at(-1)).toBe("Recovered.");
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
