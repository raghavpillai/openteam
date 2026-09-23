import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { BotCompactionArchiveStore, BotCompactionCoordinator } from "../../src/bot-compaction";
import { ComputerRuntime } from "../../src/runtime";
import { verifyGraphicalTaskCompletion } from "../../src/runtime/graphical-completion";

test("real Pi loop spaces durable checkpoints without extra inference and keeps full schema evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphical-progress-"));
  const requests: any[] = [];
  const model: Model<"openai-completions"> = {
    id: "progress-fixture", name: "Progress fixture", provider: "openai", api: "openai-completions",
    baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 100_000,
    maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let session: any;
  try {
    const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    provider.checkAuth = async () => ({ type: "api_key" });
    provider.streamSimple = (_model, context, options) => streamSimple(model, context, {
      ...options, apiKey: "fixture", maxRetries: 0,
      fetch: (async (_url: unknown, init: any) => {
        requests.push(JSON.parse(await new Response(init.body).text()));
        const useTool = requests.length <= 25;
        const delta = useTool ? { role: "assistant", tool_calls: [{ index: 0, id: `lookup-${requests.length}`, type: "function", function: { name: "GetDynamicTools", arguments: JSON.stringify({ namespace: "fixture", toolName: "ReadValue" }) } }] } : { role: "assistant", content: "All requested criteria verified." };
        const chunks = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const runtime = new ComputerRuntime() as any;
    const archive = new BotCompactionArchiveStore(join(root, "archives"));
    runtime.agentDir = root;
    runtime.modelRuntime = provider;
    runtime.resolveModel = () => model;
    runtime.compaction = new BotCompactionCoordinator(archive, 0);
    const descriptor = { tool: "ReadValue", description: "FULL-SCHEMA-EVIDENCE ".repeat(40), inputSchema: { type: "object", properties: {} } };
    runtime.tools = {
      customTools: () => [{ name: "GetDynamicTools", label: "Lookup", description: "Read a fixture schema", parameters: { type: "object", properties: { namespace: { type: "string" }, toolName: { type: "string" } } }, execute: async () => ({ content: [{ type: "text", text: JSON.stringify(descriptor) }], details: {} }) }],
      acknowledgeToolOutcomes: async () => {},
    };
    const active: any = {
      contextSessionId: crypto.randomUUID(), runId: crypto.randomUUID(), turnId: crypto.randomUUID(),
      modelRef: { providerId: model.provider, modelId: model.id }, reasoning: "off", cwd: root,
      instructions: "Perform the graphical fixture.", subagentType: "computerUse", requestSource: "subagent",
      userInfoMessage: null, discoveredDynamicTools: new Set(), pluginAbortController: new AbortController(),
      queue: { push() {} },
    };
    const manager = SessionManager.create(root, join(root, "sessions"), { id: active.contextSessionId });
    session = await runtime.createStandaloneSession(root, active.instructions, manager, active, active.modelRef);
    active.session = session;
    await session.prompt("Perform all twenty-five fixture steps.");
    expect(requests).toHaveLength(26);
    const checkpoint = "Host execution status: this graphical worker is still active";
    expect(requests.slice(0, 12).every(request => !JSON.stringify(request).includes(checkpoint))).toBe(true);
    expect(JSON.stringify(requests[12])).toContain(checkpoint);
    const checkpointsIn = (request: any) => JSON.stringify(request).split(checkpoint).length - 1;
    expect(checkpointsIn(requests[13])).toBe(1);
    expect(checkpointsIn(requests[23])).toBe(1);
    expect(checkpointsIn(requests[24])).toBe(2);
    expect(checkpointsIn(requests[25])).toBe(2);
    const raw = manager.buildSessionContext().messages;
    expect(raw.filter((m: any) => m.customType === "openteam-graphical-progress")).toHaveLength(2);
    expect(raw.filter((m: any) => m.role === "toolResult" && JSON.stringify(m).includes("FULL-SCHEMA-EVIDENCE"))).toHaveLength(25);
    const visibleResults = requests[25].messages.filter((m: any) => m.role === "tool");
    expect(visibleResults.filter((m: any) => JSON.stringify(m).includes("FULL-SCHEMA-EVIDENCE"))).toHaveLength(1);
    expect(visibleResults.filter((m: any) => JSON.stringify(m).includes("schemaSourceToolCallId"))).toHaveLength(24);
    // Completion verification remains available; the checkpoint never replaces it.
    await verifyGraphicalTaskCompletion(active);
    expect(requests).toHaveLength(27);
    expect(JSON.stringify(requests[26])).toContain("Before returning this graphical task");
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
