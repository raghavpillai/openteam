// A real ComputerRuntime with a scripted model, in its own process: Pi's native clipboard
// addon keeps a process from exiting, so the worker suite never loads it.
import { join } from "node:path";

const computerDir = join(import.meta.dir, "../../../computer/src");
const pi = (name: string) => import(Bun.resolveSync(name, computerDir));
const { InMemoryCredentialStore } = await pi("@earendil-works/pi-ai");
const { streamSimple } = await pi("@earendil-works/pi-ai/api/openai-completions");
const { ModelRuntime } = await pi("@earendil-works/pi-coding-agent");
const { ComputerRuntime } = await import(join(computerDir, "runtime.ts"));

const model: any = {
  id: "supersede-fixture", name: "Supersede fixture", provider: "openai", api: "openai-completions",
  baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"], contextWindow: 128_000,
  maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const sse = (delta: unknown, finish: string) =>
  new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ].map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });

const requests: unknown[] = [];
let firstReply: unknown = null;
let holdSetup: Promise<void> | null = null;
let release: (() => void) | null = null;

const provider = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
provider.checkAuth = async () => ({ type: "api_key" });
provider.streamSimple = (_model: unknown, context: unknown, options: any) => streamSimple(model, context, {
  ...options, apiKey: "fixture", maxRetries: 0,
  fetch: (async (_url: unknown, init: any) => {
    requests.push(JSON.parse(await new Response(init.body).text()));
    const reply = firstReply;
    firstReply = null;
    return reply ? sse(reply, "tool_calls") : sse({ role: "assistant", content: "Following the new message." }, "stop");
  }) as unknown as typeof fetch,
});
const runtime = new ComputerRuntime() as any;
runtime.started = true;
runtime.modelRuntime = provider;
runtime.resolveModel = () => model;
runtime.tools.processSecrets = async () => ({});
const beginTurn = runtime.tools.userForms.beginTurn.bind(runtime.tools.userForms);
runtime.tools.userForms.beginTurn = async (...args: unknown[]) => { await holdSetup; return beginTurn(...args); };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/script") {
      const body = await request.json() as { firstReply?: unknown; hold?: boolean; release?: boolean };
      if (body.firstReply !== undefined) firstReply = body.firstReply;
      if (body.hold) holdSetup = new Promise<void>((resolve) => { release = resolve; });
      if (body.release) { release?.(); holdSetup = null; }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/requests") return Response.json(requests);
    if (url.pathname === "/turns" && request.method === "POST") {
      const turn = await request.json();
      try {
        const queue = await runtime.run({ ...turn, model: `${model.provider}/${model.id}` });
        return new Response(new ReadableStream({
          async start(controller) {
            for await (const event of queue) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
            controller.close();
          },
        }), { headers: { "content-type": "application/x-ndjson" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
      }
    }
    const cancel = url.pathname.match(/^\/v1\/turns\/([^/]+)\/cancel$/);
    if (cancel?.[1]) {
      const body = await request.json().catch(() => ({})) as { reason?: string; recovery?: boolean };
      const cancelled = await runtime.cancel(cancel[1], body.reason, { recovery: body.recovery === true }).catch(() => false);
      return cancelled ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 409 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});
console.log(`READY ${server.port}`);
