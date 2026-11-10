import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPackages } from "../../../scripts/generate";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";

const prototype = new URL("../../", import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), "signal-mcp-"));
const packageRoot = mkdtempSync(join(prototype, "../.signal-package-"));
let client: Client;
let transport: StdioClientTransport;
let definition: Awaited<ReturnType<typeof discoverPackages>>[number];
let stderr = "";

beforeAll(async () => {
  // Build with the same catalog generator as a published packaged plugin.
  cpSync(prototype, join(packageRoot, "signal"), {
    recursive: true,
    filter: (path) => !path.includes("/connector/test") && !path.endsWith("tsconfig.json"),
  });
  definition = (await discoverPackages(packageRoot))[0]!;
  const exported = exportPackageArchive(definition!);
  const imported = importPackageArchive(exported).definition;
  expect(imported.binaryFiles?.["assets/icon.png"]).toBe(
    definition.binaryFiles?.["assets/icon.png"]
  );
  const installed = join(temporary, "installed server with spaces.mjs");
  writeFileSync(installed, imported.files!["connector/server.mjs"]!);
  const fake = join(temporary, "signal fixture with spaces.ts");
  writeFileSync(
    fake,
    `#!${process.execPath}\n${await Bun.file(join(import.meta.dir, "fixture.ts")).text()}`
  );
  chmodSync(fake, 0o700);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [installed],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH!,
      HOME: temporary,
      OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic-mcp-account",
      SIGNAL_CLI_PATH: fake,
    },
  });
  transport.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  client = new Client({ name: "signal-prototype-test", version: "1" });
  await client.connect(transport);
});
afterAll(async () => {
  await client?.close();
  rmSync(temporary, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    error: result.isError ?? false,
    value: (result.content as Array<{ text: string }>)[0]!.text,
  };
}

test("package roundtrip retains standalone MCP and omits synthetic fixtures", () => {
  expect(definition!.key).toBe("signal");
  expect(definition!.files!["connector/server.mjs"]).toContain("tools/call");
  expect(Object.keys(definition!.files!).some((path) => path.includes("connector/test"))).toBe(
    false
  );
  expect(
    Object.values(definition!.files!).some((value) => value.includes("synthetic-provider-secret"))
  ).toBe(false);
});

test("normal MCP discovery exposes ten tools with strict schemas and write annotations", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(10);
  expect(tools.filter((t) => t._meta?.["openteam/hostOnly"] === true)).toHaveLength(5);
  expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  expect(tools.find((tool) => tool.name === "send_message")!.annotations!.readOnlyHint).toBe(false);
  expect(tools.some((tool) => tool.name === "register" || tool.name === "trust")).toBe(false);
});

test("standalone installed package executes status and account-scoped reads", async () => {
  const status = await call("signal_status");
  expect(status.error).toBe(false);
  expect(JSON.parse(status.value)).toMatchObject({ linked: true, runtimeVersion: "0.14.10" });
  expect((await call("list_contacts")).value).toContain("Synthetic contact");
  expect((await call("list_groups")).value).toContain("Synthetic group");
  expect((await call("list_messages")).value).toContain("synthetic inbox 🐈");
});

test.each([
  ["list_messages", { limit: 101 }],
  ["list_contacts", { limit: 101 }],
  ["list_contacts", { offset: -1 }],
  ["list_contacts", { recipients: [] }],
  ["list_groups", { groupIds: ["x"], account: "other" }],
  ["list_messages", { before: -1 }],
  ["list_contacts", { account: "other" }],
  ["signal_status", { unexpected: true }],
  ["send_message", { requestId: "request-123" }],
])("MCP rejects invalid input for %s", async (name, args) => {
  expect((await call(name as string, args as Record<string, unknown>)).error).toBe(true);
});

test("MCP send calls preserve idempotency across repeated tool invocations", async () => {
  const args = { requestId: "request-123", noteToSelf: true, message: "synthetic only" };
  expect(JSON.parse((await call("send_message", args)).value)).toMatchObject({ state: "sent" });
  expect(JSON.parse((await call("send_message", args)).value)).toMatchObject({
    existing: true,
    state: "sent",
  });
  expect((await call("send_message", { ...args, message: "changed" })).error).toBe(true);
});

test("unknown tools and arbitrary attachment paths return MCP errors", async () => {
  expect((await call("register")).error).toBe(true);
  expect(
    (
      await call("read_attachment", {
        messageId: "../../etc/passwd",
        attachmentId: "../../etc/passwd",
      })
    ).error
  ).toBe(true);
  expect(stderr).not.toContain("synthetic inbox");
});
