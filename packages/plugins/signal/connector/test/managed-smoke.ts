import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PluginRuntimeAsset } from "@openteam/plugin-sdk";
import { ManagedRuntimeCache } from "@openteam/plugin-sdk/runtime-assets";
import manifest from "../../plugin.json";
import assets from "../runtime-assets.json";

// Explicit operator smoke check: downloads public runtimes, never opens an existing account.
assert.deepEqual(
  assets,
  manifest.connections[0]!.runtimeAssets,
  "Runtime validation pins drifted from the manifest"
);
const cache = resolve(
  process.env.SIGNAL_RUNTIME_CACHE ?? "output/signal-validation/managed-runtime"
);
const environment = await new ManagedRuntimeCache(cache).resolve(assets as PluginRuntimeAsset[]);
const directory = await mkdtemp(join(tmpdir(), "signal-managed-smoke-"));
try {
  for (let iteration = 0; iteration < 2; iteration++) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../server.ts", import.meta.url).pathname],
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        ...environment,
        OPENTEAM_PLUGIN_ACCOUNT_ID: "managed-runtime-smoke",
        OPENTEAM_PLUGIN_STATE_DIR: directory,
      },
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "signal-managed-runtime-smoke", version: "1" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 10);
      assert.equal(tools.filter((tool) => tool._meta?.["openteam/hostOnly"] !== true).length, 5);
      const status = await client.callTool({ name: "signal_status", arguments: {} });
      assert.notEqual(status.isError, true);
      const value = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
      assert.equal(value.linked, false);
      assert.equal(value.runtimeVersion, "0.14.10");
      assert.equal(value.runtimePatch, "0.14.10-ot.1");
      assert.equal((await client.callTool({ name: "list_contacts", arguments: {} })).isError, true);
      if (iteration === 0 && process.argv.includes("--provision")) {
        const result = await client.callTool({ name: "start_link", arguments: {} });
        assert.notEqual(result.isError, true);
        const link = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
        assert.match(link.qrCodeDataUrl, /^data:image\/png;base64,/);
        assert.notEqual(
          (await client.callTool({ name: "finish_link", arguments: { sessionId: link.sessionId } }))
            .isError,
          true
        );
        assert.notEqual(
          (await client.callTool({ name: "cancel_link", arguments: { sessionId: link.sessionId } }))
            .isError,
          true
        );
      }
      console.log(
        JSON.stringify({
          iteration,
          platform: `${process.platform}-${process.arch}`,
          linked: false,
          version: value.runtimeVersion,
          publicTools: 5,
          passed: true,
        })
      );
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
