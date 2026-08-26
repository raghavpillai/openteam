import { describe, expect, test } from "bun:test";
import { ComputerRuntime } from "../src/runtime";

describe("live Pi steering", () => {
  test("deduplicates accepted inputs and acknowledges them when Pi inserts the user message", async () => {
    const runtime = new ComputerRuntime();
    const events: unknown[] = [];
    const prompts: Array<{ content: string; options: unknown }> = [];
    const active = {
      runId: "run-1",
      turnId: "run-1",
      initialUserStarted: false,
      pendingSteers: [],
      acceptedSteerIds: new Set<string>(),
      queue: { push: (event: unknown) => events.push(event) },
      session: {
        isStreaming: true,
        prompt: async (content: string, options: unknown) => {
          prompts.push({ content, options });
        },
      },
    };
    const internals = runtime as unknown as {
      activeByRun: Map<string, typeof active>;
      routeEvent: (turn: typeof active, event: unknown) => void;
    };
    internals.activeByRun.set(active.runId, active);
    const input = {
      inboxId: "inbox-1",
      clientMessageId: "message-1",
      content: "Redirect the work",
    };

    await runtime.steer(active.runId, input);
    await runtime.steer(active.runId, input);
    expect(prompts).toEqual([
      {
        content: "Redirect the work",
        options: { source: "rpc", streamingBehavior: "steer" },
      },
    ]);

    internals.routeEvent(active, { type: "message_start", message: { role: "user" } });
    expect(events).toEqual([]);
    internals.routeEvent(active, { type: "message_start", message: { role: "user" } });
    expect(events).toEqual([
      {
        type: "input.delivered",
        turnId: "run-1",
        inboxId: "inbox-1",
        clientMessageId: "message-1",
      },
    ]);
  });

  test("rejects steering after the active Pi stream has ended", async () => {
    const runtime = new ComputerRuntime();
    const active = {
      session: { isStreaming: false },
    };
    const internals = runtime as unknown as {
      activeByRun: Map<string, typeof active>;
    };
    internals.activeByRun.set("run-1", active);

    await expect(
      runtime.steer("run-1", {
        inboxId: "inbox-1",
        clientMessageId: "message-1",
        content: "Too late",
      })
    ).rejects.toThrow("Run is not actively processing a Pi turn");
  });
});
