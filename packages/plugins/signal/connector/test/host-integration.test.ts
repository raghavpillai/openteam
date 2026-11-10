import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldsForConnector, validateValues } from "@openteam/plugin-sdk";
import { discoverPackages } from "../../../scripts/generate";

const repository = new URL("../../../../../", import.meta.url);
// Load app adapters at runtime so the portable connector's typecheck remains independent of app internals.
const { connectionConfigured, runtimeConfiguration, boundPluginResult } = await import(
  new URL("apps/server/src/services/plugin/values.ts", repository).href
);
const { StdioMcpManager } = await import(
  new URL("apps/computer/src/mcp-manager.ts", repository).href
);
const prototype = new URL("../../", import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), "signal-host-"));
const packageRoot = mkdtempSync(join(prototype, "../.signal-host-package-"));
const manager = new StdioMcpManager(join(temporary, "cache"));
let definition: Awaited<ReturnType<typeof discoverPackages>>[number];
let input: any;

beforeAll(async () => {
  cpSync(prototype, join(packageRoot, "signal"), {
    recursive: true,
    filter: (path) => !path.includes("/connector/test") && !path.endsWith("tsconfig.json"),
  });
  definition = (await discoverPackages(packageRoot))[0]!;
  const peer = join(temporary, "synthetic-host-peer.ts");
  writeFileSync(
    peer,
    `#!${process.execPath}\n` +
      String.raw`
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let boundary;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
    const reply = result => emit({jsonrpc:"2.0",id:request.id,result});
    switch (request.method) {
      case "version": reply({version:"0.14.10"}); break;
      case "listAccounts": reply([{aci:"synthetic-host-account",number:null}]); break;
      case "subscribeReceive":
        reply(0);
        for (let i=1; i<=10; i++) emit({jsonrpc:"2.0",method:"receive",params:{result:{account:"synthetic-host-account",envelope:{sourceUuid:"sender",dataMessage:{timestamp:i,message:"x".repeat(16000),attachments:[{id:"attachment",size:80000}]}}}}});
        break;
      case "getAttachment": reply({data:Buffer.alloc(80000,65).toString("base64")}); break;
      default: reply([]);
    }
  }
});
`
  );
  chmodSync(peer, 0o700);
  const connector = definition.connections[0]!;
  // Match the UI's partial-save path, which omits blank optional inputs.
  const values = validateValues(
    fieldsForConnector(definition, connector.key),
    {},
    false
  );
  const connection = {
    authType: connector.auth,
    connectorKey: connector.key,
    configuration: { ...connector.configuration, values },
    credentials: {},
  };
  expect(connectionConfigured(connection, definition)).toBe(true);
  const config = runtimeConfiguration(connection);
  input = {
    ...config,
    command: process.execPath,
    env: { ...config.env, SIGNAL_CLI_PATH: peer, HOME: temporary, OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic-host-account" },
    packageFiles: definition.files,
    packageBinaryFiles: definition.binaryFiles,
  };
  await manager.discover("synthetic-host-account", input);
  await manager.call("synthetic-host-account", input, "signal_status", {});
});
afterAll(async () => {
  await manager.closeAll();
  rmSync(temporary, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

test("marketplace setup has no administrator executable field", () => {
  expect(fieldsForConnector(definition, definition.connections[0]!.key)).toHaveLength(0);
  expect(definition.connections[0]!.runtimeAssets).toHaveLength(3);
  expect(definition.connections[0]!.deviceLink?.startTool).toBe("start_link");
  expect(JSON.stringify(input.env)).not.toContain("${");
});

test("host result bounding preserves complete successful JSON for a small message page", async () => {
  const result = await manager.call("synthetic-host-account", input, "list_messages", { limit: 1 });
  const bounded = boundPluginResult(result);
  expect(bounded.isError).not.toBe(true);
  expect(JSON.parse(bounded.content[0].text).messages).toHaveLength(1);
});

test("large message pages return an intact MCP error before host truncation", async () => {
  const result = await manager.call("synthetic-host-account", input, "list_messages", {});
  const bounded = boundPluginResult(result);
  expect(bounded.isError).toBe(true);
  expect(bounded.content[0].text).toContain("75000-character");
  expect(bounded.content[0].text).not.toContain("[truncated]");
});

test("large attachment responses return an intact MCP error before host truncation", async () => {
  const page = await manager.call("synthetic-host-account", input, "list_messages", { limit: 1 });
  const messageId = JSON.parse(page.content[0].text).messages[0].id;
  const result = await manager.call("synthetic-host-account", input, "read_attachment", {
    messageId,
    attachmentId: "attachment",
  });
  const bounded = boundPluginResult(result);
  expect(bounded.isError).toBe(true);
  expect(bounded.content[0].text).toContain("75000-character");
  expect(bounded.content[0].text).not.toContain("[truncated]");
});
