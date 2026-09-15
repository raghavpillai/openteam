import { NativeContacts } from "./contacts";
import {
  decodeMessageBody,
  normalizeMessageRow,
  messageDate,
  messageTimestamp,
} from "./message-body";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { readFile, realpath, stat, mkdtemp, rm } from "node:fs/promises";
import { nativeCommand, sqliteRows, sqlText, type NativeCommand } from "./native-command";

const APPLE_EPOCH = Date.UTC(2001, 0, 1);
function required(args: Record<string, any>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].trim() || args[key].length > 16_000)
    throw new Error(`${key} is required and must be at most 16000 characters`);
  return args[key];
}
export function validateMessageSend(args: Record<string, any>) {
  if (typeof args.text !== "string" || args.text.length === 0) throw new Error("text is required");
  if (Boolean(args.to) === Boolean(args.chatId))
    throw new Error("Provide exactly one of to or chatId");
  if (args.to && !/^\+[1-9]\d{6,14}$/.test(args.to) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.to))
    throw new Error("Recipient must be an E.164 number or email from Contacts");
  if (args.chatId && !/^(?:iMessage|SMS);[+-];[^\r\n]+$/.test(args.chatId))
    throw new Error("Use a chat GUID from FindIMessageChats");
  if (args.service !== undefined && !["auto", "iMessage", "SMS"].includes(args.service))
    throw new Error("Invalid message service");
}

