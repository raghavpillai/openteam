import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldsForConnector, validateValues } from "@openteam/plugin-sdk";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { pluginCatalog } from "../../../src";

const repository = new URL("../../../../../", import.meta.url);
// Load app adapters at runtime so the portable connector's typecheck remains independent of app internals.
const { connectionConfigured, runtimeConfiguration, boundPluginResult } = await import(
  new URL("apps/server/src/services/plugin/values.ts", repository).href
);
const { StdioMcpManager } = await import(new URL("apps/computer/src/mcp-manager.ts", repository).href);
const temporary = mkdtempSync(join(tmpdir(), "signal host "));
const manager = new StdioMcpManager(join(temporary, "package cache"));
const account = "synthetic-host-account";
const logs = spyOn(console, "error");
let input: any;

beforeAll(async () => {
  // Install what an exported package carries, from a path with spaces, like a user's machine.
  const definition = importPackageArchive(exportPackageArchive(pluginCatalog.find((plugin) => plugin.key === "signal")!)).definition;
  const peer = join(temporary, "signal fixture with spaces.ts");
  writeFileSync(peer, `#!${process.execPath}\n${await Bun.file(join(import.meta.dir, "fixture.ts")).text()}`);
  chmodSync(peer, 0o700);
  const connector = definition.connections[0]!;
  // Match the UI's partial-save path, which omits blank optional inputs.
  const values = validateValues(fieldsForConnector(definition, connector.key), {}, false);
  const connection = { authType: connector.auth, connectorKey: connector.key, configuration: { ...connector.configuration, values }, credentials: {} };
  expect(connectionConfigured(connection, definition)).toBe(true);
  const config = runtimeConfiguration(connection);
  input = {
    ...config,
    command: process.execPath,
    env: { ...config.env, SIGNAL_CLI_PATH: peer, HOME: temporary, OPENTEAM_PLUGIN_ACCOUNT_ID: account },
    packageFiles: definition.files,
    packageBinaryFiles: definition.binaryFiles,
  };
  await manager.discover(account, input);
  await manager.call(account, input, "signal_status", {});
});
afterAll(async () => {
  await manager.closeAll();
  logs.mockRestore();
  rmSync(temporary, { recursive: true, force: true });
});
const call = (name: string, args: Record<string, unknown> = {}) => manager.call(account, input, name, args);
const value = (result: any) => JSON.parse(result.content[0].text);

test("tool sends are idempotent; unknown tools and arbitrary attachment paths are MCP errors", async () => {
  const args = { requestId: "request-123", noteToSelf: true, message: "synthetic only" };
  expect(value(await call("send_message", args))).toMatchObject({ state: "sent" });
  expect(value(await call("send_message", args))).toMatchObject({ existing: true, state: "sent" });
  expect((await call("send_message", { ...args, message: "changed" })).isError).toBe(true);
  expect((await call("register")).isError).toBe(true);
  expect((await call("read_attachment", { messageId: "../../etc/passwd", attachmentId: "../../etc/passwd" })).isError).toBe(true);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("synthetic inbox");
});

test("large attachment responses return an intact MCP error before host truncation", async () => {
  const messageId = value(await call("list_messages", { limit: 1 })).messages[0].id;
  const bounded = boundPluginResult(await call("read_attachment", { messageId, attachmentId: "attachment" }));
  expect(bounded.isError).toBe(true);
  expect(bounded.content[0].text).toContain("75000-character");
  expect(bounded.content[0].text).not.toContain("[truncated]");
});

test("directory lookups pass only explicit recipient/group filters to the bound account", async () => {
  expect(value(await call("list_contacts", { recipients: ["contact-007"] }))).toMatchObject({
    contacts: [{ uuid: "contact-007", name: "Synthetic contact 7" }], nextOffset: null, total: 1,
  });
  expect(value(await call("list_groups", { groupIds: ["group-004"] }))).toMatchObject({
    groups: [{ id: "group-004", name: "Synthetic group 4" }], nextOffset: null, total: 1,
  });
});
