import { timingSafeEqual } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BotTranscriptView,
  ComputerApprovalResolution,
  ComputerSteerRequest,
  ComputerTurnRequest,
  ScreenActionInput,
  ScreenPauseInput,
  ScreenTakeoverInput,
  type TranscriptEventView,
} from "@openbot/contracts";
import {
  COMPUTER_API_PATHS,
  parseComputerInferenceRequest,
} from "@openbot/contracts/service-protocol";
import { Schema } from "effect";
import { BoxStoreSync } from "./box-store-sync";
import { computerEventStream } from "./computer-event-stream";
import { GrokAgentStore } from "./grok-agent-store";
import { StdioMcpManager } from "./mcp-manager";
import { resolveWorkspacePath } from "./paths";
import { ComputerRuntime } from "./runtime";
import { ScreenBroker } from "./screen-broker";
import { TranscriptMirror } from "./transcript-mirror";

const port = Number(process.env.OPENBOT_COMPUTER_PORT ?? 8790);
const controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
const workspaceRoot = resolve(process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace");
const screens = new ScreenBroker();
const agentStores = new GrokAgentStore();
const boxStore = new BoxStoreSync({
  hasLiveAgentHandle: (agentId) => agentStores.hasLiveHandle(agentId),
});
await boxStore.start();
const transcripts = new TranscriptMirror();
const runtime = new ComputerRuntime(screens, agentStores, ({ botId }) =>
  boxStore.scheduleSnapshot(5_000, {
    agentIds: [botId],
    workspace: true,
    pi: true,
    chrome: true,
  })
);
const stdioMcp = new StdioMcpManager();

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const authorized = (request: Request): boolean => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(controlToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const safePath = (input: string): string => resolveWorkspacePath(input, workspaceRoot);

const transcriptEventFromStore = (
  botId: string,
  row: { id: string; entry: Record<string, unknown> }
): TranscriptEventView | null => {
  const nested = row.entry.event;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const event = nested as TranscriptEventView;
    if (event.id === row.id && event.botId === botId && typeof event.at === "string") return event;
  }
  const at = typeof row.entry.at === "string" ? row.entry.at : new Date(0).toISOString();
  const metadata =
    row.entry.metadata &&
    typeof row.entry.metadata === "object" &&
    !Array.isArray(row.entry.metadata)
      ? (row.entry.metadata as Record<string, unknown>)
      : {};
  const channel =
    row.entry.channel && typeof row.entry.channel === "object" && !Array.isArray(row.entry.channel)
      ? (row.entry.channel as TranscriptEventView["channel"])
      : null;
  if (row.entry.kind === "message") {
    const role = row.entry.role;
    const fromAgent =
      metadata.fromAgent &&
      typeof metadata.fromAgent === "object" &&
      !Array.isArray(metadata.fromAgent)
        ? (metadata.fromAgent as Record<string, unknown>)
        : null;
    const senderKind = role === "assistant" ? "agent" : role === "user" ? "user" : "system";
    return {
      schemaVersion: 1,
      id: row.id,
      botId,
      at,
      type: "visible_message",
      channel,
      sender: {
        kind: senderKind,
        botId:
          senderKind === "agent" && typeof row.entry.senderBotId === "string"
            ? row.entry.senderBotId
            : null,
        name:
          typeof fromAgent?.name === "string"
            ? fromAgent.name
            : senderKind === "user"
              ? "User"
              : senderKind === "agent"
                ? "Agent"
                : "System",
      },
      content: typeof row.entry.content === "string" ? row.entry.content : "",
      metadata,
    };
  }
  if (row.entry.kind === "event" && typeof row.entry.type === "string") {
    return {
      schemaVersion: 1,
      id: row.id,
      botId,
      at,
      type: row.entry.type as TranscriptEventView["type"],
      channel,
      sender: null,
      content: typeof row.entry.content === "string" ? row.entry.content : null,
      metadata,
    };
  }
  return null;
};

const conversationEnvelopeFromEvent = (event: TranscriptEventView) => ({
  role:
    event.sender?.kind === "agent"
      ? "assistant"
      : event.sender?.kind === "user"
        ? "user"
        : "system",
  content: event.content ?? "",
  eventId: event.id,
  at: event.at,
  channel: event.channel,
});

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      try {
        await runtime.start();
        return json({ status: "ready", agent: runtime.diagnostics });
      } catch (error) {
        return json(
          {
            status: "degraded",
            agent: runtime.diagnostics,
            error: error instanceof Error ? error.message : String(error),
          },
          503
        );
      }
    }
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);

    try {
      if (request.method === "PUT" && url.pathname === "/v1/directories") {
        const body = (await request.json()) as { paths?: unknown };
        if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
          return json({ error: "paths must be an array of strings" }, 400);
        }
        const directories = [];
        for (const requested of body.paths as string[]) {
          const path = safePath(requested);
          await mkdir(path, { recursive: true });
          const actual = await realpath(path);
          safePath(actual);
          directories.push(actual);
        }
        return json({ directories });
      }

      if (request.method === "PUT" && url.pathname === "/v1/projects") {
        const body = (await request.json()) as {
          path?: unknown;
          name?: unknown;
          description?: unknown;
        };
        if (
          typeof body.path !== "string" ||
          typeof body.name !== "string" ||
          typeof body.description !== "string"
        ) {
          return json({ error: "path, name, and description are required" }, 400);
        }
        const path = safePath(body.path);
        await mkdir(path, { recursive: true });
        const actual = await realpath(path);
        safePath(actual);
        try {
          await writeFile(
            resolve(actual, "project.md"),
            `# ${body.name}\n\n${body.description || "Shared OpenBot project."}\n`,
            { encoding: "utf8", flag: "wx" }
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        return json({ path: actual });
      }

      if (request.method === "PUT" && url.pathname.startsWith("/v1/workspaces/")) {
        const botId = url.pathname.slice("/v1/workspaces/".length);
        if (!botId) return json({ error: "bot id is required" }, 400);
        const body = (await request.json()) as { path?: string };
        if (!body.path) return json({ error: "path is required" }, 400);
        const path = safePath(body.path);
        await mkdir(path, { recursive: true });
        const actual = await realpath(path);
        safePath(actual);
        const screen = await screens.ensure(botId, actual);
        boxStore.scheduleSnapshot(5_000, { workspace: true, chrome: true });
        return json({ path: actual, screen });
      }

      if (request.method === "POST" && url.pathname === COMPUTER_API_PATHS.reconcileAgentStores) {
        const body = (await request.json()) as { ownerIds?: unknown };
        if (
          !Array.isArray(body.ownerIds) ||
          body.ownerIds.some((ownerId) => typeof ownerId !== "string")
        ) {
          return json({ error: "ownerIds must be an array of strings" }, 400);
        }
        await agentStores.quarantineUnknownAgents(body.ownerIds as string[]);
        return json({ agents: await agentStores.listAgentDirectories(), quarantined: [] });
      }

      if (request.method === "GET" && url.pathname === COMPUTER_API_PATHS.agentStores) {
        const snapshot = await agentStores.agentDirectorySnapshot();
        const etag = `"${snapshot.revision}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, {
            status: 304,
            headers: { "cache-control": "no-store", etag },
          });
        }
        return json({ agents: snapshot.agents }, 200, { etag });
      }

      const agentStoreMatch = url.pathname.match(/^\/v1\/agent-stores\/([^/]+)$/);
      if (request.method === "PUT" && agentStoreMatch?.[1]) {
        const body = (await request.json().catch(() => ({}))) as { createdAt?: unknown };
        const createdAt =
          typeof body.createdAt === "number" && Number.isFinite(body.createdAt)
            ? body.createdAt
            : Date.now();
        await agentStores.initializeAgent(agentStoreMatch[1], createdAt);
        boxStore.scheduleSnapshot(5_000, { agentIds: [agentStoreMatch[1]] });
        return json({ ok: true });
      }

      const transcriptMatch = url.pathname.match(/^\/v1\/transcripts\/([^/]+)$/);
      if (request.method === "GET" && transcriptMatch?.[1]) {
        const botId = transcriptMatch[1];
        const rows = await agentStores.readTranscriptEntries(botId, {
          afterSeq: Number(url.searchParams.get("afterSeq") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 10_000),
        });
        return json({
          botId,
          generatedAt: new Date().toISOString(),
          revision: Number((await agentStores.readKv(botId, "replicaRevision")) ?? 0),
          coverage: { kind: "complete-transcript" },
          events: rows.flatMap((row) => {
            const event = transcriptEventFromStore(botId, row);
            return event ? [event] : [];
          }),
        });
      }
      if (request.method === "PUT" && transcriptMatch?.[1]) {
        const body = (await request.json()) as {
          botId?: unknown;
          generatedAt?: unknown;
          events?: unknown;
        };
        if (
          body.botId !== transcriptMatch[1] ||
          typeof body.generatedAt !== "string" ||
          !Array.isArray(body.events)
        ) {
          return json({ error: "invalid transcript projection" }, 400);
        }
        const transcript = body as BotTranscriptView;
        const result = await transcripts.replace(transcript);
        await agentStores.withAgentLease(transcript.botId, async () => {
          const existingEntries = await agentStores.readTranscriptEntries(transcript.botId);
          const existingById = new Map(existingEntries.map((entry) => [entry.id, entry]));
          const conversationEnvelopes: unknown[] = [];
          for (const event of transcript.events) {
            const existing = existingById.get(event.id);
            if (!existing) {
              await agentStores.appendTranscriptEntry(
                transcript.botId,
                event.id,
                event.type === "visible_message"
                  ? {
                      kind: "message",
                      event,
                      role:
                        event.sender?.kind === "agent"
                          ? "assistant"
                          : (event.sender?.kind ?? "system"),
                      content: event.content ?? "",
                      at: event.at,
                      channel: event.channel,
                      metadata: event.metadata,
                    }
                  : {
                      kind: "event",
                      event,
                      type: event.type,
                      at: event.at,
                      channel: event.channel,
                      metadata: event.metadata,
                    }
              );
            }
            const durableEvent = existing
              ? transcriptEventFromStore(transcript.botId, existing)
              : event;
            if (durableEvent?.type === "visible_message") {
              conversationEnvelopes.push(conversationEnvelopeFromEvent(durableEvent));
            }
          }
          await agentStores.appendConversationEnvelopes(transcript.botId, conversationEnvelopes);
          await agentStores.refreshDerivedProjections(transcript.botId);
        });
        boxStore.scheduleSnapshot(5_000, {
          agentIds: [transcript.botId],
          sandPaths: ["search-index.db", `transcript-publish/${transcript.botId}.json`],
        });
        return json(result);
      }

      const screenMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)$/);
      if (request.method === "GET" && screenMatch?.[1]) {
        const cwd = safePath(url.searchParams.get("cwd") ?? workspaceRoot);
        return json(await screens.status(screenMatch[1], cwd));
      }
      if (request.method === "DELETE" && screenMatch?.[1]) {
        await screens.destroy(screenMatch[1]);
        await agentStores.closeAgent(screenMatch[1]);
        boxStore.scheduleSnapshot(5_000, { chrome: true, agentIds: [screenMatch[1]] });
        return json({ ok: true });
      }

      const frameMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)\/frame$/);
      if (request.method === "GET" && frameMatch?.[1]) {
        const cwd = safePath(url.searchParams.get("cwd") ?? workspaceRoot);
        const frame = await screens.screenshot(frameMatch[1], cwd);
        return new Response(new Uint8Array(frame), {
          headers: {
            "content-type": "image/png",
            "cache-control": "no-store, max-age=0",
          },
        });
      }

      const actionMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)\/actions$/);
      if (request.method === "POST" && actionMatch?.[1]) {
        const body = (await request.json()) as { cwd?: string; input?: unknown };
        if (!body.cwd) return json({ error: "cwd is required" }, 400);
        const cwd = safePath(body.cwd);
        const input = Schema.decodeUnknownSync(ScreenActionInput)(body.input);
        return json(await screens.act(actionMatch[1], cwd, input, "human"));
      }

      const takeoverMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)\/takeover$/);
      if (request.method === "POST" && takeoverMatch?.[1]) {
        const body = (await request.json()) as { cwd?: string; active?: unknown };
        if (!body.cwd) return json({ error: "cwd is required" }, 400);
        const cwd = safePath(body.cwd);
        const input = Schema.decodeUnknownSync(ScreenTakeoverInput)({ active: body.active });
        return json(await screens.takeover(takeoverMatch[1], cwd, input.active));
      }

      const pauseMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)\/pause$/);
      if (request.method === "POST" && pauseMatch?.[1]) {
        const body = (await request.json()) as { cwd?: string; paused?: unknown };
        if (!body.cwd) return json({ error: "cwd is required" }, 400);
        const cwd = safePath(body.cwd);
        const input = Schema.decodeUnknownSync(ScreenPauseInput)({ paused: body.paused });
        return json(await screens.pauseAgent(pauseMatch[1], cwd, input.paused));
      }

      const mcpDiscoverMatch = url.pathname.match(/^\/v1\/mcp\/connections\/([^/]+)\/discover$/);
      if (request.method === "POST" && mcpDiscoverMatch?.[1]) {
        const body = (await request.json()) as { configuration?: unknown };
        return json({ tools: await stdioMcp.discover(mcpDiscoverMatch[1], body.configuration) });
      }

      const mcpCallMatch = url.pathname.match(/^\/v1\/mcp\/connections\/([^/]+)\/call$/);
      if (request.method === "POST" && mcpCallMatch?.[1]) {
        const body = (await request.json()) as {
          configuration?: unknown;
          toolName?: unknown;
          arguments?: unknown;
        };
        if (typeof body.toolName !== "string") return json({ error: "toolName is required" }, 400);
        return json({
          result: await stdioMcp.call(
            mcpCallMatch[1],
            body.configuration,
            body.toolName,
            body.arguments
          ),
        });
      }

      const mcpConnectionMatch = url.pathname.match(/^\/v1\/mcp\/connections\/([^/]+)$/);
      if (request.method === "DELETE" && mcpConnectionMatch?.[1]) {
        await stdioMcp.close(mcpConnectionMatch[1]);
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === COMPUTER_API_PATHS.turns) {
        const input = Schema.decodeUnknownSync(ComputerTurnRequest)(await request.json());
        safePath(input.cwd);
        const events = await runtime.run(input);
        const body = computerEventStream(events);
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          },
        });
      }

      const steerMatch = url.pathname.match(/^\/v1\/turns\/([^/]+)\/steer$/);
      if (request.method === "POST" && steerMatch?.[1]) {
        const input = Schema.decodeUnknownSync(ComputerSteerRequest)(await request.json());
        await runtime.steer(steerMatch[1], input);
        return json({ ok: true });
      }

      const cancelMatch = url.pathname.match(/^\/v1\/turns\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1]) {
        await runtime.cancel(cancelMatch[1]);
        return json({ ok: true });
      }

      const contextSessionMatch = url.pathname.match(/^\/v1\/context-sessions\/([^/]+)$/);
      if (request.method === "GET" && contextSessionMatch?.[1]) {
        return json(await runtime.contextState(contextSessionMatch[1]));
      }
      if (request.method === "DELETE" && contextSessionMatch?.[1]) {
        const body = (await request.json().catch(() => ({}))) as { sessionPath?: unknown };
        await runtime.deleteContextSession(
          contextSessionMatch[1],
          typeof body.sessionPath === "string" ? body.sessionPath : undefined
        );
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === COMPUTER_API_PATHS.approvalResolution) {
        const input = Schema.decodeUnknownSync(ComputerApprovalResolution)(await request.json());
        await runtime.resolveApproval(input.approvalId, input.decision);
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === COMPUTER_API_PATHS.inference) {
        const body = parseComputerInferenceRequest(await request.json());
        const cwd = safePath(typeof body.cwd === "string" ? body.cwd : workspaceRoot);
        const text = await runtime.infer({
          instructions: body.instructions,
          prompt: body.prompt,
          cwd,
          timeoutMs: Math.max(1_000, Math.min(body.timeoutMs, 90_000)),
        });
        return json({ text });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
});

let shutdownPromise: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  server.stop();
  shutdownPromise = Promise.all([
    stdioMcp.closeAll(),
    (async () => {
      await agentStores.closeAll();
      boxStore.scheduleSnapshot(0, { sand: true });
      await boxStore.flushScheduledSnapshots();
    })(),
  ]).then(() => undefined);
  return shutdownPromise;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error) => {
      console.error(`OpenBot computer gateway shutdown failed: ${String(error)}`);
      process.exitCode = 1;
    });
  });
}

console.log(`OpenBot computer gateway listening on ${server.url}`);