export class MacMessages {
  constructor(
    private readonly run: NativeCommand = nativeCommand,
    private readonly root = join(homedir(), "Library", "Messages")
  ) {}
  people(handles: string[], signal?: AbortSignal) {
    return new NativeContacts(this.run).people(handles, signal);
  }
  private query(query: string, signal?: AbortSignal) {
    return sqliteRows(this.run, join(this.root, "chat.db"), query, signal);
  }
  async execute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (name === "CheckIMessagePermissions") {
      let fullDiskAccess = false;
      let automation: "granted" | "notAsked" | "denied" = "notAsked";
      let contacts: "granted" | "denied" = "denied";
      try {
        await this.query("SELECT ROWID FROM message LIMIT 1", signal);
        fullDiskAccess = true;
      } catch {
        /* Report each independently. */
      }
      try {
        await this.run(
          "/usr/bin/osascript",
          ["-e", 'tell application "Messages" to get version'],
          signal
        );
        automation = "granted";
      } catch {
        automation = "denied";
      }
      try {
        const status = await this.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('Contacts'); Number($.CNContactStore.authorizationStatusForEntityType(0))"], signal);
        contacts = Number(status.trim()) === 3 ? "granted" : "denied";
      } catch { /* Permission metadata is unavailable. */ }
      return { kind: "check-permissions", version: "openteam-messages-1", verbs: ["find-contacts", "find-chats", "items", "search", "activity", "fetch-attachment", "send", "check-permissions"], fullDiskAccess, automation, contacts };
    }
    if (name === "FindContacts") {
      const query = required(args, "query");
      return new NativeContacts(this.run).find(query, signal);
    }
    if (name === "SendIMessage") {
      validateMessageSend(args);
      if (
        args.chatId &&
        !(
          await this.query(
            `SELECT guid FROM chat WHERE guid=${sqlText(args.chatId)} LIMIT 1`,
            signal
          )
        ).length
      )
        throw new Error("Chat GUID is no longer available");
      const previousId = await this.query("SELECT COALESCE(MAX(ROWID),0) id FROM message", signal)
        .then((rows) => Number(rows[0]?.id ?? 0))
        .catch(() => null);
      // argv carries the exact body and handle: never concatenate user text into AppleScript source.
      const script = `on run argv
set bodyText to item 1 of argv
set recipient to item 2 of argv
set targetKind to item 3 of argv
set requestedService to item 4 of argv
tell application "Messages"
if targetKind is "chat" then
send bodyText to chat id recipient
else
if requestedService is "SMS" then
set targetService to first service whose service type is SMS
else
set targetService to first service whose service type is iMessage
end if
try
send bodyText to buddy recipient of targetService
on error errorMessage number errorNumber
if requestedService is "auto" and (errorMessage contains "not registered with iMessage" or errorMessage contains "not on iMessage") then
set targetService to first service whose service type is SMS
send bodyText to buddy recipient of targetService
else
error errorMessage number errorNumber
end if
end try
end if
end tell
return "submitted"
end run`;
      await this.run(
        "/usr/bin/osascript",
        [
          "-e",
          script,
          args.text,
          args.chatId ?? args.to,
          args.chatId ? "chat" : "participant",
          args.service ?? "auto",
        ],
        signal
      );
      let verified = false;
      if (previousId !== null) {
        try {
          const rows = await this.query(
            `SELECT m.guid,m.text,hex(m.attributedBody) bodyHex FROM message m WHERE m.ROWID>${previousId} AND m.is_from_me=1 AND ${args.chatId ? `EXISTS(SELECT 1 FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID AND c.guid=${sqlText(args.chatId)})` : `EXISTS(SELECT 1 FROM chat_message_join cm JOIN chat_handle_join ch ON ch.chat_id=cm.chat_id JOIN handle h ON h.ROWID=ch.handle_id WHERE cm.message_id=m.ROWID AND h.id=${sqlText(args.to)})`} ORDER BY m.ROWID DESC LIMIT 25`,
            signal
          );
          verified = rows.some(
            (row) => decodeMessageBody(row.text, row.bodyHex)?.text === args.text
          );
        } catch {
          /* A submitted send must never be repeated because history is unavailable. */
        }
      }
      return {
        kind: "send",
        text: args.text,
        ...(args.to ? { to: args.to } : { chatId: args.chatId }),
        verified,
        via: args.chatId ? "chat_id" : "participant",
        service: args.chatId?.split(";")[0] ?? args.service ?? "auto",

      };
    }
    if (name === "FetchIMessageAttachment") {
      const rows = await this.query(
        `SELECT a.filename,a.mime_type,a.transfer_name,a.total_bytes FROM attachment a JOIN message_attachment_join ma ON ma.attachment_id=a.ROWID JOIN message m ON m.ROWID=ma.message_id WHERE m.guid=${sqlText(required(args, "messageGuid"))} AND a.guid=${sqlText(required(args, "attachmentGuid"))} LIMIT 1`,
        signal
      );
      const item = rows[0];
      if (!item?.filename)
        throw new Error("Attachment is unavailable or has not downloaded to this Mac");
      const path = await realpath(String(item.filename).replace(/^~\//, `${homedir()}/`));
      const allowed = await realpath(join(this.root, "Attachments"));
      if (!path.startsWith(allowed + sep))
        throw new Error("Attachment is outside the Messages attachment directory");
      const info = await stat(path);
      if (!info.isFile() || info.size > 100 * 1024 * 1024)
        throw new Error("Attachment is not a regular file or exceeds 100 MiB");
      if (
        /\.heic$/i.test(path) ||
        item.mime_type === "image/heic" ||
        item.mime_type === "image/heif"
      ) {
        const directory = await mkdtemp(join(tmpdir(), "openteam-message-image-"));
        try {
          const target = join(directory, "image.jpg");
          await this.run("/usr/bin/sips", ["-s", "format", "jpeg", path, "--out", target], signal);
          return {
            filename: basename(item.transfer_name || path).replace(/\.hei[cf]$/i, ".jpg"),
            mime: "image/jpeg",
            bytesBase64: (await readFile(target)).toString("base64"),
            convertedFrom: item.mime_type || "image/heic",
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      return {
        filename: basename(item.transfer_name || path),
        mime: item.mime_type || "application/octet-stream",
        bytesBase64: (await readFile(path)).toString("base64"),
      };
    }
    const limits = name === "SearchIMessages" ? { default: 25, max: 100 } : name === "FindIMessageChats" ? { default: 50, max: 500 } : { default: 50, max: 200 };
    const limit = args.limit === undefined ? limits.default : Math.min(limits.max, Number(args.limit));
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (name === "FindIMessageChats") {
      const where = ["1=1"];
      if (args.displayName !== undefined)
        where.push(`c.display_name=${sqlText(required(args, "displayName"))}`);
      if (args.handle !== undefined)
        where.push(
          `EXISTS(SELECT 1 FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID AND h.id=${sqlText(required(args, "handle"))})`
        );
      const rows = await this.query(
        `SELECT COUNT(*) OVER() total,c.ROWID id,c.guid,c.chat_identifier identifier,c.display_name displayName,c.service_name service,(SELECT CAST(MAX(m.date) AS TEXT) FROM chat_message_join cm JOIN message m ON m.ROWID=cm.message_id WHERE cm.chat_id=c.ROWID) latestDate,(SELECT json_group_array(h.id) FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID) handles FROM chat c WHERE ${where.join(" AND ")} ORDER BY (SELECT MAX(m.date) FROM chat_message_join cm JOIN message m ON m.ROWID=cm.message_id WHERE cm.chat_id=c.ROWID) DESC,c.ROWID DESC LIMIT ${limit + 1}`,
        signal
      );
      return {
        kind: "find-chats",
        chats: rows
          .slice(0, limit)
          .map(({ total, ...row }) => ({
            ...row,
            latestDate: messageDate(row.latestDate),
            handles: JSON.parse(row.handles),
          })),
        ...(rows.length > limit ? { truncated: "count" } : {}),
        total: Number(rows[0]?.total ?? 0),
        people: {},
      };
    }
    if (name === "IMessageActivity") {
      const since = messageTimestamp(required(args, "since"));
      const until =
        args.until === undefined
          ? BigInt(Date.now() - APPLE_EPOCH) * 1_000_000n
          : messageTimestamp(args.until);
      if (until <= since) throw new Error("until must be after since");
      const rows = await this.query(
        `SELECT c.guid chatGuid,c.display_name displayName,COUNT(*) count,SUM(m.is_from_me) sent,CAST(MAX(m.date) AS TEXT) latestDate,(SELECT json_group_array(h.id) FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID) handles FROM message m JOIN chat_message_join cm ON cm.message_id=m.ROWID JOIN chat c ON c.ROWID=cm.chat_id WHERE m.date>=${since} AND m.date<${until} GROUP BY c.ROWID ORDER BY MAX(m.date) DESC`,
        signal
      );
      return {
        kind: "activity",
        items: rows.map((row) => ({
          chatGuid: row.chatGuid, count: row.count,
          ...(row.displayName ? { displayName: row.displayName } : {}),
          handles: JSON.parse(row.handles ?? "[]"),
        })),
        people: {},
      };
    }
    if (!["ChatItems", "SearchIMessages"].includes(name)) throw new Error("Unknown Messages tool");
    const where = ["1=1"];
    if (args.chatGuid !== undefined)
      where.push(
        `EXISTS(SELECT 1 FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID AND c.guid=${sqlText(required(args, "chatGuid"))})`
      );
    if (args.before !== undefined) {
      if (!Number.isSafeInteger(args.before?.id)) throw new Error("Invalid paging cursor");
      const time = messageTimestamp(args.before.date);
      where.push(`(m.date<${time} OR (m.date=${time} AND m.ROWID<${args.before.id}))`);
    }
    const columns = new Set(
      (await this.query("PRAGMA table_info(message)", signal)).map((c) => c.name)
    );
    const optional = [
      "associated_message_guid",
      "associated_message_type",
      "thread_originator_guid",
      "date_edited",
      "date_retracted",
      "is_system_message",
      "item_type",
    ]
      .filter((c) => columns.has(c))
      .map((c) => (c.startsWith("date_") ? `CAST(m.${c} AS TEXT) ${c}` : `m.${c}`))
      .join(",");
    const bodyColumn = columns.has("attributedBody") ? "hex(m.attributedBody)" : "NULL";
    const select = `SELECT m.ROWID id,m.guid,m.text,${bodyColumn} bodyHex,CAST(m.date AS TEXT) date,m.is_from_me isFromMe,m.service,CASE WHEN m.is_from_me=1 THEN (SELECT CASE WHEN COUNT(DISTINCT h2.id)=1 THEN MIN(h2.id) ELSE NULL END FROM chat_message_join cm2 JOIN chat_handle_join ch2 ON ch2.chat_id=cm2.chat_id JOIN handle h2 ON h2.ROWID=ch2.handle_id WHERE cm2.message_id=m.ROWID) ELSE h.id END handle${optional ? "," + optional : ""},(SELECT json_group_array(c.guid) FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID) chatGuids,(SELECT json_group_array(json_object('guid',a.guid,'filename',a.transfer_name,'mime',a.mime_type,'sizeBytes',a.total_bytes)) FROM message_attachment_join ma JOIN attachment a ON a.ROWID=ma.attachment_id WHERE ma.message_id=m.ROWID) attachments FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id`;
    const query = name === "SearchIMessages" ? required(args, "query").toLocaleLowerCase() : null;
    let total = 0;
    let size = 0;
    const items: Array<Record<string, any>> = [];
    let cursor = "";
    let sizeExceeded = false;
    // Bounded batches keep binary attributed bodies out of model context and
    // make search cover both legacy text and current archived bodies.
    for (;;) {
      signal?.throwIfAborted();
      const rows = await this.query(
        `${select} WHERE ${where.join(" AND ")} ${cursor} ORDER BY m.date DESC,m.ROWID DESC LIMIT ${query ? 500 : limit + 1}`,
        signal
      );
      for (const row of rows) {
        const item = normalizeMessageRow(row);
        if (query && !item.body?.text.toLocaleLowerCase().includes(query)) continue;
        total++;
        if (items.length >= limit || sizeExceeded) continue;
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (size + bytes > 100_000) {
          sizeExceeded = true;
          continue;
        }
        size += bytes;
        items.push(item);
      }
      if (!query) {
        total = Number(
          (
            await this.query(
              `SELECT COUNT(*) count FROM message m WHERE ${where.join(" AND ")}`,
              signal
            )
          )[0]?.count ?? total
        );
        break;
      }
      if (rows.length < 500) break;
      const last = rows.at(-1)!;
      cursor = `AND (m.date<${BigInt(last.date)} OR (m.date=${BigInt(last.date)} AND m.ROWID<${Number(last.id)}))`;
    }
    const oldest = items.at(-1);
    const truncated = total > items.length;
    return {
      kind: name === "ChatItems" ? "items" : "search",
      items: items.reverse(),
      total,
      people: {},
      ...(truncated
        ? {
            truncated: sizeExceeded ? "bytes" : "count",
            ...(oldest ? { nextBefore: { date: oldest.date, id: oldest.id } } : {}),
          }
        : {}),
    };
  }
}
