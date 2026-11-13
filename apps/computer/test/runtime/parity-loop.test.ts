import { describe, test, expect } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RuntimeTools } from "../../src/runtime/tools";
import type { ActiveTurn } from "../../src/runtime/types";
import { tempDirs } from "../temp";
import { offlineComputerRuntime, offlineModel, piTurn, requestBody, sseStep, toolCall } from "./pi-fixtures";
const tempDir = tempDirs();
const model = offlineModel("parity-fixture", { contextWindow: 128_000 });

/** A real Pi session over a tool host at `server`, with compaction stubbed out. */
async function loop(root: string, server: { url: URL }, fetch: (url: unknown, init: any) => Promise<Response>, turn: Record<string, unknown>,
  subscriber: (internals: any, active: any, manager: SessionManager) => (event: any) => void = (internals, active) => (event) => internals.routeEvent(active, event)) {
  const internals = await offlineComputerRuntime(model, root, fetch);
  internals.tools = new RuntimeTools({} as never, server.url.origin, "synthetic-control-token", root, root);
  internals.compactionExtension = () => ({ name: "fixture-compaction", hidden: true, factory() {} });
  const active: any = piTurn(model, root, { conversationId: crypto.randomUUID(), channelId: crypto.randomUUID(), deliveryId: null, requestSource: "turn", endTurnRequested: false, ...turn });
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const manager = SessionManager.create(root, sessions, { id: active.contextSessionId });
  const session: AgentSession = await internals.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
  active.session = session;
  session.subscribe(subscriber(internals, active, manager));
  internals.bindTurnStop(active, session);
  return { internals, active: active as ActiveTurn & Record<string, any>, manager, session };
}

// Typed messages supersede a main turn instead of steering it.
for (const handoff of [false, true])
  test(`real Pi loop persists before acknowledgement, stops on ${handoff ? "WakeParent" : "end_turn"}, and recovers tape`, async () => {
    const root = await tempDir("pi-parity-");
    const requests: any[] = [];
    const sent: any[] = [];
    const acknowledged: any[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      sent.push(await request.json());
      return Response.json(handoff ? { woken: true, run_id: "parent-wake" } : { sent: true, message_id: `delivery-${sent.length}` });
    } });
    let session: AgentSession | undefined;
    try {
      let manager!: SessionManager;
      const fixture = await loop(root, server, async (_url, init) => {
        // Pi used to delay first-write until an assistant existed. This assertion
        // runs inside the actual provider call, before the first assistant arrives.
        expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("<user_query>Read the result</user_query>");
        requests.push(await requestBody(init));
        const toolId = `send-${requests.length}`;
        return sseStep(model, [handoff ? toolCall(0, toolId, "WakeParent", { message: "Fixture result: notify the user." }) : toolCall(0, toolId, "SendToUser", { type: "text", content: "Fixture result", end_turn: true })]);
      }, {
        requestSource: handoff ? "automation" : "turn", instructions: "System fixture: verified instructions",
        initialUserStarted: false, initialUserClientId: "fixture-user", queue: { push: (event: any) => acknowledged.push(event) },
      }, (internals, active, manager) => {
        internals.activeByRun.set(active.runId, active);
        return (event) => {
          if (event.type === "message_end" && event.message.role === "user") {
            expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain("Read the result");
            internals.routeEvent(active, event);
          }
        };
      });
      manager = fixture.manager;
      session = fixture.session;
      const { active } = fixture;
      const toolHost = fixture.internals.tools as RuntimeTools;
      await session!.sendCustomMessage(
        { customType: "openteam-ambient", content: "[SAND_HIDDEN_PROMPT]A background job completed.", display: false, details: { messageId: "ambient-fixture" } },
        { triggerTurn: false }
      );
      await session!.prompt("<user_query>Read the result</user_query>");
      expect(acknowledged.filter((event) => event.type === "prompt.delivered")).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(sent).toHaveLength(1);
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
      expect(payload.tools.some((tool: any) => tool.function.name === "CallDynamicTool")).toBe(true);
      const hasReceipt = (messages: any[]) => messages.some((message) => message.role === "toolResult" && message.toolCallId === "send-1");
      expect(hasReceipt(session!.messages)).toBe(true);
      const path = manager.getSessionFile()!;
      session!.dispose();
      session = undefined;
      const reopened = SessionManager.open(path);
      const restored = reopened.buildSessionContext().messages;
      expect(hasReceipt(restored)).toBe(true);
      expect(restored.filter((message: any) => message.role === "custom" && message.details?.messageId === "ambient-fixture")).toHaveLength(1);
      expect((await readFile(path, "utf8")).includes("synthetic-control-token")).toBe(false);
      expect(reopened.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "openteam-input-receipt")).toHaveLength(1);
    } finally {
      session?.dispose();
      server.stop(true);
    }
  }, 15000);

