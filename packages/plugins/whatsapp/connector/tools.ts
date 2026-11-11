import { ToolContent, integer, string, tool, type Args, type Tool } from "../../_shared/google";
import { WhatsAppAccount } from "./account";
import { attachmentPath, downloadPath } from "./process";

const chat = string("Exact chat JID returned by list_chats. Resolve ambiguous names first.", { minLength: 1, maxLength: 200, pattern: "^[0-9][0-9-]*@(s\\.whatsapp\\.net|g\\.us|lid|newsletter)$" });
const id = string("Exact message ID returned by a message tool", { minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" });
const text = (description: string, maxLength = 2000) => string(description, { minLength: 1, maxLength });
const recipient = string("International phone number or exact chat JID. Find contacts/chats first; do not guess identities.", {
  minLength: 5, maxLength: 200, pattern: "^(\\+?[0-9]{5,15}|[0-9][0-9-]*@(s\\.whatsapp\\.net|g\\.us|lid|newsletter))$",
});
const limit = integer("Maximum results; defaults to 20", 100);
const cursor = string("Opaque next_cursor from the previous page; repeat its original query and filters", { maxLength: 16384 });
const date = string("YYYY-MM-DD or RFC3339 timestamp with timezone", { maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2}))?$" });
const bool = (description: string) => ({ type: "boolean", description });
const listProperties = { chat, after: date, before: date, limit, cursor };
const flags = (args: Args, names: Record<string, string>) => Object.entries(names).flatMap(([key, flag]) =>
  args[key] === undefined ? [] : typeof args[key] === "boolean" ? args[key] ? [flag] : [] : [flag, String(args[key])]);
const commonFlags = (args: Args) => ["--limit", String(args.limit ?? 20), ...flags(args, { chat: "--chat", after: "--after", before: "--before", cursor: "--cursor" })];

export function whatsappTools(account: WhatsAppAccount): Tool[] {
  const read = (args: string[]) => account.read(args);
  const tools: Tool[] = [
    tool("connection_status", "Inspect this WhatsApp account's pairing, background sync, storage, and local history health. Connector availability does not prove WhatsApp is linked or current.", {}, [], () => account.status()),
    ...[
      tool("whatsapp_start_link", "Start QR approval in account settings.", {}, [], () => account.startLink(), "write"),
      tool("whatsapp_finish_link", "Continue the background device approval.", { sessionId: text("Active approval session ID", 128) }, ["sessionId"], (a) => account.finishLink(a.sessionId), "write"),
      tool("whatsapp_link_status", "Inspect device approval and collector readiness.", {}, [], () => account.linkStatus()),
      tool("whatsapp_cancel_link", "Stop the matching device approval.", { sessionId: text("Active approval session ID", 128) }, ["sessionId"], (a) => account.cancelLink(a.sessionId), "write"),
      tool("whatsapp_remove_account", "Stop account use before private state removal.", {}, [], () => account.removeAccount(), "destructive"),
    ].map((entry) => ({ ...entry, _meta: { "openteam/hostOnly": true },
      run: async (args: Args) => new ToolContent([{ type: "text", text: JSON.stringify(await entry.run(args)) }]) })),
    tool("restart_sync", "Restart this account's background sync after troubleshooting. Does not pair or send messages.", {}, [], () => account.restart(), "write"),
    tool("list_chats", "Find retained WhatsApp chats by name or number, and inspect unread, archive, pin, and mute state. Reads local data without marking messages read.", {
      query: text("Partial chat name or number"), limit, unread: bool("Only unread chats"), archived: bool("Only archived chats"),
    }, [], (a) => read(["chats", "list", "--limit", String(a.limit ?? 20), ...flags(a, { query: "--query", unread: "--unread", archived: "--archived" })])),
    tool("get_chat", "Inspect a single retained chat by its exact JID.", { chat }, ["chat"], (a) => read(["chats", "show", "--jid", a.chat])),
    tool("search_contacts", "Search synced contacts and aliases before choosing a message recipient. Returns exact JIDs; multiple matches require disambiguation.", { query: text("Contact name, alias, or phone number"), limit }, ["query"], (a) => read(["contacts", "search", "--limit", String(a.limit ?? 20), "--", a.query])),
    tool("get_contact", "Inspect one synced contact by JID.", { contact: chat }, ["contact"], (a) => read(["contacts", "show", "--jid", a.contact])),
    tool("list_messages", "Read retained WhatsApp messages with date filters and cursor paging. Does not send read receipts. Results include available local-history freshness and pagination metadata.", {
      ...listProperties, sender: chat, ascending: bool("Oldest first; defaults to newest first"), from_me: bool("Only messages sent by this account"),
    }, [], (a) => read(["messages", "list", ...commonFlags(a), ...flags(a, { sender: "--sender", ascending: "--asc", from_me: "--from-me" })])),
    tool("search_messages", "Search retained message text and captions. Context may fall outside the query's date filters. Empty results do not prove WhatsApp has no older messages.", {
      ...listProperties, query: text("Text search query"), sender: chat, has_media: bool("Only messages with media"),
      media_type: string("Filter media type", { enum: ["text", "image", "video", "audio", "document"] }),
      context_before: integer("Messages before each match", 10, 0), context_after: integer("Messages after each match", 10, 0),
    }, ["query"], (a) => read(["messages", "search", ...commonFlags(a), ...flags(a, { sender: "--from", has_media: "--has-media", media_type: "--type", context_before: "--context-before", context_after: "--context-after" }), "--", a.query])),
    tool("get_message", "Read or verify one message using both chat JID and message ID. A stored outgoing message or send acknowledgement does not prove delivery.", { chat, message_id: id }, ["chat", "message_id"], (a) => read(["messages", "show", "--chat", a.chat, "--id", a.message_id])),
    tool("message_context", "Read neighboring retained messages around one exact message.", {
      chat, message_id: id, before: integer("Earlier messages", 20, 0), after: integer("Later messages", 20, 0),
    }, ["chat", "message_id"], (a) => read(["messages", "context", "--chat", a.chat, "--id", a.message_id, "--before", String(a.before ?? 5), "--after", String(a.after ?? 5)])),
    tool("history_coverage", "Inspect how much history is retained per chat before claiming completeness or requesting backfill.", { chat, query: text("Filter chat names or JIDs"), limit }, [], (a) => read(["history", "coverage", "--limit", String(a.limit ?? 20), ...flags(a, { chat: "--chat", query: "--query" })])),
    tool("download_media", "Download an attachment from one synced message into the account's folder on the bot computer. Returns its local path; does not send read receipts. This writes a local file, including in read-only account mode.", { chat, message_id: id }, ["chat", "message_id"], async (a) => {
      const output = await downloadPath(account.settings);
      const result = await read(["media", "download", "--chat", a.chat, "--id", a.message_id, "--output", output]);
      return { ...result, output_path: output };
    }, "write"),
  ];
  if (!account.settings.readOnly) tools.push(
    tool("send_text", "Send text as this WhatsApp account to the user's intended recipient. Supports quoted replies. Preserve literal newlines. WhatsApp acceptance returns a message ID, not proof of delivery; never automatically retry an uncertain send.", {
      to: recipient, message: text("Exact message text, preserving actual newlines", 65536), reply_to: id,
      allow_self: bool("Explicitly attempt a message to this account itself; delivery is not guaranteed"),
    }, ["to", "message"], (a) => account.write(["send", "text", "--to", a.to, "--message", a.message, "--no-preview", ...flags(a, { reply_to: "--reply-to", allow_self: "--allow-self" })]), "write"),
    tool("send_file", "Send an existing file from the configured attachment folder on the bot computer. Supports captions and quoted replies. Maximum 100 MiB. Never automatically retry uncertain sends.", {
      to: recipient, path: text("Absolute path inside the account's configured attachment folder", 2048),
      caption: string("Optional caption", { maxLength: 65536 }), filename: text("Recipient-visible filename", 200), reply_to: id,
      as: string("How WhatsApp should present the file", { enum: ["auto", "document", "audio", "image", "video"] }),
    }, ["to", "path"], async (a) => {
      const file = await attachmentPath(account.settings, a.path);
      return account.write(["send", "file", "--to", a.to, "--file", file.path, ...flags(a, { caption: "--caption", filename: "--filename", as: "--as", reply_to: "--reply-to" })], 120000);
    }, "write"),
    tool("react_to_message", "Add, replace, or remove this account's reaction to a message. Use an empty reaction to remove it; group reactions may need the original sender JID.", {
      to: recipient, message_id: id, reaction: string("Emoji, or empty string to remove the reaction", { maxLength: 32 }), sender: chat,
    }, ["to", "message_id", "reaction"], (a) => account.write(["send", "react", "--to", a.to, "--id", a.message_id, "--reaction", a.reaction, ...flags(a, { sender: "--sender" })]), "write"),
    tool("edit_message", "Edit this account's own recent sent text message within WhatsApp's edit window. Use only when the user intends to change that message.", { chat, message_id: id, message: text("Replacement text", 65536) }, ["chat", "message_id", "message"],
      (a) => account.write(["messages", "edit", "--chat", a.chat, "--id", a.message_id, "--message", a.message]), "write"),
    tool("update_chat", "Change archive, pin, mute, or read state on WhatsApp. Reading messages alone never calls this. Receipts can notify senders when explicitly requested.", {
      chat, action: string("Requested change", { enum: ["archive", "unarchive", "pin", "unpin", "mute", "unmute", "mark-read", "mark-unread"] }),
      duration: string("Mute duration such as 8h or 168h; omitted means forever", { maxLength: 20, pattern: "^[0-9]+(ms|s|m|h)?$" }),
      through_message_id: id, receipts: bool("For mark-read only: send read receipts, subject to WhatsApp privacy settings"),
    }, ["chat", "action"], (a) => {
      if (a.duration !== undefined && a.action !== "mute") throw new Error("duration applies only to mute.");
      if ((a.through_message_id !== undefined || a.receipts !== undefined) && a.action !== "mark-read") throw new Error("Receipt and message-boundary options apply only to mark-read.");
      return account.write(["chats", a.action, "--chat", a.chat, ...flags(a, { duration: "--duration", through_message_id: "--through-message-id", receipts: "--receipts" })]);
    }, "write"),
    tool("backfill_history", "Request older history for one chat from the primary phone. Briefly pauses this account's sync and resumes it afterwards. Best-effort, bounded, and requires an online phone with the history still available.", {
      chat, requests: integer("Maximum backfill requests; defaults to 1", 3), count: integer("Messages requested per batch; defaults to 50", 100),
    }, ["chat"], (a) => account.backfill(["history", "backfill", "--chat", a.chat, "--requests", String(a.requests ?? 1), "--count", String(a.count ?? 50)]), "write"),
  );
  return tools;
}
