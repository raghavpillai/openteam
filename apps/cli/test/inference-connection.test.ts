import { describe, expect, test } from "bun:test";
import type { ComposeProject } from "../src/docker";
import { checkInferenceConnection } from "../src/inference-connection";
import type { RunOptions, RunResult } from "../src/process";

const settings = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoning: "medium",
} as const;

const fixture = (result: RunResult = { status: 0, stdout: '{"ok":true}\n', stderr: "" }) => {
  const calls: Array<{ args: readonly string[]; options: RunOptions }> = [];
  const project = {
    run(args: readonly string[], options: RunOptions) {
      calls.push({ args, options });
      return result;
    },
  } as unknown as ComposeProject;
  return { project, calls };
};

describe("model connection probe", () => {
  test.each([
    "openai-codex",
    "openai",
    "anthropic",
  ])("uses the saved %s model and thinking setting without exporting credentials", (providerId) => {
    const { project, calls } = fixture();
    const selected = {
      ...settings,
      providerId,
      modelId: providerId === "anthropic" ? "claude-sonnet-5" : settings.modelId,
    };
    expect(checkInferenceConnection(project, selected).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 5)).toEqual(["exec", "--no-TTY", "server", "bun", "-e"]);
    expect(JSON.parse(calls[0]!.options.input!)).toEqual({
      kind: "verification",
      instructions: "This is a connection test. Reply with only OK.",
      prompt: "Reply OK.",
      timeoutMs: 30_000,
      model: `${selected.providerId}/${selected.modelId}`,
      reasoning: "medium",
    });
    expect(calls[0]?.options.timeoutMs).toBe(40_000);
  });

  test("redacts provider errors before returning diagnostics", () => {
    const secret = "sk-proj-doctorSecret0123456789012345";
    const { project } = fixture({
      status: 0,
      stdout: JSON.stringify({ ok: false, error: `HTTP 401: Invalid API key ${secret}` }),
      stderr: "",
    });
    const result = checkInferenceConnection(project, settings);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 401");
    expect(result.detail).toContain("[REDACTED]");
    expect(result.detail).not.toContain(secret);
  });

  test.each([
    "",
    "not JSON",
    "{}",
    '{"ok":"true"}',
    "null",
  ])("does not report success for malformed output %j", (stdout) => {
    const { project } = fixture({ status: 0, stdout, stderr: "" });
    expect(checkInferenceConnection(project, settings)).toEqual({
      ok: false,
      detail: `${settings.providerId}/${settings.modelId}: The connection test returned an invalid result`,
    });
  });

  test("reports a bounded Docker timeout", () => {
    const { project } = fixture({
      status: 1,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
    });
    expect(checkInferenceConnection(project, settings)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("timed out"),
    });
  });

  test("redacts Docker errors and never treats them as model success", () => {
    const { project } = fixture({
      status: 1,
      stdout: '{"ok":true}',
      stderr: "request failed: Bearer secretControlToken0123456789",
    });
    expect(checkInferenceConnection(project, settings)).toEqual({
      ok: false,
      detail: `${settings.providerId}/${settings.modelId}: request failed: Bearer [REDACTED]`,
    });
  });
});

describe("connection probe executed in Bun", () => {
  test.each([
    { status: 200, body: { text: "OK" }, ok: true },
    { status: 200, body: { text: "A connection is working." }, ok: true },
    { status: 200, body: { text: "  " }, ok: false, error: "no text" },
    { status: 200, body: { text: 123 }, ok: false, error: "no text" },
    {
      status: 401,
      body: { error: "Invalid provider credential" },
      ok: false,
      error: "HTTP 401: Invalid provider credential",
    },
    {
      status: 429,
      body: { error: { message: "Quota exceeded" } },
      ok: false,
      error: "HTTP 429: Quota exceeded",
    },
    {
      status: 400,
      body: { error: "Model is not supported" },
      ok: false,
      error: "HTTP 400: Model is not supported",
    },
  ])("validates an actual HTTP response: %j", async ({ status, body, ok, error }) => {
    const received: Array<{ path: string; method: string; authorized: boolean; body: unknown }> =
      [];
    const token = "test-control-token";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          method: request.method,
          authorized: request.headers.get("authorization") === `Bearer ${token}`,
          body: await request.json(),
        });
        return Response.json(body, { status });
      },
    });
    const { project, calls } = fixture();
    checkInferenceConnection(project, settings);
    const input = calls[0]!.options.input!;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", calls[0]!.args.at(-1)!],
      env: {
        PATH: process.env.PATH,
        OPENTEAM_COMPUTER_URL: server.url.href,
        OPENTEAM_CONTROL_TOKEN: token,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input);
    child.stdin.end();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      expect(result.ok).toBe(ok);
      if (error) expect(result.error).toContain(error);
      expect(received).toEqual([
        { path: "/v1/infer", method: "POST", authorized: true, body: JSON.parse(input) },
      ]);
      expect(stdout).not.toContain(token);
      if (ok) expect(result).toEqual({ ok: true });
    } finally {
      child.kill();
      server.stop(true);
    }
  });
});
