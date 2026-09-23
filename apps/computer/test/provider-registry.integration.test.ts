import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("custom endpoint: add without a model or key, discover, select, restart, infer, and revoke access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-provider-integration-"));
  const requests: Array<{ path: string; auth: string | null; body?: Record<string, unknown> }> = [];
  let status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const row = {
        path,
        auth: request.headers.get("authorization"),
        body: undefined as Record<string, unknown> | undefined,
      };
      requests.push(row);
      if (status !== 200) return new Response("synthetic-private-error", { status });
      if (path === "/v1/models")
        return Response.json({
          data: [{ id: "local-chat" }, { id: "whisper-1" }, { id: "text-embedding-3-small" }],
        });
      if (path === "/v1/chat/completions") {
        row.body = (await request.json()) as Record<string, unknown>;
        const chunk = {
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 0,
          model: "local-chat",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Local endpoint works" },
              finish_reason: "stop",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  // Explicitly isolate credentials and environment from the developer's accounts.
  const env = {
    PATH: process.env.PATH!,
    HOME: directory,
    PI_OFFLINE: "1",
    OPENTEAM_PI_AGENT_DIR: directory,
  };
  async function run(args: string[], input?: object) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdin: input ? new Blob([JSON.stringify(input)]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  const cli = (args: string[], input?: object) => run(["src/provider-cli.ts", ...args], input);
  try {
    const added = await cli(["add-custom"], {
      id: "local",
      name: "Local test",
      baseUrl: server.url.origin,
      api: "openai-completions",
      noAuth: true,
      createOnly: true,
    });
    expect(added).toMatchObject({ code: 0, stderr: "" });
    const listed = await cli(["catalog"]);
    expect(listed).toMatchObject({ code: 0, stderr: "" });
    const catalog = JSON.parse(listed.stdout);
    expect(catalog.models.map((m: { modelId: string }) => m.modelId)).toEqual(["local-chat"]);
    expect(
      catalog.providers
        .filter((p: { configured: boolean }) => p.configured)
        .map((p: { id: string }) => p.id)
    ).toEqual(["local"]);
    const before = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    expect(before.providers.local.models).toEqual([]);
    const verified = await cli(["verify", "local", "local-chat"]);
    expect(verified).toMatchObject({ code: 0, stderr: "" });
    const restarted = await run([
      "-e",
      `
      import {ModelRuntime} from '@earendil-works/pi-coding-agent';
      const dir = process.env.OPENTEAM_PI_AGENT_DIR;
      const runtime = await ModelRuntime.create({authPath: dir+'/auth.json', modelsPath: dir+'/models.json', modelsStorePath: dir+'/models-store.json', allowModelNetwork: false});
      const model = runtime.getModel('local','local-chat');
      if (!model) throw new Error('Selected model did not survive restart');
      const response = await runtime.completeSimple(model, {messages:[{role:'user',content:'ping',timestamp:Date.now()}]}, {maxTokens:10, signal:AbortSignal.timeout(3000)});
      if (response.stopReason === 'error') throw new Error(response.errorMessage);
      console.log(JSON.stringify({stopReason:response.stopReason, content:response.content}));
    `,
    ]);
    expect(restarted).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Local endpoint works" }],
    });
    expect(requests.find((r) => r.path === "/v1/chat/completions")?.body?.model).toBe("local-chat");
    expect(requests.filter((r) => r.path === "/v1/models").every((r) => !r.auth)).toBe(true);
    expect(requests.find((r) => r.path === "/v1/chat/completions")?.auth).toBe(
      "Bearer openteam-no-auth"
    );
    const duplicate = await cli(["add-custom"], {
      id: "local",
      name: "Replacement",
      baseUrl: "http://elsewhere.test/v1",
      api: "openai-completions",
      createOnly: true,
    });
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already exists");
    status = 401;
    const revoked = await cli(["catalog", "local"]);
    expect(JSON.parse(revoked.stdout).models).toEqual([]);
    const refused = await cli(["verify", "local", "local-chat"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Reconnect");
    expect(refused.stderr).not.toContain("synthetic-private-error");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("OpenRouter: discover a new namespaced model, select, restart and infer with its own API key", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "openteam-openrouter-integration-"));
  const requests: Array<{ path: string; auth: string | null; model?: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const row = {
        path,
        auth: request.headers.get("authorization"),
        model: undefined as string | undefined,
      };
      requests.push(row);
      if (path === "/api/v1/models/user")
        return Response.json({
          data: [
            {
              id: "author/new-tool-model",
              name: "New tool model",
              context_length: 64000,
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
              supported_parameters: ["tools"],
              top_provider: { max_completion_tokens: 4096 },
            },
          ],
        });
      if (path === "/api/v1/chat/completions") {
        row.model = (await request.json()).model;
        return new Response(
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: row.model, choices: [{ index: 0, delta: { role: "assistant", content: "Routed correctly" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const env = {
    PATH: process.env.PATH!,
    HOME: directory,
    PI_OFFLINE: "1",
    OPENTEAM_PI_AGENT_DIR: directory,
    OPENTEAM_AGENT_DATA_ROOT: directory,
  };
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  }
  try {
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "synthetic-openrouter-key" } })
    );
    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({ providers: { openrouter: { baseUrl: server.url.origin + "/api/v1" } } })
    );
    const catalog = JSON.parse(await run(["src/provider-cli.ts", "catalog", "openrouter"]));
    expect(catalog.providers.map((p: { id: string }) => p.id).sort()).toEqual([
      "anthropic",
      "claude-code",
      "openai",
      "openai-codex",
      "openrouter",
    ]);
    expect(catalog.providers.find((p: { id: string }) => p.id === "openrouter")).toMatchObject({
      custom: false,
      configured: true,
      authMethods: [{ type: "api_key", subscription: false }],
    });
    expect(catalog.models).toMatchObject([
      {
        providerId: "openrouter",
        modelId: "author/new-tool-model",
        contextWindow: 64000,
        maxTokens: 4096,
      },
    ]);
    await run(["src/provider-cli.ts", "verify", "openrouter", "author/new-tool-model"]);
    const output = await run([
      "-e",
      `
      import { createModelRuntime } from './src/model-runtime';
      const dir = process.env.OPENTEAM_PI_AGENT_DIR;
      const runtime = await createModelRuntime({ authPath: dir+'/auth.json', modelsPath: dir+'/models.json', modelsStorePath: dir+'/models-store.json', allowModelNetwork: false });
      const model = runtime.getModel('openrouter','author/new-tool-model');
      if (!model || model.api !== 'openai-completions' || model.contextWindow !== 64000) throw new Error('Model snapshot was lost');
      const response = await runtime.completeSimple(model, {messages:[{role:'user',content:'ping',timestamp:Date.now()}]}, {maxTokens:10,signal:AbortSignal.timeout(3000)});
      if (response.stopReason === 'error') throw new Error(response.errorMessage);
      console.log(JSON.stringify(response.content));
    `,
    ]);
    expect(JSON.parse(output)).toMatchObject([{ type: "text", text: "Routed correctly" }]);
    expect(
      requests.filter(
        (r) =>
          ["/api/v1/models/user", "/api/v1/chat/completions"].includes(r.path) &&
          r.auth !== "Bearer synthetic-openrouter-key"
      )
    ).toEqual([]);
    expect(requests.find((r) => r.path.endsWith("chat/completions"))?.model).toBe(
      "author/new-tool-model"
    );
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
