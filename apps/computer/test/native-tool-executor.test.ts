import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostApprovalRequiredError,
  NativeToolExecutor,
  sanitizedShellEnvironment,
} from "../src/native-tool-executor";

describe("native computer tools", () => {
  test("Read returns numbered lines with positive and negative paging", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-read-"));
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });

    const middle = await executor.read({ path, offset: 2, limit: 1 }, root);
    expect(middle.content[0]).toEqual({ type: "text", text: "2: beta" });
    const last = await executor.read({ path, offset: -2, limit: 1 }, root);
    expect(last.content[0]).toEqual({ type: "text", text: "3: gamma" });
  });

  test("Read exposes supported agent files while fencing stores and host metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-protected-read-"));
    const sandRoot = join(root, "sand-data");
    const agentRoot = join(sandRoot, "agents", "probe");
    await mkdir(join(sandRoot, ".openteam"), { recursive: true });
    await mkdir(agentRoot, { recursive: true });
    await writeFile(join(agentRoot, "profile.json"), '{"name":"Probe"}\n');
    await writeFile(join(agentRoot, "store.db"), "not a readable projection");
    await writeFile(join(sandRoot, ".openteam", "marker.json"), "{}\n");
    const executor = new NativeToolExecutor({
      agentDir: root,
      controlToken: "test-token",
      agentDataCanonicalRoot: sandRoot,
    });

    expect(
      (await executor.read({ path: join(agentRoot, "profile.json") }, root)).content[0]
    ).toEqual({ type: "text", text: '1: {"name":"Probe"}\n2: ' });
    await expect(executor.read({ path: join(agentRoot, "store.db") }, root)).rejects.toThrow(
      "Read does not expose live agent SQLite files"
    );
    await expect(
      executor.read({ path: join(sandRoot, ".openteam", "marker.json") }, root)
    ).rejects.toThrow("Read is not allowed for protected agent-data path");
  });

  test("Shell environment removes gateway credentials and startup injection hooks", () => {
    const environment = sanitizedShellEnvironment(
      {
        HOME: "/home/box",
        OPENTEAM_CONTROL_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        GENERIC_PROVIDER_PASSWORD: "secret",
        AWS_ACCESS_KEY_ID: "secret",
        OPENTEAM_PI_AGENT_DIR: "/home/box/.pi/agent",
        DATABASE_URL: "postgres://secret",
        BASH_ENV: "/tmp/inject",
        ENV: "/tmp/inject",
        SAFE_VALUE: "kept",
      },
      "/workspace"
    );
    expect(environment).toEqual({ HOME: "/home/box", SAFE_VALUE: "kept", PWD: "/workspace" });
  });

  const shellTest = process.env.CI === "true" && process.platform === "darwin" ? test.skip : test;

  shellTest("Shell executes foreground commands and records a terminal log", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-shell-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.shell(
      { command: "printf 'native-shell-ok'", working_directory: root, block_until_ms: 5_000 },
      root
    );
    expect(result.content[0]).toEqual({ type: "text", text: "native-shell-ok" });
    const outputPath = (result.details as { outputPath: string }).outputPath;
    expect(await readFile(outputPath, "utf8")).toContain("exit_code: 0");
  });

  test("Shell backgrounds long commands and exposes their log path", async () => {
    const root = await mkdtemp(join(tmpdir(), "openteam-native-background-"));
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });
    const result = await executor.shell(
      { command: "sleep 0.1; printf done", working_directory: root, block_until_ms: 0 },
      root
    );
    expect((result.details as { status: string }).status).toBe("running");
    expect((result.details as { outputPath: string }).outputPath).toContain("terminals");
  });

  test("ExternalRead and ExternalShell authenticate to the physical-host bridge", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        if (new URL(request.url).pathname === "/v1/read") {
          return Response.json({
            kind: "text",
            path: "/host/notes.txt",
            text: "1: host-read-ok",
            lines: 1,
          });
        }
        return Response.json({
          shell_id: "host-shell-1",
          status: "completed",
          exit_code: 0,
          output: "host-shell-ok",
          output_path: "/host/terminals/host-shell-1.log",
          elapsed_ms: 3,
        });
      },
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "openteam-native-external-"));
      const executor = new NativeToolExecutor({
        agentDir: root,
        controlToken: "bridge-token",
        hostBridgeUrl: `http://127.0.0.1:${bridge.port}`,
      });
      const read = await executor.externalRead({ path: "/host/notes.txt" });
      expect(read.content[0]).toEqual({ type: "text", text: "1: host-read-ok" });
      const shell = await executor.externalShell({ command: "printf host-shell-ok" });
      expect(shell.content[0]).toEqual({ type: "text", text: "host-shell-ok" });
      expect(requests).toEqual([
        {
          path: "/v1/read",
          authorization: "Bearer bridge-token",
          body: { path: "/host/notes.txt" },
        },
        {
          path: "/v1/shell",
          authorization: "Bearer bridge-token",
          body: { command: "printf host-shell-ok" },
        },
      ]);
    } finally {
      bridge.stop(true);
    }
  });

  test("preserves structured host approvals and sends the approval token only on retry", async () => {
    const requests: unknown[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as Record<string, unknown>;
        requests.push(input);
        if (input.localApproval !== "allow-once") {
          return Response.json(
            {
              error: "approval_required",
              approval: {
                gate: "local",
                requestMethod: "openteam/localTool",
                details: { type: "localTool", machineId: "machine-1" },
              },
            },
            { status: 409 }
          );
        }
        return Response.json({
          shell_id: "host-shell-2",
          status: "completed",
          exit_code: 0,
          output: "approved",
          output_path: "/tmp/host-shell-2.log",
          elapsed_ms: 1,
        });
      },
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "openteam-host-approval-"));
      const executor = new NativeToolExecutor({
        agentDir: root,
        controlToken: "bridge-token",
        hostBridgeUrl: `http://127.0.0.1:${bridge.port}`,
      });
      const input = { command: "printf approved", machineId: "machine-1" };
      try {
        await executor.externalShell(input);
        throw new Error("Expected a host approval request");
      } catch (error) {
        expect(error).toBeInstanceOf(HostApprovalRequiredError);
        expect((error as HostApprovalRequiredError).approval).toMatchObject({
          gate: "local",
          requestMethod: "openteam/localTool",
          details: { machineId: "machine-1" },
        });
      }
      expect(
        (await executor.externalShell(input, undefined, { localApproval: "allow-once" })).content[0]
      ).toEqual({ type: "text", text: "approved" });
      expect(requests).toEqual([input, { ...input, localApproval: "allow-once" }]);
    } finally {
      bridge.stop(true);
    }
  });

  test("routes Task through the host Auto-review gate with Grok-compatible details", async () => {
    const requests: unknown[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as Record<string, unknown>;
        requests.push(input);
        if (input.autoReviewApproval !== "allow-once") {
          return Response.json(
            {
              error: "approval_required",
              approval: {
                gate: "auto-review",
                requestMethod: "openteam/autoReview",
                details: { type: "autoReview", action: "runTask" },
              },
            },
            { status: 409 }
          );
        }
        return Response.json({ allowed: true });
      },
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "openteam-task-review-"));
      const executor = new NativeToolExecutor({
        agentDir: root,
        controlToken: "bridge-token",
        hostBridgeUrl: `http://127.0.0.1:${bridge.port}`,
      });
      const input = {
        prompt: "Open https://example.com and stop.",
        description: "Open example.com",
        subagent_type: "browserUse" as const,
      };
      await expect(executor.autoReviewTask(input)).rejects.toBeInstanceOf(
        HostApprovalRequiredError
      );
      await executor.autoReviewTask(input, undefined, { autoReviewApproval: "allow-once" });
      expect(requests).toEqual([
        {
          surface: "subagentLaunch",
          summary: "Run a task on OpenTeam's computer: “Open https://example.com and stop.”",
          target: "browserUse",
          arguments: {
            task: "Run a task on OpenTeam's computer: “Open https://example.com and stop.”",
            prompt: "Open https://example.com and stop.",
            description: "Open example.com",
            subagent_type: "browserUse",
          },
        },
        {
          surface: "subagentLaunch",
          summary: "Run a task on OpenTeam's computer: “Open https://example.com and stop.”",
          target: "browserUse",
          arguments: {
            task: "Run a task on OpenTeam's computer: “Open https://example.com and stop.”",
            prompt: "Open https://example.com and stop.",
            description: "Open example.com",
            subagent_type: "browserUse",
          },
          autoReviewApproval: "allow-once",
        },
      ]);
    } finally {
      bridge.stop(true);
    }
  });
});
