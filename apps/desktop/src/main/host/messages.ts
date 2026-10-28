import { NativeContacts } from "./contacts";
import { isoMs, messageBody, messageDate, messageMsSql, wireAttachment } from "./message-body";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { readFile, realpath, stat, mkdtemp, rm } from "node:fs/promises";
import { nativeCommand, NativeCommandError, sqliteRows, sqlText, type NativeCommand } from "./native-command";
import { validateMessageSend } from "@openteam/contracts/messages-send";

/** Page sizes and the per-result character budget every Messages read shares. */
const PAGE_LIMITS = {
  items: { default: 50, max: 200 },
  search: { default: 25, max: 100 },
  "find-chats": { default: 50, max: 500 },
} as const;
const RESULT_CHAR_BUDGET = 64_000;
const TAPBACK = "COALESCE(m.associated_message_type,0) BETWEEN 2000 AND 3999";
/** A chat's participant handles in the order Messages joined them. */
const HANDLES = "(SELECT json_group_array(id) FROM (SELECT h.id FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID ORDER BY ch.ROWID))";
const IN_CHAT = "FROM message m JOIN chat_message_join cmj ON cmj.message_id=m.ROWID JOIN chat c ON c.ROWID=cmj.chat_id";
/** Byte values of a one-byte blob, for reading archive lengths in SQL. */
const BYTE_TABLE = `X'${Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join("")}'`;
const byteAt = (blob: string, at: string) => `(instr(${BYTE_TABLE},substr(${blob},${at},1))-1)`;
/** Lowercases like the search filter, folding the two non-ASCII letters whose lowercase is ASCII. */
const foldSql = (expression: string) =>
  `lower(replace(replace(COALESCE(${expression},''),char(304),'i'),char(8490),'k'))`;

