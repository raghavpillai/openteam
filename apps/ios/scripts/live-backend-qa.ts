/** Disposable production API + worker + PostgreSQL. Only model responses are deterministic. */
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPrismaClient } from "../../../packages/db/src/index";

const root = resolve(process.env.SWIFT_LIVE_QA_OUTPUT ?? "output/swift-full-qa-0916/live-backend");
const databaseUrl = "postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/swiftqa_live";
const prisma = createPrismaClient(databaseUrl);
await mkdir(root, { recursive: true });
const token = "swift-disposable-backend-control";
const actual = "http://127.0.0.1:20005";
const turns: any[] = [];
let offline = false,
  dropSend = false;
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: 20006,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health")
      return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response(null, { status: 401 });
    if (path === "/health/authenticated")
      return Response.json({ status: "ready", inference: { ready: true, authenticated: true } });
    if (path === "/v1/task-capabilities")
      return Response.json({ desktopAvailable: false, boxAvailable: false });
    if (path === "/v1/agent-stores" && request.method === "GET")
      return Response.json({ agents: [] });
    if (path === "/v1/infer") {
      const body = (await request.json()) as any;
      return Response.json({
        text:
          body.kind === "verification"
            ? '{"approved":true}'
            : body.kind === "synthesis"
              ? '{"changes":[]}'
              : "NONE",
      });
    }
    if (path === "/v1/directories") {
      const body = (await request.json()) as any;
      for (const directory of body.paths ?? []) {
        if (!resolve(directory).startsWith(root + "/"))
          throw new Error("Directory escaped disposable root");
        await mkdir(directory, { recursive: true });
      }
      return Response.json({ directories: body.paths });
    }
    if (path.startsWith("/v1/context-sessions/") && request.method === "GET")
      return Response.json({
        type: "context.state",
        contextSessionId: path.split("/").at(-1),
        epoch: 0,
        archives: [],
      });
    if (path.startsWith("/v1/screens/")) {
      const suffix = path.split("/").slice(4).join("/");
      const dest = `http://127.0.0.1:20003/api/v0/bots/live/screen${suffix ? "/" + suffix : ""}`;
      const body = request.method === "GET" ? undefined : ((await request.json()) as any);
      return fetch(dest, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body:
          body === undefined ? undefined : JSON.stringify(suffix === "actions" ? body.input : body),
      });
    }
    if (path !== "/v1/turns") return Response.json({ ok: true, quarantined: [] });
    const input = (await request.json()) as any;
    turns.push({
      runId: input.runId,
      botId: input.botId,
      content: input.content,
      at: new Date().toISOString(),
    });
    const routine = String(input.content).includes("SWIFT_SCHEDULE_CANARY");
    const firstStart = String(input.content).includes("[OpenTeam first start]");
    const result = await fetch(actual + "/api/internal/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        runId: input.runId,
        botId: input.botId,
        conversationId: input.conversationId,
        channelId: input.channelId,
        deliveryId: input.deliveryId,
        callId: `native-qa:${input.runId}`,
        tool: input.requestSource === "automation" ? "WakeParent" : "SendToUser",
        arguments:
          input.requestSource === "automation"
            ? { message: "SWIFT_SCHEDULE_CANARY: Tell the user the scheduled QA completed." }
            : {
                type: "text",
                content: routine
                  ? "Scheduled QA completed"
                  : firstStart
                    ? "Your QA bot is ready"
                    : "Native QA reply received",
              },
      }),
    });
    if (!result.ok) return new Response(await result.text(), { status: 503 });
    const events = [
      {
        type: "session.attached",
        runtimeEngine: "pi",
        inferenceProvider: "openai-codex",
        contextSessionId: input.contextSessionId,
        sessionPath: input.sessionPath ?? `${root}/pi/${input.contextSessionId}.jsonl`,
        sessionId: input.contextSessionId,
        model: "deterministic-native-qa",
      },
      { type: "context.state", contextSessionId: input.contextSessionId, epoch: 0, archives: [] },
      { type: "turn.started", turnId: input.runId },
      { type: "prompt.delivered", turnId: input.runId },
      { type: "turn.completed", turnId: input.runId, status: "completed" },
    ];
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  },
});
const env = {
  PATH: process.env.PATH!,
  HOME: process.env.HOME!,
  DATABASE_URL: databaseUrl,
  OPENTEAM_COMPUTER_URL: computer.url.origin,
  OPENTEAM_CONTROL_TOKEN: token,
  OPENTEAM_WORKSPACE_ROOT: join(root, "workspace"),
  OPENTEAM_AGENT_DATA_ROOT: join(root, "agent-data"),
  OPENTEAM_ASSET_ROOT: join(root, "assets"),
  OPENTEAM_AUTH_MODE: "disabled",
  OPENTEAM_AUTH_SECRET: "swift-disposable-qa-secret-0916-only",
  OPENTEAM_AUTH_URL: actual,
  OPENTEAM_PORT: "20005",
  OPENTEAM_SERVER_HOST: "127.0.0.1",
  OPENTEAM_TIME_ZONE: "America/New_York",
  OPENTEAM_MEMORY_DREAMING: "disabled",
};
for (const p of [
  env.OPENTEAM_WORKSPACE_ROOT,
  env.OPENTEAM_AGENT_DATA_ROOT,
  env.OPENTEAM_ASSET_ROOT,
])
  await mkdir(p, { recursive: true });
const server = Bun.spawn([process.execPath, "apps/server/src/main.ts"], {
  env,
  stdout: Bun.file(join(root, "server.log")),
  stderr: Bun.file(join(root, "server-error.log")),
});
const worker = Bun.spawn([process.execPath, "apps/worker/src/main.ts"], {
  env,
  stdout: Bun.file(join(root, "worker.log")),
  stderr: Bun.file(join(root, "worker-error.log")),
});
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 20007,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/__qa/control" && request.method === "POST") {
      const body = (await request.json()) as any;
      offline = body.offline ?? offline;
      dropSend = body.dropSend ?? dropSend;
      return Response.json({ ok: true });
    }
    if (path === "/__qa/state")
      return Response.json({
        bots: await prisma.bot.findMany({ select: { id: true, name: true, status: true } }),
        messages: await prisma.channelMessage.findMany({
          select: { id: true, clientId: true, channelId: true, content: true, metadata: true },
        }),
        routines: await prisma.routine.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, nextRunAt: true, enabled: true, revision: true },
        }),
        executions: await prisma.routineExecution.findMany({
          select: {
            id: true,
            routineId: true,
            status: true,
            kind: true,
            createdAt: true,
            completedAt: true,
          },
        }),
        turns,
      });
    if (offline) return Response.json({ message: "Disposable network outage" }, { status: 503 });
    const response = await fetch(actual + path + url.search, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    });
    if (dropSend && request.method === "POST" && /\/messages$/.test(path) && response.ok) {
      dropSend = false;
      await response.arrayBuffer();
      return Response.json(
        { message: "Lost acknowledgment after durable acceptance" },
        { status: 503 }
      );
    }
    return response;
  },
});
console.log("Production native QA API: http://127.0.0.1:20007 (deterministic model boundary)");
const close = async () => {
  server.kill();
  worker.kill();
  proxy.stop(true);
  computer.stop(true);
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
