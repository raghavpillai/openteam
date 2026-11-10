import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignalRpc, SignalRpcError } from "../rpc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = process.env.SIGNAL_TEST_EXECUTABLE;
const real = executable ? test : test.skip;
const processes: SignalRpc[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((rpc) => rpc.close()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function runtime() {
  const directory = mkdtempSync(join(tmpdir(), "signal-real-unlinked-"));
  directories.push(directory);
  const rpc = new SignalRpc(
    [executable!, "--data-dir", directory, "jsonRpc", "--receive-mode=manual"],
    () => {},
    {
      environment: {
        ...(process.env.SIGNAL_TEST_JAVA_HOME
          ? { JAVA_HOME: process.env.SIGNAL_TEST_JAVA_HOME }
          : {}),
        XDG_CONFIG_HOME: directory,
      },
    }
  );
  processes.push(rpc);
  return rpc;
}

real(
  "real signal-cli returns its version through the connector transport",
  async () => {
    expect((await runtime().request("version")).version).toMatch(/^0\.14\./);
  },
  20000
);

real(
  "real signal-cli private directory is empty and supports concurrent RPC",
  async () => {
    const rpc = runtime();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => rpc.request("listAccounts"))
    );
    expect(results.every((value) => Array.isArray(value) && value.length === 0)).toBe(true);
  },
  20000
);

real(
  "real unknown methods produce typed JSON-RPC errors",
  async () => {
    await expect(runtime().request("unknownMethodForValidation")).rejects.toBeInstanceOf(
      SignalRpcError
    );
  },
  20000
);

real(
  "real unlinked account reads fail without defaulting to another local account",
  async () => {
    await expect(
      runtime().request("listContacts", { account: "+12025550100" })
    ).rejects.toBeInstanceOf(SignalRpcError);
  },
  20000
);

real(
  "real provisioning reaches Signal and returns a QR-link URI without creating an account",
  async () => {
    const rpc = runtime();
    const result = await rpc.request("startLink", {}, 30_000);
    const uri = new URL(result.deviceLinkUri);
    expect(uri.protocol).toBe("sgnl:");
    expect(uri.hostname).toBe("linkdevice");
    expect(uri.searchParams.get("uuid")).toBeTruthy();
    expect(uri.searchParams.get("pub_key")).toBeTruthy();
    expect(await rpc.request("listAccounts")).toEqual([]);
  },
  40000
);

real(
  "real runtime works through the MCP entry point with private unlinked state",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "signal-real-mcp-"));
    directories.push(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../server.ts", import.meta.url).pathname],
      stderr: "pipe",
      env: {
        PATH: process.env.PATH!,
        HOME: root,
        OPENTEAM_PLUGIN_ACCOUNT_ID: "real-unlinked-test",
        SIGNAL_STATE_ROOT: root,
        SIGNAL_CLI_PATH: executable!,
        ...(process.env.SIGNAL_TEST_JAVA_HOME
          ? { JAVA_HOME: process.env.SIGNAL_TEST_JAVA_HOME }
          : {}),
      },
    });
    const client = new Client({ name: "real-signal-mcp-test", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(10);
      const status = await client.callTool({ name: "signal_status", arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        linked: false,
      });
      expect((await client.callTool({ name: "list_contacts", arguments: {} })).isError).toBe(true);
    } finally {
      await client.close();
    }
  },
  20000
);

real(
  "real process supports repeated clean connector lifecycles",
  async () => {
    for (let i = 0; i < 5; i++) {
      const rpc = runtime();
      expect(await rpc.request("listAccounts")).toEqual([]);
      await rpc.close();
      processes.pop();
      expect(rpc.connected).toBe(false);
      expect(rpc.exitCode).toBe(0);
    }
  },
  30000
);
