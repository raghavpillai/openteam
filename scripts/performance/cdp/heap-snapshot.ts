const endpoint = process.env.OPENTEAM_AUDIT_CDP_URL ?? "http://127.0.0.1:9333";
const output = process.env.OPENTEAM_AUDIT_OUTPUT;

if (!output) throw new Error("OPENTEAM_AUDIT_OUTPUT is required");

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
const chunks: string[] = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    method?: string;
    params?: { chunk?: string };
    result?: unknown;
    error?: { message?: string };
  };
  if (message.method === "HeapProfiler.addHeapSnapshotChunk" && message.params?.chunk) {
    chunks.push(message.params.chunk);
    return;
  }
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

await command("HeapProfiler.enable");
await command("HeapProfiler.collectGarbage");
await command("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
socket.close();

await Bun.write(output, chunks.join(""));
console.log(
  JSON.stringify({
    output,
    chunks: chunks.length,
    bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  })
);
