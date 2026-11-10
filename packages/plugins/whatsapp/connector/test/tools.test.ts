import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { WhatsAppAccount } from "../account";
import { settings } from "../process";
import { whatsappTools } from "../tools";
import { pairingPng } from "../png";
import { serveWhatsApp } from "../server";

function fixture(readOnly = false) {
  const calls: Array<{ args: string[]; readOnly: boolean }> = [];
  const account = new WhatsAppAccount({
    execute: async (args, readOnly = false) => { calls.push({ args, readOnly }); return { success: true, data: { authenticated: false, messages: [] }, error: null }; },
    follow: () => { throw new Error("Unexpected side effect"); },
  }, settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "test-account", WHATSAPP_READ_ONLY: String(readOnly) }, "/home/box"));
  const tools = whatsappTools(account);
  const call = async (name: string, args: Record<string, unknown>) => {
    const entry = tools.find((tool) => tool.name === name)!;
    const result = createToolValidator(entry.inputSchema)(args);
    if (!result.valid) throw new Error(result.errorMessage);
    return entry.run(args);
  };
  return { account, tools, calls, call };
}

test("read-only discovery removes remote changes while preserving setup and downloads", () => {
  const { tools } = fixture(true); const names = tools.map((t) => t.name);
  expect(names).toContain("whatsapp_start_link"); expect(names).toContain("download_media");
  for (const name of ["send_text", "send_file", "react_to_message", "edit_message", "update_chat", "backfill_history", "logout_account"]) expect(names).not.toContain(name);
});

test("query option injection is prevented and pagination arguments survive", async () => {
  const f = fixture();
  await f.call("search_messages", { query: "--store=/wrong", chat: "15551234567@s.whatsapp.net", cursor: "opaque", limit: 7, context_before: 2 });
  expect(f.calls[0]).toEqual({ readOnly: true, args: ["messages", "search", "--limit", "7", "--chat", "15551234567@s.whatsapp.net", "--cursor", "opaque", "--context-before", "2", "--", "--store=/wrong"] });
  await expect(f.call("list_messages", { limit: 100000 })).rejects.toThrow();
  await expect(f.call("search_messages", { query: "x", extra: "--delete" })).rejects.toThrow();
  await expect(f.call("get_message", { chat: "someone", message_id: "id" })).rejects.toThrow();
});

test("mutating tool arguments reject ambiguous names and unrelated receipt options", async () => {
  const f = fixture();
  await expect(f.call("send_text", { to: "Alice", message: "Hi" })).rejects.toThrow();
  await expect(f.call("whatsapp_cancel_link", { sessionId: "" })).rejects.toThrow();
  await expect(f.call("update_chat", { chat: "15551234567@s.whatsapp.net", action: "archive", receipts: true })).rejects.toThrow("mark-read");
  expect(f.calls).toHaveLength(0);
});

test("pairing PNG has intact chunks, grayscale scanlines, and a white quiet zone", () => {
  const png = pairingPng("synthetic-whatsapp-pairing-challenge");
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  expect(width).toBe(height); expect(width).toBeGreaterThan(150);
  let offset = 8; const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  expect(offset).toBe(png.length);
  const rows = inflateSync(Buffer.concat(data)); expect(rows.length).toBe((width + 1) * height);
  expect([...rows.subarray(1, width + 1)].every((byte) => byte === 255)).toBe(true);
  expect(rows.includes(0)).toBe(true);
});

test("MCP discovery and calls validate schemas and report tool errors through the protocol", async () => {
  const f = fixture(true);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await serveWhatsApp(f.account, serverTransport);
  const client = new Client({ name: "whatsapp-test", version: "1.0.0" });
  try {
    await client.connect(clientTransport);
    const inventory = await client.listTools();
    expect(inventory.tools.some((tool) => tool.name === "search_messages")).toBe(true);
    expect(inventory.tools.some((tool) => tool.name === "send_text")).toBe(false);
    const result = await client.callTool({ name: "list_chats", arguments: { query: "Ada", limit: 2 } });
    expect(result.isError).not.toBe(true); expect(f.calls.at(-1)?.args).toEqual(["chats", "list", "--limit", "2", "--query", "Ada"]);
    const invalid = await client.callTool({ name: "list_chats", arguments: { limit: 50000 } });
    expect(invalid.isError).toBe(true);
    const disabled = await client.callTool({ name: "send_text", arguments: { to: "15551234567", message: "Hi" } });
    expect(disabled.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

test("real stdio transports preserve WhatsApp reads, QR images, errors, and pairing cancellation", async () => {
  const home = await mkdtemp("/tmp/wa-stdio-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures/stdio-server.ts")],
    env: { WHATSAPP_TEST_HOME: home },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "whatsapp-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    expect(inventory.tools.some((entry) => entry.name === "whatsapp_start_link")).toBe(true);
    expect(inventory.tools.some((entry) => entry.name === "send_text")).toBe(false);
    const query = "literal \"quotes\"\nand newlines";
    const read = await client.callTool({ name: "list_chats", arguments: { query } });
    expect(JSON.parse((read.content as Array<{ text: string }>)[0]!.text).data.arguments).toContain(query);
    const pair = await client.callTool({ name: "whatsapp_start_link", arguments: {} });
    expect(pair.content).toHaveLength(1);
    const approval = JSON.parse((pair.content as Array<{ text: string }>)[0]!.text);
    expect(approval.qrCodeDataUrl).toStartWith("data:image/png;base64,");
    expect(Buffer.from(approval.qrCodeDataUrl.split(",")[1], "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(approval.sessionExpiresAt).toBeGreaterThan(approval.expiresAt);
    const finish = await client.callTool({ name: "whatsapp_finish_link", arguments: { sessionId: approval.sessionId } });
    expect(finish.isError).not.toBe(true);
    const status = await client.callTool({ name: "connection_status", arguments: {} });
    expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text).pairing_running).toBe(true);
    expect(JSON.stringify(status)).not.toContain("synthetic-stdio-pairing-challenge");
    const cancelled = await client.callTool({ name: "whatsapp_cancel_link", arguments: { sessionId: approval.sessionId } });
    expect(JSON.parse((cancelled.content as Array<{ text: string }>)[0]!.text).cancelled).toBe(true);
    const invalid = await client.callTool({ name: "list_chats", arguments: { limit: 1000 } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
  expect(stderr).toBe("");
}, 15000);
