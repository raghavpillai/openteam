import { describe, test, expect } from "bun:test";
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

describe("sibling closing calls", () => {
  const CLOSINGS = {
    reply: { name: "SendToUser", arguments: { type: "text", content: "I'll check back at 1:10 PM.", end_turn: true } },
    reaction: { name: "ReactToMessage", arguments: { message_address: "t1u", emoji: "\u{1F44D}", end_turn: true } },
    question: { name: "SendToUser", arguments: { type: "widget", widget: { prompt: "Check back at 1:10 PM?", options: [{ label: "Yes", value: "yes", style: "primary" }] } } },
    form: { name: "RequestUserForm", arguments: { title: "Delivery city", instruction: "Enter the city", domain: "example.com",
      fields: [{ id: "city", label: "City", type: "text", target: { kind: "ref", value: "e1" } }] } },
    aliasReply: { name: "CallDynamicTool", arguments: { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "Second result", end_turn: true } } },
    aliasQuestion: { name: "CallDynamicTool", arguments: { namespace: "cursor", toolName: "SendToUser", arguments: { type: "widget",
      widget: { prompt: "Continue?", options: [{ label: "Yes", value: "yes" }] } } } },
  } as const;
  const cases: { closings: (keyof typeof CLOSINGS)[]; failures?: number; routineDelay?: number; closingDelays?: number[]; failedSend?: number; failedClosing?: number; connectorFailure?: boolean; extraRoutine?: boolean; cancelOnSend?: number }[] = [
    { closings: ["reply", "reply"] },
    { closings: ["reply", "reply", "reply"] },
    { closings: ["reaction", "reaction"] },
    { closings: ["reaction", "reply"] },
    { closings: ["reply", "reaction"] },
    { closings: ["reply", "reaction", "reply"] },
    { closings: ["reply", "reply"], failures: 1 },
    { closings: ["reaction", "reaction"], failures: 1 },
    { closings: ["reaction", "reply"], failures: 1, routineDelay: 80 },
    { closings: ["reply", "reaction"], failures: 1, routineDelay: 80 },
    { closings: ["reply", "reaction", "reply"], failures: 1, routineDelay: 80 },
    { closings: ["reply", "question"], failures: 1 },
    { closings: ["question", "reply"], failures: 1 },
    { closings: ["reaction", "question"], failures: 1, routineDelay: 80 },
    { closings: ["question", "reaction"], failures: 1, routineDelay: 80 },
    { closings: ["reply", "question", "reply"], failures: 1, routineDelay: 80 },
    { closings: ["reply", "reaction"], failedSend: 0 },
    { closings: ["reaction", "reply"], failedSend: 1 },
    { closings: ["question", "reply"], failedSend: 1 },
    { closings: ["reaction"], connectorFailure: true, routineDelay: 80 },
    { closings: ["reaction", "reply"], connectorFailure: true, routineDelay: 80 },
    { closings: ["question", "reaction"], connectorFailure: true, routineDelay: 80 },
    { closings: ["reply"], extraRoutine: true, routineDelay: 80 },
    { closings: ["reaction"], extraRoutine: true, routineDelay: 80 },
    { closings: ["reply", "form"], failures: 1, closingDelays: [80, 0] },
    { closings: ["form", "reply"], failures: 1, closingDelays: [0, 80] },
    { closings: ["reaction", "form"], failures: 1, closingDelays: [80, 0] },
    { closings: ["form", "reaction"], failures: 1, closingDelays: [0, 80] },
    { closings: ["reply", "reply"], cancelOnSend: 1 },
    { closings: ["reaction", "reply"], cancelOnSend: 1 },
    { closings: ["reply", "aliasReply"] },
    { closings: ["reply", "aliasReply", "reply"] },
    { closings: ["reply", "aliasQuestion"] },
  ];
  for (const closingDelays of [[0, 40, 80], [0, 80, 40], [40, 0, 80], [40, 80, 0], [80, 0, 40], [80, 40, 0]])
    {
      for (const failures of [0, 1]) for (const routineDelay of [0, 120])
        cases.push({ closings: ["reaction", "reply", "reaction"], closingDelays, failures, routineDelay });
      for (const failedClosing of [0, 2])
        cases.push({ closings: ["reaction", "reply", "reaction"], closingDelays, failedClosing });
    }
  for (const { closings, failures = 0, routineDelay = 0, closingDelays, failedSend, failedClosing, connectorFailure, extraRoutine, cancelOnSend } of cases)
    test(`real Pi loop settles sibling closing calls ${closings.join("+")} with ${failures} failure${routineDelay ? " arriving late" : ""}${closingDelays ? ` delays ${closingDelays.join("/")}` : ""}${failedSend !== undefined ? ` undelivered send ${failedSend}` : ""}${failedClosing !== undefined ? ` rejected closing ${failedClosing}` : ""}${connectorFailure ? " connector error receipt" : ""}${extraRoutine ? " queued mutation sibling" : ""}${cancelOnSend !== undefined ? " interrupted batch" : ""}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-end-turn-hold-"));
      const requests: any[] = [];
      const host: any[] = [];
      const completedClosings: string[] = [];
      let stopTurn: (() => void) | undefined;
      let stopPromise: Promise<void> | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const input = (await request.json()) as any;
          host.push(input);
          if (String(input.callId).startsWith("closing-")) {
            const index = Number(String(input.callId).split("-").at(-1));
            if (index === cancelOnSend) { stopTurn!(); await Bun.sleep(80); }
            const delay = closingDelays?.[index] ?? index * 25;
            if (delay) await Bun.sleep(delay);
            if (index === failedSend)
              return Response.json({ sent: false, delivery_failed: true, channel: "slack:C123", reason: "channel_not_found" });
            if (index === failedClosing)
              return Response.json({ error: { message: "Closing rejected" } }, { status: 400 });
            completedClosings.push(input.callId);
          } else if (routineDelay) await Bun.sleep(routineDelay);
          if (input.tool === "PluginCall")
            return Response.json({ isError: !!connectorFailure, content: [{ type: "text", text: connectorFailure ? "Connector refused operation; do not retry." : "Case read successfully." }] });
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
              const delta = step > 1
                ? { role: "assistant", content: "The reply already went out." }
                : { role: "assistant", tool_calls: [
                    ...closings.map((closing, index) => ({ index, id: `closing-${index}`, type: "function", function: {
                      name: CLOSINGS[closing].name, arguments: JSON.stringify(CLOSINGS[closing].arguments),
                    } })),
                    { index: closings.length, id: "routine", type: "function", function: connectorFailure || extraRoutine
                      ? { name: "CallDynamicTool", arguments: JSON.stringify({ namespace: "fixture", toolName: "read_case", arguments: {} }) }
                      : { name: "UpdateRoutine", arguments: JSON.stringify({ action: "create", name: "Check back",
                        prompt: "Check the support case and tell the user in this chat.", schedule: "10 13 18 10 *" }) } },
                    ...(extraRoutine ? [{ index: closings.length + 1, id: "routine-2", type: "function", function: { name: "CallDynamicTool",
                      arguments: JSON.stringify({ namespace: "fixture", toolName: "read_case", arguments: {} }) } }] : []),
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
          pluginNamespaces: connectorFailure || extraRoutine ? [{ name: "fixture", namespaceStatus: "ready", description: "Fixture connector",
            tools: [{ name: "read_case", description: "Read case", inputSchema: { type: "object" }, source: "fixture/read_case", connectionId: "synthetic" }] }] : [],
          discoveredDynamicTools: new Set(), sentMessageCount: 0, reasoning: "off", cwd: root,
          endTurnRequested: false, initialUserStarted: true, pendingSteers: [], acceptedSteerIds: new Set(),
          assistantOrdinal: 0, startedItems: new Set(), toolArgs: new Map(), queue: { push() {} },
          pluginAbortController: new AbortController(),
        } as unknown as ActiveTurn;
        const sessions = join(root, "sessions");
        await mkdir(sessions);
        const manager = SessionManager.create(root, sessions, { id: active.contextSessionId });
        session = await internals.createStandaloneSession(root, "System fixture", manager, active, { providerId: model.provider, modelId: model.id });
        active.session = session!;
        stopTurn = () => { active.pluginAbortController!.abort(); stopPromise = session!.abort(); };
        session!.subscribe((event) => internals.routeEvent(active, event));
        internals.bindTurnStop(active, session!);
        const prompt = session!.prompt("<user_query>Check back on my support case at 1:10</user_query>");
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          // Release the result-hook cycle after collecting evidence so a failing regression test
          // cleans up its actual Pi session instead of leaving the suite hung.
          for (const call of active.responseCallEnds?.values() ?? []) call.settle();
        }, 1500);
        try { await prompt; await stopPromise; } finally { clearTimeout(timeout); }
        expect(timedOut).toBe(false);
        expect(host).toHaveLength(closings.length + (extraRoutine ? 2 : 1));
        expect(host.map(call => call.callId).sort()).toEqual([
          ...closings.map((_, index) => `closing-${index}`), "routine", ...(extraRoutine ? ["routine-2"] : []),
        ].sort());
        const asked = closings.includes("question") || closings.includes("form") || closings.includes("aliasQuestion");
        const holds = (failures || failedSend !== undefined || failedClosing !== undefined || connectorFailure) && !asked ? 1 : 0;
        expect(requests).toHaveLength(1 + holds);
        expect(active.endTurnHolds ?? 0).toBe(holds);
        const reminder = "Your turn did not end. This end_turn call succeeded, but a call alongside it failed";
        const saved = manager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" &&
          JSON.stringify(entry.message.details?.systemReminders ?? []).includes(reminder));
        expect(saved).toHaveLength(holds);
        if (holds) {
          expect((saved[0] as any).message.toolCallId).toBe(completedClosings.at(-1));
          expect(JSON.stringify(requests[1].messages).split(reminder)).toHaveLength(2);
          expect(JSON.stringify(requests[1].messages)).toContain(failedSend !== undefined ? "channel_not_found" : failedClosing !== undefined ? "Closing rejected" : connectorFailure ? "Connector refused operation" : "Schedule rejected");
        }
        expect(active.awaitingUser === true).toBe(asked);
        expect(active.pluginAbortController!.signal.aborted).toBe(cancelOnSend !== undefined);
        const aliasIndex = closings.findIndex(closing => closing === "aliasReply" || closing === "aliasQuestion");
        if (aliasIndex !== -1) {
          const alias = CLOSINGS[closings[aliasIndex]!];
          // The dispatch transfer is consumed by its one native invocation. Reusing
          // the original call, a fresh call ID, or changed arguments gets no grant.
          for (const [id, args] of [
            [`closing-${aliasIndex}`, alias.arguments],
            ["reused-alias", alias.arguments],
            [`closing-${aliasIndex}`, { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "Changed" } }],
          ] as const)
            await expect(internals.tools.executeOpenTeamTool(active, id, alias.name, args)).rejects.toThrow("turn has ended");
          expect(host).toHaveLength(closings.length + 1);
        }
      } finally {
        session?.dispose();
        server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    }, 15000);
});

test('real Pi loop refreshes a stale question widget and delivers its useful replacement', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-draft-widget-refresh-'));
 const host: any[] = [], requests: any[] = [];
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const input = await request.json() as any; host.push(input);
  return Response.json(host.length === 1 ? {
   sent: false, delivery_failed: true, reason: 'draft_state_changed', draft_state_revision: 'fresh',
   draft_state: { pending: 1 }, note: 'Nothing was delivered. One draft remains; reconsider and call SendToUser in the next response.',
  } : { sent: true, message_id: 'fresh-question' });
 } });
 let session: AgentSession | undefined;
 try {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.checkAuth = async () => ({ type: 'api_key' });
  modelRuntime.streamSimple = (_model, context, options) => streamSimple(model, context, {
   ...options, apiKey: 'synthetic-fixture', maxRetries: 0,
   fetch: (async (_url: any, init: any) => {
    requests.push(JSON.parse(await new Response(init.body).text()));
    const index = requests.length;
    if (index > 1) expect(JSON.stringify(requests[index - 1].messages)).toContain('draft_state_changed');
    const chunks = [
     { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `widget-${index}`, type: 'function', function: {
      name: 'SendToUser', arguments: JSON.stringify({ type: 'widget', widget: { prompt: 'Revise the remaining draft?', options: [{ label: 'Revise', value: 'revise' }] } }),
     } }] }, finish_reason: null }] },
     { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: model.id, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
   }) as typeof fetch,
  });
  const runtime = new ComputerRuntime() as any;
  Object.assign(runtime, { agentDir: root, modelRuntime, resolveModel: () => model,
   tools: new RuntimeTools({} as never, server.url.origin, 'fixture', root, root),
   compactionExtension: () => ({ name: 'fixture-compaction', hidden: true, factory() {} }),
  });
  const active = { runId: crypto.randomUUID(), botId: crypto.randomUUID(), turnId: crypto.randomUUID(),
   conversationId: crypto.randomUUID(), contextSessionId: crypto.randomUUID(), channelId: crypto.randomUUID(), deliveryId: null,
   runtimeProfile: 'agent', requestSource: 'event', subagentType: null, pluginNamespaces: [],
   draftStateRevision: 'old', draftStatusAcknowledged: true, discoveredDynamicTools: new Set(), sentMessageCount: 0,
   reasoning: 'off', cwd: root, endTurnRequested: false, initialUserStarted: true, pendingSteers: [], acceptedSteerIds: new Set(),
   assistantOrdinal: 0, startedItems: new Set(), toolArgs: new Map(), queue: { push() {} }, pluginAbortController: new AbortController(),
  } as unknown as ActiveTurn;
  const sessions = join(root, 'sessions'); await mkdir(sessions);
  const manager = SessionManager.create(root, sessions, { id: active.contextSessionId });
  session = await runtime.createStandaloneSession(root, 'System fixture', manager, active, { providerId: model.provider, modelId: model.id });
  active.session = session!; session!.subscribe(event => runtime.routeEvent(active, event)); runtime.bindTurnStop(active, session!);
  await session!.prompt('<user_query>Show a revision question if drafts remain.</user_query>');
  expect(requests).toHaveLength(2); expect(host).toHaveLength(2);
  expect(host.map(call => call.draftStateRevision)).toEqual(['old', 'fresh']);
  expect(active.sentMessageCount).toBe(1); expect(active.awaitingUser).toBe(true); expect(active.endTurnRequested).toBe(true);
 } finally { session?.dispose(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});
