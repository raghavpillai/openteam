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
} from "@openbot/contracts";
import { Schema } from "effect";
import { resolveWorkspacePath } from "./paths";
import { ComputerRuntime } from "./runtime";
import { ScreenBroker } from "./screen-broker";
import { TranscriptMirror } from "./transcript-mirror";

const port = Number(process.env.OPENBOT_COMPUTER_PORT ?? 8790);
const controlToken = process.env.OPENBOT_CONTROL_TOKEN ?? "local-compose-only-change-me";
const workspaceRoot = resolve(process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace");
const screens = new ScreenBroker();
const transcripts = new TranscriptMirror();
const runtime = new ComputerRuntime(screens);
const encoder = new TextEncoder();

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

const authorized = (request: Request): boolean => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(controlToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const safePath = (input: string): string => resolveWorkspacePath(input, workspaceRoot);

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
        return json({ path: actual, screen: await screens.ensure(botId, actual) });
      }

      const transcriptMatch = url.pathname.match(/^\/v1\/transcripts\/([^/]+)$/);
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
        return json(await transcripts.replace(body as BotTranscriptView));
      }

      const screenMatch = url.pathname.match(/^\/v1\/screens\/([^/]+)$/);
      if (request.method === "GET" && screenMatch?.[1]) {
        const cwd = safePath(url.searchParams.get("cwd") ?? workspaceRoot);
        return json(await screens.status(screenMatch[1], cwd));
      }
      if (request.method === "DELETE" && screenMatch?.[1]) {
        await screens.destroy(screenMatch[1]);
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

      if (request.method === "POST" && url.pathname === "/v1/turns") {
        const input = Schema.decodeUnknownSync(ComputerTurnRequest)(await request.json());
        safePath(input.cwd);
        const events = await runtime.run(input);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of events) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              }
              controller.close();
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ type: "runtime.error", message: error instanceof Error ? error.message : String(error), retrying: false })}\n`
                )
              );
              controller.close();
            }
          },
        });
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

      if (request.method === "POST" && url.pathname === "/v1/approvals/resolve") {
        const input = Schema.decodeUnknownSync(ComputerApprovalResolution)(await request.json());
        await runtime.resolveApproval(input.approvalId, input.decision);
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/compact") {
        const body = (await request.json()) as {
          botId?: string;
          sessionPath?: string;
          cwd?: string;
          instructions?: string;
        };
        if (!body.botId || !body.sessionPath || !body.cwd || !body.instructions) {
          return json({ error: "botId, sessionPath, cwd, and instructions are required" }, 400);
        }
        const cwd = safePath(body.cwd);
        await runtime.compact({
          botId: body.botId,
          sessionPath: body.sessionPath,
          cwd,
          instructions: body.instructions,
        });
        return json({ ok: true });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
});

console.log(`OpenBot computer gateway listening on ${server.url}`);
