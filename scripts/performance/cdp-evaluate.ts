const endpoint = process.env.OPENTEAM_AUDIT_CDP_URL ?? "http://127.0.0.1:9333";
const expression = process.argv.slice(2).join(" ").trim();

if (!expression) {
  throw new Error("Usage: bun scripts/performance/cdp-evaluate.ts <JavaScript expression>");
}

interface Target {
  type: string;
  webSocketDebuggerUrl?: string;
}

const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Target[];
const target = targets.find(
  (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl
);
if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron page target at ${endpoint}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), {
    once: true,
  });
});

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    result?: unknown;
    error?: { message?: string };
  };
  if (typeof message.id !== "number") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
  else waiter.resolve(message.result);
});

const command = <T>(method: string, params: Record<string, unknown> = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

await command("Runtime.enable");
const evaluated = await command<{
  result: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string };
}>("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  includeCommandLineAPI: true,
  returnByValue: true,
});
socket.close();

if (evaluated.exceptionDetails) {
  throw new Error(
    evaluated.exceptionDetails.text ?? evaluated.result.description ?? "Evaluation failed"
  );
}

const serialized = JSON.stringify(evaluated.result.value ?? null, null, 2);
if (process.env.OPENTEAM_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENTEAM_AUDIT_OUTPUT, `${serialized}\n`);
}
console.log(serialized);
