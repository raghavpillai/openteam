import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ComputerRuntime } from "../../src/runtime";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
const model: Model<"openai-completions"> = {
  id: "parity-fixture",
  name: "Parity fixture",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://offline.invalid/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// Typed messages supersede a main turn instead of steering it.
for (const { handoff, batch = false } of [{ handoff: false }, { handoff: true }, { handoff: false, batch: true }])
  test(`real Pi loop persists before acknowledgement, stops on ${handoff ? "WakeParent" : "end_turn"}, and recovers tape${batch ? " with three ordered replies" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-parity-"));
    const requests: any[] = [];
    const sent: any[] = [];
    const acknowledged: any[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as any;
        sent.push(input);
        return Response.json(handoff ? { woken: true, run_id: "parent-wake" } : { sent: true, message_id: `delivery-${sent.length}` });
      },
    });
    let session: AgentSession | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.checkAuth = async () => ({ type: "api_key" });
      modelRuntime.streamSimple = (_model, context, options) =>
        streamSimple(model, context, {
          ...options,
          apiKey: "synthetic-fixture",
          maxRetries: 0,
          fetch: (async (_url: any, init: any) => {
            // Pi used to delay first-write until an assistant existed. This assertion
            // runs inside the actual provider call, before the first assistant arrives.
            expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(
              "<user_query>Read the result</user_query>"
            );
            requests.push(JSON.parse(await new Response(init.body).text()));
            const toolId = `send-${requests.length}`;
            const chunks = [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: toolId,
                          type: "function",
                          function: {
                            name: handoff ? "WakeParent" : "SendToUser",
                            arguments: JSON.stringify(handoff ? {
                              message: "Fixture result: notify the user.",
                            } : {
                              type: "text",
                              content: "Fixture result",
                              end_turn: true,
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              },
            ];
            if (batch) {
              const delta = chunks[0]!.choices[0]!.delta!;
              if (!("tool_calls" in delta)) throw new Error("Missing fixture tool calls");
              const first = delta.tool_calls![0]!;
              delta.tool_calls = Array.from({ length: 3 }, (_, index) => ({
                ...first,
                index,
                id: index === 0 ? toolId : `${toolId}-${index}`,
                function: {
                  name: "SendToUser",
                  arguments: JSON.stringify({ type: "text", content: `Batch ${index + 1}`, end_turn: index === 2 }),
                },
              }));
            }
            return new Response(
              chunks
                .map(
                  (chunk) =>
                    `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`
                )
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } }
            );
          }) as typeof fetch,
        });
      const runtime = new ComputerRuntime();
      const internals = runtime as any;
      internals.agentDir = root;
      internals.modelRuntime = modelRuntime;
      internals.resolveModel = () => model;
      const toolHost = new RuntimeTools(
        {} as never,
        server.url.origin,
        "synthetic-control-token",
        root,
        root
      );
      internals.tools = toolHost;
      internals.compactionExtension = () => ({
        name: "fixture-compaction",
        hidden: true,
        factory() {},
      });
      const active = {
        runId: crypto.randomUUID(),
        botId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        contextSessionId: crypto.randomUUID(),
        channelId: crypto.randomUUID(),
        deliveryId: null,
        runtimeProfile: "agent",
        requestSource: handoff ? "automation" : "turn",
        subagentType: null,
        pluginNamespaces: [],
        sentMessageCount: 0,
        reasoning: "off",
        cwd: root,
        endTurnRequested: false,
        initialUserStarted: false,
        initialUserClientId: "fixture-user",
        queue: { push: (event: any) => acknowledged.push(event) },
      } as unknown as ActiveTurn;
      const sessions = join(root, "sessions");
      await mkdir(sessions);
      const manager = SessionManager.create(root, sessions, { id: active.contextSessionId });
      session = await internals.createStandaloneSession(
        root,
        "System fixture: verified instructions",
        manager,
        active,
        { providerId: model.provider, modelId: model.id }
      );
      active.session = session!;
      internals.activeByRun.set(active.runId, active);
      session!.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "user") {
          expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("Read the result");
          internals.routeEvent(active, event);
        }
      });
      internals.bindTurnStop(active, session!);
      await session!.sendCustomMessage(
        {
          customType: "openteam-ambient",
          content: "[SAND_HIDDEN_PROMPT]A background job completed.",
          display: false,
          details: { messageId: "ambient-fixture" },
        },
        { triggerTurn: false }
      );
      const running = session!.prompt("<user_query>Read the result</user_query>");
      await running;
      expect(acknowledged.filter((event) => event.type === "prompt.delivered")).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(sent).toHaveLength(batch ? 3 : 1);
      if (batch) expect(sent.map(call => call.arguments.content)).toEqual(["Batch 1", "Batch 2", "Batch 3"]);
      expect(active.endTurnRequested).toBe(true);
      if (handoff) {
        expect(active.sentMessageCount).toBe(0);
        expect(sent[0]).toMatchObject({ tool: "WakeParent", arguments: { message: "Fixture result: notify the user." } });
        const shell = toolHost.customTools(active).find((tool) => tool.name === "Shell")!;
        await expect(shell.execute("too-late", { command: "false" }, undefined, undefined, {} as never)).rejects.toThrow("turn has ended");
      }
      const payload = requests[0];
      expect(payload.messages[0].content).toContain("System fixture: verified instructions");
      const messages = payload.messages.filter((message: any) => message.role === "user");
      expect(JSON.stringify(messages)).toContain("A background job completed.");
      expect(JSON.stringify(messages)).toContain("<user_query>Read the result</user_query>");
      expect(payload.tools.some((tool: any) => tool.function.name === "CallDynamicTool")).toBe(
        true
      );
      const tape = session!.messages;
      expect(
        tape.some(
          (message: any) => message.role === "toolResult" && message.toolCallId === "send-1"
        )
      ).toBe(true);
      const path = manager.getSessionFile()!;
      session!.dispose();
      session = undefined;
      const reopened = SessionManager.open(path);
      const restored = reopened.buildSessionContext().messages;
      expect(
        restored.some(
          (message: any) => message.role === "toolResult" && message.toolCallId === "send-1"
        )
      ).toBe(true);
      expect(
        restored.filter(
          (message: any) =>
            message.role === "custom" && message.details?.messageId === "ambient-fixture"
        )
      ).toHaveLength(1);
      expect((await readFile(path, "utf8")).includes("synthetic-control-token")).toBe(false);
      expect(
        reopened
          .getEntries()
          .filter(
            (entry: any) => entry.type === "custom" && entry.customType === "openteam-input-receipt"
          )
      ).toHaveLength(1);
      if (process.env.OPENTEAM_PARITY_ARTIFACT_DIR && !handoff) {
        const { writeFile } = await import("node:fs/promises");
        await mkdir(process.env.OPENTEAM_PARITY_ARTIFACT_DIR, { recursive: true });
        await writeFile(
          join(process.env.OPENTEAM_PARITY_ARTIFACT_DIR, "provider-request.json"),
          JSON.stringify(payload, null, 2)
        );
        await writeFile(
          join(process.env.OPENTEAM_PARITY_ARTIFACT_DIR, "pi-session.jsonl"),
          await readFile(path, "utf8")
        );
      }
    } finally {
      session?.dispose();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

const CLOSINGS = {
  reply: { name: "SendToUser", arguments: { type: "text", content: "I'll check back at 1:10 PM.", end_turn: true } },
  reaction: { name: "ReactToMessage", arguments: { message_address: "t1u", emoji: "\u{1F44D}", end_turn: true } },
  question: { name: "SendToUser", arguments: { type: "widget", widget: { prompt: "Check back at 1:10 PM?", options: [{ label: "Yes", value: "yes", style: "primary" }] } } },
} as const;
for (const { closing, failures, thenStop = false } of [
  { closing: "reply", failures: 0 }, { closing: "reply", failures: 1, thenStop: true }, { closing: "reply", failures: 3 },
  { closing: "reaction", failures: 0 }, { closing: "reaction", failures: 1, thenStop: true },
  { closing: "question", failures: 0 }, { closing: "question", failures: 1 },
] as const)
  test(`real Pi loop runs calls alongside a closing ${closing}${!failures ? "" : closing === "question" ? ", never holding a turn that asked" : `, holding the turn after ${thenStop ? "one failure" : "repeated failures"}`}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-end-turn-hold-"));
    const requests: any[] = [];
    const host: any[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as any;
        host.push(input);
        if (input.tool === "UpdateRoutine")
          return host.filter(call => call.tool === "UpdateRoutine").length <= failures
            ? Response.json({ error: { message: "Schedule rejected" } }, { status: 400 })
            : Response.json({ saved: true, id: "check-back" });
        if (input.tool === "ReactToMessage") return Response.json({ reacted: true });
        return Response.json({ sent: true, message_id: `delivery-${host.length}` });
      },
    });
    let session: AgentSession | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
      modelRuntime.checkAuth = async () => ({ type: "api_key" });
      modelRuntime.streamSimple = (_model, context, options) =>
        streamSimple(model, context, {
          ...options,
          apiKey: "synthetic-fixture",
          maxRetries: 0,
          fetch: (async (_url: any, init: any) => {
            requests.push(JSON.parse(await new Response(init.body).text()));
            const step = requests.length;
            const delta = thenStop && step > 1
              ? { role: "assistant", content: "The reply already went out." }
              : { role: "assistant", tool_calls: [
                  { index: 0, id: `reply-${step}`, type: "function", function: { name: CLOSINGS[closing].name,
                    arguments: JSON.stringify(CLOSINGS[closing].arguments) } },
                  { index: 1, id: `routine-${step}`, type: "function", function: { name: "UpdateRoutine",
                    arguments: JSON.stringify({ action: "create", name: "Check back",
                      prompt: "Check the support case and tell the user in this chat.", schedule: "10 13 18 10 *" }) } },
                ] };
            const chunks = [
              { choices: [{ index: 0, delta, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
            ];
            return new Response(
              chunks.map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } }
            );
          }) as typeof fetch,
        });
      const runtime = new ComputerRuntime();
      const internals = runtime as any;
      internals.agentDir = root;
      internals.modelRuntime = modelRuntime;
      internals.resolveModel = () => model;
      internals.tools = new RuntimeTools({} as never, server.url.origin, "synthetic-control-token", root, root);
      internals.compactionExtension = () => ({ name: "fixture-compaction", hidden: true, factory() {} });
      const active = {
        runId: crypto.randomUUID(), botId: crypto.randomUUID(), turnId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(), contextSessionId: crypto.randomUUID(), channelId: crypto.randomUUID(),
        deliveryId: null, runtimeProfile: "agent", requestSource: "turn", subagentType: null,
        pluginNamespaces: [], discoveredDynamicTools: new Set(), sentMessageCount: 0, reasoning: "off", cwd: root,
        endTurnRequested: false, initialUserStarted: true, pendingSteers: [], acceptedSteerIds: new Set(),
        assistantOrdinal: 0, startedItems: new Set(), toolArgs: new Map(), queue: { push() {} },
      } as unknown as ActiveTurn;
      const sessions = join(root, "sessions");
      await mkdir(sessions);
      const manager = SessionManager.create(root, sessions, { id: active.contextSessionId });
      session = await internals.createStandaloneSession(root, "System fixture", manager, active, { providerId: model.provider, modelId: model.id });
      active.session = session!;
      session!.subscribe((event) => internals.routeEvent(active, event));
      internals.bindTurnStop(active, session!);
      await session!.prompt("<user_query>Check back on my support case at 1:10</user_query>");

      const holds = closing === "question" ? 0 : thenStop ? 1 : Math.min(failures, 2);
      expect(requests).toHaveLength(1 + holds);
      expect(active.endTurnHolds ?? 0).toBe(holds);
      // Every call the closing response made reached the host; the calls run in parallel, so in either order.
      const responses = thenStop ? 1 : 1 + holds;
      expect(host.map((call) => call.tool).sort()).toEqual(Array.from({ length: responses }, () => [CLOSINGS[closing].name, "UpdateRoutine"]).flat().sort());
      const reminder = "Your turn did not end. This end_turn call succeeded, but a call alongside it failed";
      expect(JSON.stringify(requests[0])).not.toContain(reminder);
      for (const [index, request] of requests.slice(1).entries()) {
        const text = JSON.stringify(request.messages);
        expect(text.split(reminder).length - 1).toBe(index + 1);
        expect(text).toContain("Schedule rejected");
      }
      // As in the reference, the reminder rides on the closing call's own result, not a separate message.
      for (const [index, request] of requests.slice(1).entries()) {
        const closingResult = request.messages.find((message: any) => message.role === "tool" && message.tool_call_id === `reply-${index + 1}`);
        expect(JSON.stringify(closingResult)).toContain(reminder);
        expect(request.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
      }
      // The saved session keeps it on that result too.
      const saved = manager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" &&
        JSON.stringify(entry.message.details?.systemReminders ?? []).includes(reminder));
      expect(saved.map((entry: any) => entry.message.toolCallId)).toEqual(Array.from({ length: holds }, (_, index) => `reply-${index + 1}`));
      if (thenStop) {
        expect(active.endTurnRequested).toBe(false);
      } else {
        // A clean close, one past the hold limit, or a question settles like any end_turn.
        expect(active.endTurnRequested).toBe(true);
        expect(active.awaitingUser === true).toBe(closing === "question");
      }
    } finally {
      session?.dispose();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
