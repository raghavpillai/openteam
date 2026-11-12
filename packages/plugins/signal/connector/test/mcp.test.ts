import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPackages } from "../../../scripts/generate";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";

const sourceDirectory = new URL("../../", import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), "signal-mcp-"));
const packageRoot = mkdtempSync(join(sourceDirectory, "../.signal-package-"));
let client: Client;
let transport: StdioClientTransport;
let definition: Awaited<ReturnType<typeof discoverPackages>>[number];
let stderr = "";

beforeAll(async () => {
  // Build with the same catalog generator as a published packaged plugin.
  cpSync(sourceDirectory, join(packageRoot, "signal"), {
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
  client = new Client({ name: "signal-connector-test", version: "1" });
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
