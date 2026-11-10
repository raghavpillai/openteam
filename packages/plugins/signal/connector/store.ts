import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type SignalAccount = { aci: string; number?: string | null };
type Row = {
  sequence: number;
  id: string;
  chat: string;
  sender: string;
  timestamp: number;
  body: string | null;
  attachments: string;
  deleted: number;
  revision: number;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Content is deliberately limited to ordinary messages. Ephemeral content is excluded. */
export class MessageStore {
  readonly db: Database;
  private account?: SignalAccount;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), aci TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chat TEXT NOT NULL,
        sender TEXT NOT NULL, timestamp INTEGER NOT NULL, body TEXT, attachments TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat, sequence);
      CREATE TABLE IF NOT EXISTS sends (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT);
    `);
  }

  bind(account: SignalAccount) {
    this.db
      .transaction(() => {
        const existing = this.db.query<{ aci: string }, []>("SELECT aci FROM identity").get();
        if (existing && existing.aci !== account.aci)
          throw new Error(
            "This message store belongs to a different Signal account. Use a new account directory."
          );
        this.db.query("INSERT OR IGNORE INTO identity VALUES (1, ?)").run(account.aci);
      })
      .immediate();
    this.account = account;
  }

  capture(params: any) {
    const value = params?.result ?? params;
    const account = this.account;
    if (
      !account ||
      !value ||
      ![account.aci, account.number].filter(Boolean).includes(value.account)
    )
      return;
    const envelope = value.envelope;
    if (!envelope) return;
    const sent = envelope.syncMessage?.sentMessage;
    const edit = sent?.editMessage ?? envelope.editMessage;
    const message = edit?.dataMessage ?? sent ?? envelope.dataMessage;
    if (!message) return;
    const sender = sent
      ? account.aci
      : (envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source);
    const destination =
      message.groupInfo?.groupId ??
      (sent
        ? (sent.destinationUuid ?? sent.destinationNumber ?? sent.destination ?? account.aci)
        : sender);
    const chat = `${message.groupInfo?.groupId ? "group" : "contact"}:${destination}`;
    const timestamp = edit?.targetSentTimestamp ?? message.timestamp;
    const revision = edit ? message.timestamp : timestamp;
    if (
      typeof sender !== "string" ||
      typeof destination !== "string" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 ||
      !Number.isSafeInteger(revision)
    )
      return;
    const id = digest(JSON.stringify([chat, sender, timestamp]));
    if (message.adminDelete && message.groupInfo?.groupId) {
      const deleted = message.adminDelete;
      const author = deleted.targetAuthorUuid ?? deleted.targetAuthorNumber ?? deleted.targetAuthor;
      const target = deleted.targetTimestamp ?? deleted.targetSentTimestamp;
      if (typeof author === "string" && Number.isSafeInteger(target) && target > 0)
        this.tombstone(digest(JSON.stringify([chat, author, target])), chat, author, target);
      return;
    }
    const deletion = message.remoteDelete?.timestamp ?? message.remoteDelete?.targetSentTimestamp;
    if (Number.isSafeInteger(deletion) && deletion > 0) {
      this.tombstone(digest(JSON.stringify([chat, sender, deletion])), chat, sender, deletion);
      return;
    }
    if (message.viewOnce || message.expiresInSeconds > 0) {
      this.tombstone(id, chat, sender, timestamp);
      return;
    }
    if (message.isExpirationUpdate || message.isEndSession || message.isProfileKeyUpdate) return;
    const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
      .map((attachment: any) => ({
        id: String(attachment.id ?? ""),
        contentType: attachment.contentType ?? "application/octet-stream",
        filename: attachment.filename ?? null,
        size: attachment.size ?? null,
      }))
      .filter((attachment: any) => attachment.id);
    if (typeof message.message !== "string" && !attachments.length) return;
    this.db
      .query(`INSERT INTO messages (id,chat,sender,timestamp,body,attachments,revision) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, attachments=excluded.attachments, revision=excluded.revision
      WHERE messages.deleted=0 AND excluded.revision>messages.revision`)
      .run(
        id,
        chat,
        sender,
        timestamp,
        message.message ?? null,
        JSON.stringify(attachments),
        revision
      );
  }

  private tombstone(id: string, chat: string, sender: string, timestamp: number) {
    this.db
      .query(`INSERT INTO messages (id,chat,sender,timestamp,body,attachments,deleted,revision) VALUES (?,?,?,?,NULL,'[]',1,?)
      ON CONFLICT(id) DO UPDATE SET body=NULL, attachments='[]', deleted=1`)
      .run(id, chat, sender, timestamp, timestamp);
  }

  list(options: { chat?: string; query?: string; before?: number; limit?: number } = {}) {
    const limit = options.limit ?? 50;
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(before) ||
      before < 1
    )
      throw new Error("Use a limit from 1 to 100 and a positive before cursor.");
    const rows = this.db
      .query<Row, [number, string | null, string | null, string | null, string | null, number]>(
        `SELECT * FROM messages WHERE deleted=0 AND sequence<? AND (? IS NULL OR chat=?)
       AND (? IS NULL OR instr(body,?)>0) ORDER BY sequence DESC LIMIT ?`
      )
      .all(
        before,
        options.chat ?? null,
        options.chat ?? null,
        options.query ?? null,
        options.query ?? null,
        limit + 1
      );
    const selected = rows.slice(0, limit);
    return {
      messages: selected.map(({ attachments, deleted, revision, ...row }) => ({
        ...row,
        edited: revision > row.timestamp,
        attachments: JSON.parse(attachments),
      })),
      nextCursor: rows.length > limit ? selected.at(-1)!.sequence : null,
      historyScope:
        "Ordinary messages collected while connected. Disappearing and view-once messages are excluded. Search is literal and case-sensitive.",
    };
  }

  attachment(messageId: string, attachmentId: string) {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM messages WHERE id=? AND deleted=0")
      .get(messageId);
    if (!row || !JSON.parse(row.attachments).some((entry: any) => entry.id === attachmentId))
      throw new Error("Attachment is unavailable in this account's collected messages.");
    return { chat: row.chat, sender: row.sender };
  }

  previousSend(requestId: string, payload: unknown) {
    const fingerprint = digest(JSON.stringify(payload));
    const existing = this.db
      .query<{ fingerprint: string; state: string; result: string | null }, [string]>(
        "SELECT * FROM sends WHERE request_id=?"
      )
      .get(requestId);
    if (!existing) return;
    if (existing.fingerprint !== fingerprint)
      throw new Error("This request ID was already used for different message content.");
    return {
      existing: true,
      state: existing.state,
      result: existing.result ? JSON.parse(existing.result) : null,
    };
  }

  beginSend(requestId: string, payload: unknown) {
    return this.db
      .transaction(() => {
        const previous = this.previousSend(requestId, payload);
        if (previous) return previous;
        const fingerprint = digest(JSON.stringify(payload));
        this.db.query("INSERT INTO sends VALUES (?,?,'unknown',NULL)").run(requestId, fingerprint);
        return { existing: false, state: "unknown", result: null };
      })
      .immediate();
  }

  finishSend(requestId: string, result: unknown) {
    this.db
      .query("UPDATE sends SET state='sent',result=? WHERE request_id=?")
      .run(JSON.stringify(result), requestId);
  }

  close() {
    this.db.close();
  }
}
