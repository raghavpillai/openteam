import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pluginCatalog } from "../../../src";
import { WhatsAppAccount } from "../account";
import { installExecutable, prepareStore, settings, WacliProcess } from "../process";
import { whatsappTools } from "../tools";

// Explicit opt-in for a verified local release binary; never used by installed packages.
const executable = process.env.WHATSAPP_TEST_NATIVE_EXECUTABLE
  ?? (process.platform === "linux" ? await installExecutable(new URL("../../", import.meta.url).pathname) : undefined);
test.skipIf(!executable)("pinned native CLI initializes a store and serves real chat/search/context/cursor tools offline", async () => {
  const home = await mkdtemp("/tmp/wa-native-");
  const configuration = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "offline-native", WHATSAPP_MEDIA_ROOT: home }, home);
  const process = new WacliProcess(executable!, configuration);
  try {
    await prepareStore(configuration);
    const doctor = await process.execute(["doctor"]);
    expect(doctor.data.authenticated).toBe(false); expect(doctor.data.fts_enabled).toBe(true);
    const db = new Database(join(configuration.store, "wacli.db"));
    try {
      db.run("INSERT INTO chats(jid,kind,name,last_message_ts) VALUES (?,?,?,?)", ["15551234567@s.whatsapp.net", "dm", "Offline Ada", 1700000002]);
      db.run("INSERT INTO contacts(jid,phone,full_name,updated_at) VALUES (?,?,?,?)", ["15551234567@s.whatsapp.net", "15551234567", "Offline Ada", 1700000002]);
      for (let n = 0; n < 3; n++) db.run("INSERT INTO messages(chat_jid,msg_id,ts,from_me,text,display_text,sender_jid) VALUES (?,?,?,?,?,?,?)", ["15551234567@s.whatsapp.net", `MSG_${n}`, 1700000000 + n, 0, `invoice ${n}\nsecond line`, `invoice ${n}\nsecond line`, "15551234567@s.whatsapp.net"]);
    } finally { db.close(); }
    const tools = whatsappTools(new WhatsAppAccount(process, configuration));
    const call = (name: string, args: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.run(args) as Promise<any>;
    const chats = await call("list_chats", { query: "Ada" }); expect(JSON.stringify(chats)).toContain("Offline Ada");
    const contacts = await call("search_contacts", { query: "Ada" }); expect(JSON.stringify(contacts)).toContain("15551234567");
    const first = await call("list_messages", { chat: "15551234567@s.whatsapp.net", limit: 1 });
    expect(first.data.page.has_more).toBe(true); expect(first.data.source.scope).toBe("local_archive");
    const second = await call("list_messages", { chat: "15551234567@s.whatsapp.net", limit: 1, cursor: first.data.page.next_cursor });
    expect(second.data.messages[0].MsgID).not.toBe(first.data.messages[0].MsgID);
    const search = await call("search_messages", { query: "invoice", context_before: 1 });
    expect(search.data.messages).toHaveLength(3);
    const message = await call("get_message", { chat: "15551234567@s.whatsapp.net", message_id: "MSG_1" });
    expect(JSON.stringify(message)).toContain("invoice 1\\nsecond line");
    const context = await call("message_context", { chat: "15551234567@s.whatsapp.net", message_id: "MSG_1", before: 1, after: 1 });
    expect(JSON.stringify(context)).toContain("MSG_0"); expect(JSON.stringify(context)).toContain("MSG_2");
    const coverage = await call("history_coverage", { chat: "15551234567@s.whatsapp.net" }); expect(coverage.success).toBe(true);
  } finally { await process.close(); await rm(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("the packaged Linux entry point discovers tools, reads native history, and restarts over stdio", async () => {
  const home = await mkdtemp("/tmp/wa-package-");
  const packageRoot = join(home, "plugin");
  const plugin = pluginCatalog.find((entry) => entry.key === "whatsapp")!;
  for (const [path, content] of Object.entries(plugin.files ?? {})) {
    const destination = join(packageRoot, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, content);
  }
  for (const [path, content] of Object.entries(plugin.binaryFiles ?? {})) {
    const destination = join(packageRoot, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, Buffer.from(content, "base64"));
  }
  const configuration = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "packaged-native", OPENTEAM_PLUGIN_STATE_DIR: join(home, "managed"), WHATSAPP_MEDIA_ROOT: home }, home);
  let stderr = "";
  try {
    for (const readOnly of [true, false]) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, "connector/server.mjs"), `--read-only=${readOnly}`, "--max-messages=1234"],
        env: { HOME: home, OPENTEAM_PLUGIN_ACCOUNT_ID: configuration.accountId, OPENTEAM_PLUGIN_STATE_DIR: configuration.store, WHATSAPP_MEDIA_ROOT: home },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      const client = new Client({ name: "packaged-whatsapp-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const inventory = await client.listTools();
        expect(inventory.tools.some((entry) => entry.name === "send_text")).toBe(!readOnly);
        const status = await client.callTool({ name: "connection_status", arguments: {} });
        const value = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
        expect(value.authenticated).toBe(false);
        expect(value.pairing_running).toBe(false);
        expect(value.read_only).toBe(readOnly);
        if (readOnly) {
          const native = new WacliProcess(join(home, ".cache/openteam/whatsapp/v0.26.0/wacli"), configuration);
          try { await native.execute(["doctor"]); } finally { await native.close(); }
          const db = new Database(join(configuration.store, "wacli.db"));
          try {
            db.run("INSERT INTO chats(jid,kind,name,last_message_ts) VALUES (?,?,?,?)", ["15551234567@s.whatsapp.net", "dm", "Packaged Ada", 1700000000]);
          } finally { db.close(); }
        }
        const chats = await client.callTool({ name: "list_chats", arguments: { query: "Packaged Ada" } });
        expect(chats.isError).not.toBe(true);
        expect(JSON.stringify(chats)).toContain("Packaged Ada");
        if (!readOnly) {
          const send = await client.callTool({ name: "send_text", arguments: { to: "15551234567", message: "offline test" } });
          expect(send.isError).toBe(true);
          expect(JSON.stringify(send)).toContain("OpenTeam settings first");
        }
      } finally { await client.close(); }
    }
    expect(stderr).toBe("");
  } finally { await rm(home, { recursive: true, force: true }); }
}, 30000);