describe("sibling closing calls", () => {
  const CLOSINGS = {
    reply: { name: "SendToUser", arguments: { type: "text", content: "I'll check back at 1:10 PM.", end_turn: true } },
    reaction: { name: "ReactToMessage", arguments: { message_address: "t1u", emoji: "\u{1F44D}", end_turn: true } },
    question: { name: "SendToUser", arguments: { type: "widget", widget: { prompt: "Check back at 1:10 PM?", options: [{ label: "Yes", value: "yes", style: "primary" }] } } },
    aliasReply: { name: "CallDynamicTool", arguments: { namespace: "cursor", toolName: "SendToUser", arguments: { type: "text", content: "Second result", end_turn: true } } },
  } as const;
  const cases: { closings: (keyof typeof CLOSINGS)[]; failures?: number; routineDelay?: number; closingDelays?: number[]; failedSend?: number; failedClosing?: number; connectorFailure?: boolean; cancelOnSend?: number }[] = [
    { closings: ["reply", "reaction", "reply"] },
    { closings: ["reply", "question"], failures: 1 },
    { closings: ["reaction", "reply"], failedSend: 1 },
    { closings: ["reaction", "reply"], connectorFailure: true, routineDelay: 80 },
    { closings: ["reaction", "reply"], cancelOnSend: 1 },
    { closings: ["reply", "aliasReply"] },
    // Completion order of sibling closings must not matter.
    { closings: ["reaction", "reply", "reaction"], closingDelays: [80, 40, 0], failures: 1, routineDelay: 120 },
    { closings: ["reaction", "reply", "reaction"], closingDelays: [80, 40, 0], failedClosing: 2 },
  ];
  for (const { closings, failures = 0, routineDelay = 0, closingDelays, failedSend, failedClosing, connectorFailure, cancelOnSend } of cases)
    test(`real Pi loop settles sibling closing calls ${closings.join("+")} with ${failures} failure${routineDelay ? " arriving late" : ""}${closingDelays ? ` delays ${closingDelays.join("/")}` : ""}${failedSend !== undefined ? ` undelivered send ${failedSend}` : ""}${failedClosing !== undefined ? ` rejected closing ${failedClosing}` : ""}${connectorFailure ? " connector error receipt" : ""}${cancelOnSend !== undefined ? " interrupted batch" : ""}`, async () => {
      const root = await tempDir("pi-end-turn-hold-");
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
        const fixture = await loop(root, server, async (_url, init) => {
          requests.push(await requestBody(init));
          if (requests.length > 1) return sseStep(model, "The reply already went out.");
          const readCase = (index: number, id: string) => toolCall(index, id, "CallDynamicTool", { namespace: "fixture", toolName: "read_case", arguments: {} });
          return sseStep(model, [
            ...closings.map((closing, index) => toolCall(index, `closing-${index}`, CLOSINGS[closing].name, CLOSINGS[closing].arguments)),
            connectorFailure ? readCase(closings.length, "routine") : toolCall(closings.length, "routine", "UpdateRoutine", {
              action: "create", name: "Check back", prompt: "Check the support case and tell the user in this chat.", schedule: "10 13 18 10 *" }),
          ]);
        }, {
          pluginNamespaces: connectorFailure ? [{ name: "fixture", namespaceStatus: "ready", description: "Fixture connector",
            tools: [{ name: "read_case", description: "Read case", inputSchema: { type: "object" }, source: "fixture/read_case", connectionId: "synthetic" }] }] : [],
          discoveredDynamicTools: new Set(), initialUserStarted: true, pendingSteers: [], acceptedSteerIds: new Set(), pluginAbortController: new AbortController(),
        });
        const { internals, active, manager } = fixture;
        session = fixture.session;
        stopTurn = () => { active.pluginAbortController!.abort(); stopPromise = session!.abort(); };
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
        expect(host).toHaveLength(closings.length + 1);
        expect(host.map(call => call.callId).sort()).toEqual([
          ...closings.map((_, index) => `closing-${index}`), "routine",
        ].sort());
        const asked = closings.includes("question");
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
        const aliasIndex = closings.findIndex(closing => closing === "aliasReply");
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
