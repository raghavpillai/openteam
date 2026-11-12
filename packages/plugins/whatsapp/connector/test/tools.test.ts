import { expect, test } from "bun:test";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { WhatsAppAccount } from "../account";
import { settings } from "../process";
import { whatsappTools } from "../tools";

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
