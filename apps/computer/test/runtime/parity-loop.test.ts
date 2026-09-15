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

for (const { withSteer, handoff } of [{ withSteer: false, handoff: false }, { withSteer: true, handoff: false }, { withSteer: false, handoff: true }])
  test(`real Pi loop persists before acknowledgement, stops on ${handoff ? "WakeParent" : "end_turn"}, and recovers tape${withSteer ? " with queued steering" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-parity-"));
    const requests: any[] = [];
    const sent: any[] = [];
    const acknowledged: any[] = [];
    let releaseSend: (() => void) | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as any;
        sent.push(input);
        if (withSteer)
          await new Promise<void>((resolve) => {
            releaseSend = resolve;
          });
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
                            name: handoff ? "CallDynamicTool" : "SendToUser",
                            arguments: JSON.stringify(handoff ? {
                              namespace: "cursor", toolName: "WakeParent",
                              arguments: { message: "Fixture result: notify the user." },
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
        discoveredDynamicTools: new Set(),
        sentMessageCount: 0,
        reasoning: "off",
        cwd: root,
        endTurnRequested: false,
        initialUserStarted: false,
        initialUserClientId: "fixture-user",
        pendingSteers: [],
        acceptedSteerIds: new Set(),
        queue: { push: (event: any) => acknowledged.push(event) },
      } as unknown as ActiveTurn;
      if (handoff) {
        const discover = toolHost.customTools(active).find((tool) => tool.name === "GetDynamicTools")!;
        await discover.execute("discover-wake", { namespace: "cursor", toolName: "WakeParent" }, undefined, undefined, {} as never);
      }
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
      if (withSteer) {
        for (let i = 0; i < 100 && !releaseSend; i++) await Bun.sleep(10);
        expect(releaseSend).toBeDefined();
        await runtime.steer(active.runId, {
          inboxId: "steer-inbox",
          clientMessageId: "steer-message",
          content: "Check one more source",
        });
        releaseSend!();
      }
      await running;
      expect(acknowledged.filter((event) => event.type === "prompt.delivered")).toHaveLength(1);
      if (withSteer) {
        expect(active.pendingSteers).toHaveLength(1);
        expect(acknowledged.some((event) => event.type === "input.delivered")).toBe(false);
      }

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
      if (process.env.OPENTEAM_PARITY_ARTIFACT_DIR && !withSteer && !handoff) {
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