function required(args: Record<string, any>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].trim() || args[key].length > 16_000)
    throw new Error(`${key} is required and must be at most 16000 characters`);
  return args[key];
}
function clampedLimit(value: unknown, limits: { default: number; max: number }) {
  if (value !== undefined && !Number.isInteger(value)) throw new Error("limit must be a positive integer");
  return Math.min(Math.max(1, (value as number | undefined) ?? limits.default), limits.max);
}
/** Takes newest-first items up to the limit and the character budget, always keeping the first. */
function take<T>(newestFirst: T[], limit: number) {
  const taken: T[] = [];
  let chars = 2;
  for (const item of newestFirst) {
    if (taken.length >= limit) return { taken, cause: "limit" as const };
    const size = JSON.stringify(item).length + (taken.length > 0 ? 1 : 0);
    if (taken.length > 0 && chars + size > RESULT_CHAR_BUDGET) return { taken, cause: "bytes" as const };
    taken.push(item);
    chars += size;
  }
  return { taken, cause: undefined };
}
function cursor(before: unknown) {
  if (before === undefined) return undefined;
  const value = before as { date?: unknown; id?: unknown } | null;
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.id))
    throw new Error("Invalid paging cursor");
  return { ms: isoMs(value.date, "before.date"), id: value.id as number };
}
type Tapback = { type: number; fromMe: boolean; date: string; emoji?: string; handle?: string };
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
try
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
on error errorMessage number errorNumber
-- macOS refused Automation before anything was sent; report it on stdout instead of failing.
if errorNumber is -1743 then return "automation_denied"
error errorMessage number errorNumber
end try
return "submitted"
end run`;
      const submitted = await this.run(
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
      if (submitted.trim() === "automation_denied")
        throw new NativeCommandError("macOS refused to let OpenTeam control Messages (Automation)", "automation_denied");
      let verified = false;
      if (previousId !== null) {
        try {
          const rows = await this.query(
            `SELECT m.guid,m.text,hex(m.attributedBody) bodyHex FROM message m WHERE m.ROWID>${previousId} AND m.is_from_me=1 AND ${args.chatId ? `EXISTS(SELECT 1 FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID AND c.guid=${sqlText(args.chatId)})` : `EXISTS(SELECT 1 FROM chat_message_join cm JOIN chat_handle_join ch ON ch.chat_id=cm.chat_id JOIN handle h ON h.ROWID=ch.handle_id WHERE cm.message_id=m.ROWID AND h.id=${sqlText(args.to)})`} ORDER BY m.ROWID DESC LIMIT 25`,
            signal
          );
          verified = rows.some(
            (row) => messageBody(row.text, row.bodyHex).text === args.text
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
    if (name === "FindIMessageChats") return this.findChats(args, signal);
    if (name === "IMessageActivity") return this.activity(args, signal);
    if (name === "ChatItems") return this.items(args, signal);
    if (name === "SearchIMessages") return this.search(args, signal);
    throw new Error("Unknown Messages tool");
  }

  private schema?: Promise<{ message: Set<string>; attachment: Set<string>; utf8: boolean }>;
  /** Columns vary across macOS releases; absent ones read as NULL. */
  private columns(signal?: AbortSignal) {
    this.schema ??= this.query(
      "SELECT 'message' tbl,name FROM pragma_table_info('message') UNION ALL SELECT 'attachment',name FROM pragma_table_info('attachment') UNION ALL SELECT 'encoding',encoding FROM pragma_encoding",
      signal
    ).then((rows) => ({
      message: new Set(rows.filter((r) => r.tbl === "message").map((r) => r.name)),
      attachment: new Set(rows.filter((r) => r.tbl === "attachment").map((r) => r.name)),
      utf8: rows.some((r) => r.tbl === "encoding" && r.name === "UTF-8"),
    }));
    this.schema.catch(() => (this.schema = undefined));
    return this.schema;
  }

  private async findChats(args: Record<string, any>, signal?: AbortSignal) {
    const limit = clampedLimit(args.limit, PAGE_LIMITS["find-chats"]);
    const where = ["1=1"];
    if (args.displayName !== undefined && required(args, "displayName"))
      where.push(`COALESCE(c.display_name,'')=${sqlText(args.displayName)}`);
    if (args.handle !== undefined && required(args, "handle"))
      where.push(
        `(c.chat_identifier=${sqlText(args.handle)} OR EXISTS(SELECT 1 FROM chat_handle_join ch JOIN handle h ON h.ROWID=ch.handle_id WHERE ch.chat_id=c.ROWID AND h.id=${sqlText(args.handle)}))`
      );
    const rows = await this.query(
      `SELECT COUNT(*) OVER() total,c.ROWID id,c.guid,c.chat_identifier identifier,c.display_name displayName,c.service_name service,${HANDLES} handles,l.lastDate FROM chat c LEFT JOIN (SELECT chat_id,CAST(MAX(message_date) AS TEXT) lastDate FROM chat_message_join GROUP BY chat_id) l ON l.chat_id=c.ROWID WHERE ${where.join(" AND ")} ORDER BY ${messageMsSql("l.lastDate")}=0,${messageMsSql("l.lastDate")} DESC,c.ROWID LIMIT ${limit + 1}`,
      signal
    );
    const chats = rows.map((row) => {
      const lastDate = messageDate(row.lastDate);
      return {
        id: Number(row.id),
        guid: row.guid,
        identifier: row.identifier,
        ...(row.displayName ? { displayName: row.displayName } : {}),
        service: row.service,
        handles: JSON.parse(row.handles ?? "[]"),
        ...(lastDate ? { lastDate } : {}),
      };
    });
    const { taken, cause } = take(chats, limit);
    return {
      kind: "find-chats",
      chats: taken,
      total: Number(rows[0]?.total ?? 0),
      ...(cause ? { truncated: cause } : {}),
      people: {},
    };
  }

  private async activity(args: Record<string, any>, signal?: AbortSignal) {
    const seconds = (ms: number) => ms / 1000 - 978_307_200;
    const since = seconds(isoMs(required(args, "since"), "since"));
    const until = args.until === undefined ? undefined : seconds(isoMs(args.until, "until"));
    if (until !== undefined && until <= since) throw new Error("until must be after since");
    // Tapbacks and group events are not conversation activity.
    const rows = await this.query(
      `SELECT a.chatGuid,a.count,c.display_name displayName,${HANDLES} handles FROM (SELECT chatGuid,COUNT(*) count,MAX(seconds) latest FROM (SELECT c.guid chatGuid,CASE WHEN m.date>1e12 THEN m.date/1e9 ELSE m.date END seconds ${IN_CHAT} WHERE NOT ${TAPBACK} AND COALESCE(m.item_type,0)=0) WHERE seconds>=${since}${until === undefined ? "" : ` AND seconds<${until}`} GROUP BY chatGuid) a LEFT JOIN chat c ON c.guid=a.chatGuid ORDER BY a.latest DESC`,
      signal
    );
    return {
      kind: "activity",
      items: rows.map((row) => ({
        chatGuid: row.chatGuid,
        count: Number(row.count),
        handles: JSON.parse(row.handles ?? "[]"),
        ...(row.displayName ? { displayName: row.displayName } : {}),
      })),
      people: {},
    };
  }

  private async items(args: Record<string, any>, signal?: AbortSignal) {
    const limit = clampedLimit(args.limit, PAGE_LIMITS.items);
    const before = cursor(args.before);
    const scope = args.chatGuid === undefined ? "1=1" : `c.guid=${sqlText(required(args, "chatGuid"))}`;
    const key = messageMsSql("m.date");
    const below = before ? ` AND (${key}<${before.ms} OR (${key}=${before.ms} AND m.ROWID<${before.id}))` : "";
    const rows = await this.query(
      `SELECT (SELECT COUNT(*) ${IN_CHAT} WHERE ${scope} AND NOT ${TAPBACK}) total,m.ROWID id,cmj.chat_id chatId ${IN_CHAT} WHERE ${scope} AND NOT ${TAPBACK}${below} ORDER BY ${key} DESC,m.ROWID DESC LIMIT ${limit + 1}`,
      signal
    );
    const total = rows.length
      ? Number(rows[0]!.total)
      : Number((await this.query(`SELECT COUNT(*) total ${IN_CHAT} WHERE ${scope} AND NOT ${TAPBACK}`, signal))[0]?.total ?? 0);
    const page = await this.page(rows, limit, scope, signal);
    return { kind: "items", ...this.envelope(page, total) };
  }

  private async search(args: Record<string, any>, signal?: AbortSignal) {
    const limit = clampedLimit(args.limit, PAGE_LIMITS.search);
    const before = cursor(args.before);
    const needle = required(args, "query").toLowerCase();
    const { utf8 } = await this.columns(signal);
    let matches: Array<Record<string, any>>;
    if (utf8 && /^[\x00-\x7f]*$/.test(needle)) {
      // Superset pre-filter on the raw columns, then the exact test on the text the body decodes
      // to: the archive's first string, placeholders removed, or the text column without one.
      const b = "m.attributedBody";
      const at = (offset: number) => `p+${offset}`;
      const head = byteAt("b", at(2));
      const word = (from: number, bytes: number) =>
        Array.from({ length: bytes }, (_, i) => `${byteAt("b", at(from + i))}*${256 ** i}`).join("+");
      const archived = `CAST(CASE WHEN ${head}<128 OR ${head}>=146 THEN substr(b,${at(3)},${head}) WHEN ${head}=129 THEN substr(b,${at(5)},${word(3, 2)}) WHEN ${head}=130 THEN substr(b,${at(7)},${word(3, 4)}) ELSE X'' END AS TEXT)`;
      const n = sqlText(needle);
      matches = await this.query(
        `WITH s AS (SELECT m.ROWID id,cmj.chat_id chatId,${messageMsSql("m.date")} ms,m.text text,${b} b,instr(${b},X'012B') p ${IN_CHAT} WHERE NOT ${TAPBACK} AND COALESCE(m.item_type,0)=0 AND (instr(${foldSql("m.text")},${n})>0 OR instr(${foldSql(`replace(CAST(${b} AS TEXT),char(65532),'')`)},${n})>0)), t AS (SELECT id,chatId,ms,CASE WHEN b IS NULL OR length(b)=0 THEN COALESCE(text,'') WHEN p=0 THEN '' ELSE replace(${archived},char(65532),'') END body FROM s) SELECT id,chatId,ms FROM t WHERE instr(${foldSql("body")},${n})>0`,
        signal
      );
    } else {
      // Needles SQL cannot fold exactly: decode every body in bounded batches.
      matches = [];
      for (let last = { id: 0, chatId: -1 }; ; ) {
        signal?.throwIfAborted();
        const rows = await this.query(
          `SELECT m.ROWID id,cmj.chat_id chatId,${messageMsSql("m.date")} ms,m.text,hex(m.attributedBody) bodyHex ${IN_CHAT} WHERE NOT ${TAPBACK} AND COALESCE(m.item_type,0)=0 AND (m.ROWID>${last.id} OR (m.ROWID=${last.id} AND cmj.chat_id>${last.chatId})) ORDER BY m.ROWID,cmj.chat_id LIMIT 2000`,
          signal
        );
        for (const row of rows)
          if (messageBody(row.text, row.bodyHex).text.toLowerCase().includes(needle))
            matches.push({ id: Number(row.id), chatId: Number(row.chatId), ms: Number(row.ms) });
        if (rows.length < 2000) break;
        last = { id: Number(rows.at(-1)!.id), chatId: Number(rows.at(-1)!.chatId) };
      }
    }
    const newestFirst = matches
      .map((x) => ({ id: Number(x.id), chatId: Number(x.chatId), ms: Number(x.ms) }))
      .sort((x, y) => y.ms - x.ms || y.id - x.id)
      .filter((x) => !before || x.ms < before.ms || (x.ms === before.ms && x.id < before.id));
    const page = await this.page(newestFirst.slice(0, limit + 1), limit, "1=1", signal);
    return { kind: "search", ...this.envelope(page, matches.length) };
  }

  private envelope(page: { items: any[]; cause?: "limit" | "bytes" }, total: number) {
    const oldest = page.items[0];
    return {
      items: page.items,
      total,
      ...(page.cause && oldest ? { truncated: page.cause, nextBefore: { date: oldest.date, id: oldest.id } } : {}),
      people: {},
    };
  }

  /** Builds wire items for newest-first (message, chat) keys, folds tapbacks, and applies the page budget. */
  private async page(keys: Array<Record<string, any>>, limit: number, tapbackScope: string, signal?: AbortSignal) {
    if (!keys.length) return { items: [] as any[], cause: undefined };
    // One chat lists attachments by attachment id; a cross-chat read keeps the join order.
    const attachmentOrder = tapbackScope === "1=1" ? "maj.ROWID" : "maj.attachment_id";
    const { message, attachment } = await this.columns(signal);
    const column = (name: string) => (message.has(name) ? `m.${name}` : "NULL");
    const dateColumn = (name: string) => (message.has(name) ? `CAST(m.${name} AS TEXT)` : "NULL");
    const uti = attachment.has("uti") ? "a.uti" : "NULL";
    const pairs = keys.map((k) => `(${Number(k.id)},${Number(k.chatId)})`).join(",");
    const rows = await this.query(
      `SELECT m.ROWID id,cmj.chat_id chatId,m.guid,c.guid chatGuid,m.text,hex(m.attributedBody) bodyHex,h.id handle,m.service,CAST(m.date AS TEXT) date,m.is_from_me fromMe,${column("item_type")} itemType,${column("group_title")} groupTitle,${column("group_action_type")} groupActionType,${column("thread_originator_guid")} threadOriginatorGuid,${column("reply_to_guid")} replyToGuid,${dateColumn("date_edited")} dateEdited,${dateColumn("date_retracted")} dateRetracted,(SELECT json_group_array(json_object('id',a.ROWID,'guid',a.guid,'filename',a.filename,'transferName',a.transfer_name,'mime',a.mime_type,'uti',${uti},'totalBytes',a.total_bytes)) FROM (SELECT a.*,maj.ROWID joinId FROM message_attachment_join maj JOIN attachment a ON a.ROWID=maj.attachment_id WHERE maj.message_id=m.ROWID ORDER BY ${attachmentOrder}) a) attachments ${IN_CHAT} LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE (m.ROWID,cmj.chat_id) IN (VALUES ${pairs})`,
      signal
    );
    const byKey = new Map(rows.map((row) => [`${row.id}:${row.chatId}`, row]));
    const ordered = keys
      .map((k) => byKey.get(`${k.id}:${k.chatId}`))
      .filter((row): row is Record<string, any> => !!row);
    const messages = ordered.filter((row) => !Number(row.itemType ?? 0));
    const tapbacks = await this.tapbacks(messages.map((row) => row.guid), tapbackScope, signal);
    const items = ordered.map((row) => {
      const date = messageDate(row.date) ?? new Date(0).toISOString();
      const handle = row.handle ? { handle: row.handle } : {};
      if (Number(row.itemType ?? 0) !== 0)
        return {
          kind: "event",
          id: Number(row.id),
          guid: row.guid,
          chatGuid: row.chatGuid,
          date,
          itemType: Number(row.itemType),
          ...(row.groupActionType != null ? { groupActionType: Number(row.groupActionType) } : {}),
          ...(row.groupTitle ? { groupTitle: row.groupTitle } : {}),
          ...handle,
        };
      const edited = messageDate(row.dateEdited);
      const unsent = messageDate(row.dateRetracted);
      return {
        kind: "message",
        id: Number(row.id),
        guid: row.guid,
        chatGuid: row.chatGuid,
        date,
        fromMe: Number(row.fromMe) === 1,
        service: row.service,
        body: messageBody(row.text, row.bodyHex),
        tapbacks: tapbacks.get(row.guid) ?? [],
        attachments: (JSON.parse(row.attachments ?? "[]") as Array<Record<string, any>>).map(wireAttachment),
        ...handle,
        ...(row.replyToGuid ? { replyToGuid: row.replyToGuid } : {}),
        ...(row.threadOriginatorGuid ? { threadOriginatorGuid: row.threadOriginatorGuid } : {}),
        ...(edited ? { edited: { date: edited } } : {}),
        ...(unsent ? { unsent: { date: unsent } } : {}),
      };
    });
    const { taken, cause } = take(items, limit);
    return { items: taken.reverse(), cause };
  }

  /** Live tapbacks per target guid, replayed in date order so a 3000-series removal cancels its add. */
  private async tapbacks(guids: string[], scope: string, signal?: AbortSignal) {
    const folded = new Map<string, Tapback[]>();
    if (!guids.length) return folded;
    const { message } = await this.columns(signal);
    const emoji = message.has("associated_message_emoji") ? "m.associated_message_emoji" : "NULL";
    const target = `CASE WHEN instr(m.associated_message_guid,'/')>0 THEN substr(m.associated_message_guid,instr(m.associated_message_guid,'/')+1) WHEN substr(m.associated_message_guid,1,3)='bp:' THEN substr(m.associated_message_guid,4) ELSE m.associated_message_guid END`;
    const rows = await this.query(
      `SELECT ${target} target,m.associated_message_type type,m.is_from_me fromMe,CAST(m.date AS TEXT) date,${emoji} emoji,h.id handle ${IN_CHAT} LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE m.associated_message_guid IS NOT NULL AND ${TAPBACK} AND ${scope} AND ${target} IN (${guids.map(sqlText).join(",")}) ORDER BY m.date,m.ROWID`,
      signal
    );
    for (const row of rows) {
      const type = Number(row.type);
      const fromMe = Number(row.fromMe) === 1;
      const list = folded.get(row.target) ?? [];
      if (type < 3000) {
        list.push({
          type,
          fromMe,
          date: messageDate(row.date) ?? new Date(0).toISOString(),
          ...(row.emoji ? { emoji: row.emoji } : {}),
          ...(row.handle ? { handle: row.handle } : {}),
        });
        folded.set(row.target, list);
        continue;
      }
      const index = list.findLastIndex(
        (t) => t.type === type - 1000 && t.fromMe === fromMe && t.handle === (row.handle ?? undefined) && t.emoji === (row.emoji ?? undefined)
      );
      if (index >= 0) list.splice(index, 1);
    }
    return folded;
  }
}
