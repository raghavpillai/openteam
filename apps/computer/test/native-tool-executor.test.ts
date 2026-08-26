import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolExecutor } from "../src/native-tool-executor";

describe("native computer tools", () => {
  test("Read returns numbered lines with positive and negative paging", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-native-read-"));
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const executor = new NativeToolExecutor({ agentDir: root, controlToken: "test-token" });

    const middle = await executor.read({ path, offset: 2, limit: 1 }, root);
    expect(middle.content[0]).toEqual({ type: "text", text: "2: beta" });
    const last = await executor.read({ path, offset: -2, limit: 1 }, root);
    expect(last.content[0]).toEqual({ type: "text", text: "3: gamma" });
  });

  test("Shell executes foreground commands and records a terminal log", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-native-shell-"));
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
    const root = await mkdtemp(join(tmpdir(), "openbot-native-background-"));
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
      const root = await mkdtemp(join(tmpdir(), "openbot-native-external-"));
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
});
