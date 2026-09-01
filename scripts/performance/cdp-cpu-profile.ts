const endpoint = process.env.OPENBOT_AUDIT_CDP_URL ?? "http://127.0.0.1:9333";
const durationMs = Number(process.env.OPENBOT_AUDIT_PROFILE_MS ?? 10_000);
const samplingIntervalUs = Number(process.env.OPENBOT_AUDIT_PROFILE_INTERVAL_US ?? 250);

if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) {
  throw new Error("OPENBOT_AUDIT_PROFILE_MS must be between 1 and 60000");
}
if (
  !Number.isFinite(samplingIntervalUs) ||
  samplingIntervalUs < 100 ||
  samplingIntervalUs > 10_000
) {
  throw new Error("OPENBOT_AUDIT_PROFILE_INTERVAL_US must be between 100 and 10000");
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

interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}

interface Profile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
}

await command("Profiler.enable");
await command("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
await command("Profiler.start");
console.error(`CDP CPU profile ready for ${durationMs} ms`);
await new Promise((resolve) => setTimeout(resolve, durationMs));
const { profile } = await command<{ profile: Profile }>("Profiler.stop");
socket.close();

const durationByNode = new Map<number, number>();
for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
  const nodeId = profile.samples?.[index];
  if (nodeId === undefined) continue;
  durationByNode.set(
    nodeId,
    (durationByNode.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? samplingIntervalUs)
  );
}
const nodeById = new Map(profile.nodes.map((node) => [node.id, node] as const));
const hottest = [...durationByNode]
  .map(([nodeId, durationUs]) => {
    const node = nodeById.get(nodeId);
    return {
      functionName: node?.callFrame.functionName || "(anonymous)",
      url: node?.callFrame.url ?? "",
      line: (node?.callFrame.lineNumber ?? -1) + 1,
      column: (node?.callFrame.columnNumber ?? -1) + 1,
      selfMs: durationUs / 1_000,
      samples: Math.round(durationUs / samplingIntervalUs),
    };
  })
  .sort((left, right) => right.selfMs - left.selfMs)
  .slice(0, 40);

const serialized = JSON.stringify(
  {
    capturedAt: new Date().toISOString(),
    durationMs: (profile.endTime - profile.startTime) / 1_000,
    samplingIntervalUs,
    samples: profile.samples?.length ?? 0,
    hottest,
  },
  null,
  2
);
if (process.env.OPENBOT_AUDIT_OUTPUT) {
  await Bun.write(process.env.OPENBOT_AUDIT_OUTPUT, `${serialized}\n`);
}
console.log(serialized);
