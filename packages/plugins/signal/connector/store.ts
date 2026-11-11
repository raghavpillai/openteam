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
const messageId = (chat: string, sender: string, timestamp: number) =>
  digest(JSON.stringify([chat, sender, timestamp]));
const positiveTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const entries = (value: unknown): any[] => (Array.isArray(value) ? value : []);

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
      CREATE TABLE IF NOT EXISTS message_revisions (
        chat TEXT NOT NULL, sender TEXT NOT NULL, timestamp INTEGER NOT NULL,
        original INTEGER NOT NULL, PRIMARY KEY(chat,sender,timestamp));
      CREATE INDEX IF NOT EXISTS revisions_original ON message_revisions(chat,sender,original);
      CREATE TABLE IF NOT EXISTS message_observations (
        chat TEXT NOT NULL, sender TEXT NOT NULL, original INTEGER NOT NULL,
        PRIMARY KEY(chat,sender,original));
      CREATE TABLE IF NOT EXISTS attachment_redactions (
        chat TEXT NOT NULL, sender TEXT NOT NULL, original INTEGER NOT NULL,
        PRIMARY KEY(chat,sender,original));
      INSERT OR IGNORE INTO message_revisions SELECT chat,sender,timestamp,timestamp FROM messages;
      INSERT OR IGNORE INTO message_revisions SELECT chat,sender,revision,timestamp FROM messages;
      INSERT OR IGNORE INTO message_observations SELECT chat,sender,timestamp FROM messages WHERE deleted=0;
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
    this.db.transaction(() => this.captureEnvelope(account, envelope)).immediate();
  }

  private canonical(value: string) {
    return value === this.account?.number ? this.account.aci : value;
  }

  private captureEnvelope(account: SignalAccount, envelope: any) {
    const sync = envelope.syncMessage;
    const source = envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source;
    // Upstream authenticates sync senders before constructing this event. Also
    // reject an explicitly conflicting source at this storage boundary.
    if (sync && source !== undefined && ![account.aci, account.number].includes(source)) return;
    if (sync?.deleteForMe) this.captureDeletes(sync.deleteForMe);
    const sent = sync?.sentMessage;
    const edit = sent?.editMessage ?? envelope.editMessage;
    const message = edit?.dataMessage ?? sent ?? envelope.dataMessage;
    if (!message) return;
    const rawSender = sent ? account.aci : source;
    const rawDestination =
      message.groupInfo?.groupId ??
      (sent
        ? (sent.destinationUuid ?? sent.destinationNumber ?? sent.destination ?? account.aci)
        : rawSender);
    const target = edit?.targetSentTimestamp ?? message.timestamp;
    const revision = edit ? message.timestamp : target;
    if (
      !identifier(rawSender) ||
      !identifier(rawDestination) ||
      !positiveTimestamp(target) ||
      !positiveTimestamp(revision)
    )
      return;
    const sender = this.canonical(rawSender);
    const destination = message.groupInfo?.groupId
      ? rawDestination
      : this.canonical(rawDestination);
    const chat = `${message.groupInfo?.groupId ? "group" : "contact"}:${destination}`;
    const timestamp = this.linkRevision(chat, sender, target, revision);
    const id = messageId(chat, sender, timestamp);
    if (message.adminDelete && message.groupInfo?.groupId) {
      const deleted = message.adminDelete;
      const author = deleted.targetAuthorUuid ?? deleted.targetAuthorNumber ?? deleted.targetAuthor;
      const target = deleted.targetTimestamp ?? deleted.targetSentTimestamp;
      if (identifier(author) && positiveTimestamp(target))
        this.tombstone(chat, this.canonical(author), target);
      return;
    }
    const deletion = message.remoteDelete?.timestamp ?? message.remoteDelete?.targetSentTimestamp;
    if (positiveTimestamp(deletion)) {
      this.tombstone(chat, sender, deletion);
      return;
    }
    if (message.viewOnce || message.expiresInSeconds > 0) {
      this.tombstone(chat, sender, timestamp);
      return;
    }
    if (message.isExpirationUpdate || message.isEndSession || message.isProfileKeyUpdate) return;
    const attachments = (
      this.attachmentsRedacted(chat, sender, timestamp) ? [] : entries(message.attachments)
    )
      .map((attachment: any) => ({
        id: String(attachment.id ?? ""),
        contentType: attachment.contentType ?? "application/octet-stream",
        filename: attachment.filename ?? null,
        size: attachment.size ?? null,
      }))
      .filter((attachment: any) => attachment.id);
    if (typeof message.message !== "string" && !attachments.length) return;
    this.db
      .query("INSERT OR IGNORE INTO message_observations VALUES (?,?,?)")
      .run(chat, sender, timestamp);
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

  private original(chat: string, sender: string, timestamp: number) {
    return (
      this.db
        .query<{ original: number }, [string, string, number]>(
          "SELECT original FROM message_revisions WHERE chat=? AND sender=? AND timestamp=?"
        )
        .get(chat, sender, timestamp)?.original ?? timestamp
    );
  }

  /** Edits target the preceding revision, not necessarily the initial send. */
  private linkRevision(chat: string, sender: string, target: number, revision: number) {
    const original = this.original(chat, sender, target);
    const other = this.original(chat, sender, revision);
    if (other !== original) {
      const rows = this.db
        .query<Row, [string, string]>("SELECT * FROM messages WHERE id IN (?,?)")
        .all(messageId(chat, sender, original), messageId(chat, sender, other));
      if (rows.length) {
        const keeper = rows.reduce((a, b) => (a.sequence < b.sequence ? a : b));
        const latest = rows.reduce((a, b) => (a.revision > b.revision ? a : b));
        const deleted = rows.some((row) => row.deleted) ? 1 : 0;
        for (const row of rows)
          if (row.sequence !== keeper.sequence)
            this.db.query("DELETE FROM messages WHERE sequence=?").run(row.sequence);
        const redacted =
          this.attachmentsRedacted(chat, sender, original) ||
          this.attachmentsRedacted(chat, sender, other);
        this.db
          .query(
            `UPDATE messages SET id=?,timestamp=?,body=?,attachments=?,deleted=?,revision=? WHERE sequence=?`
          )
          .run(
            messageId(chat, sender, original),
            original,
            deleted ? null : latest.body,
            deleted || redacted ? "[]" : latest.attachments,
            deleted,
            latest.revision,
            keeper.sequence
          );
      }
      this.db
        .query("UPDATE message_revisions SET original=? WHERE chat=? AND sender=? AND original=?")
        .run(original, chat, sender, other);
      const observed = this.db
        .query("SELECT 1 FROM message_observations WHERE chat=? AND sender=? AND original=?")
        .get(chat, sender, other);
      if (observed) {
        this.db
          .query("INSERT OR IGNORE INTO message_observations VALUES (?,?,?)")
          .run(chat, sender, original);
        this.db
          .query("DELETE FROM message_observations WHERE chat=? AND sender=? AND original=?")
          .run(chat, sender, other);
      }
      if (this.attachmentsRedacted(chat, sender, other)) {
        this.db
          .query("INSERT OR IGNORE INTO attachment_redactions VALUES (?,?,?)")
          .run(chat, sender, original);
        this.db
          .query("DELETE FROM attachment_redactions WHERE chat=? AND sender=? AND original=?")
          .run(chat, sender, other);
      }
    }
    const insert = this.db.query("INSERT OR IGNORE INTO message_revisions VALUES (?,?,?,?)");
    insert.run(chat, sender, target, original);
    insert.run(chat, sender, revision, original);
    return original;
  }

  private captureDeletes(deletes: any) {
    const chatFor = (conversation: any) => {
      if (!["contact", "group"].includes(conversation?.kind) || !identifier(conversation?.id))
        return;
      return `${conversation.kind}:${conversation.kind === "contact" ? this.canonical(conversation.id) : conversation.id}`;
    };
    const address = (message: any) =>
      identifier(message?.author) && positiveTimestamp(message?.sentTimestamp)
        ? { sender: this.canonical(message.author), timestamp: message.sentTimestamp }
        : undefined;
    for (const group of entries(deletes.messageDeletes)) {
      const chat = chatFor(group?.conversation);
      if (!chat) continue;
      for (const message of entries(group?.messages)) {
        const target = address(message);
        if (target) this.tombstone(chat, target.sender, target.timestamp);
      }
    }
    for (const deletion of entries(deletes.attachmentDeletes)) {
      const chat = chatFor(deletion?.conversation),
        target = address(deletion?.targetMessage);
      if (!chat || !target) continue;
      const original = this.linkRevision(chat, target.sender, target.timestamp, target.timestamp);
      // Upstream's normal attachment JSON lacks cross-device client UUID/digest
      // identifiers. Block all attachments on this specific message, preserving
      // its text, instead of guessing which local file matches the deleted one.
      this.db
        .query("INSERT OR IGNORE INTO attachment_redactions VALUES (?,?,?)")
        .run(chat, target.sender, original);
      this.db
        .query("UPDATE messages SET attachments='[]' WHERE id=?")
        .run(messageId(chat, target.sender, original));
    }
    for (const deletion of entries(deletes.conversationDeletes)) {
      const chat = chatFor(deletion?.conversation);
      if (!chat || typeof deletion?.isFullDelete !== "boolean") continue;
      const anchors = [
        ...entries(deletion.mostRecentMessages),
        ...entries(deletion.mostRecentNonExpiringMessages),
      ];
      let sequence = 0;
      for (const message of anchors) {
        const target = address(message);
        if (!target) continue;
        const original = this.original(chat, target.sender, target.timestamp);
        const row = this.db
          .query<{ sequence: number }, [string]>(`SELECT m.sequence FROM messages m
          JOIN message_observations o ON o.chat=m.chat AND o.sender=m.sender AND o.original=m.timestamp WHERE m.id=?`)
          .get(messageId(chat, target.sender, original));
        if (row) sequence = Math.max(sequence, row.sequence);
      }
      // Match official clients' observed local arrival anchor. Without an
      // observed anchor, never guess a cutoff or wipe the entire conversation.
      if (sequence)
        this.db
          .query(
            "UPDATE messages SET body=NULL,attachments='[]',deleted=1 WHERE chat=? AND sequence<=?"
          )
          .run(chat, sequence);
    }
    // localOnlyConversationDeletes concern local metadata only; ordinary
    // indexed messages are addressable and must never be removed by that path.
  }

  private attachmentsRedacted(chat: string, sender: string, original: number) {
    return !!this.db
      .query("SELECT 1 FROM attachment_redactions WHERE chat=? AND sender=? AND original=?")
      .get(chat, sender, original);
  }

  private tombstone(chat: string, sender: string, target: number) {
    const timestamp = this.linkRevision(chat, sender, target, target);
    const id = messageId(chat, sender, timestamp);
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
        "Ordinary messages collected while connected. Disappearing and view-once messages are excluded. Delivered deletion events update collected copies; conversation deletion requires an observed anchor. Search is literal and case-sensitive.",
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
