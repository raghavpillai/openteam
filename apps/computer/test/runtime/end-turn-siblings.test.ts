import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
