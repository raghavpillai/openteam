import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MacMessages } from "../../src/main/host/messages";
import { messageBody, messageDate } from "../../src/main/host/message-body";

/** Writes typedstream archives the way Messages stores attributedBody (synthetic text only). */
class Archive {
  private bytes: number[] = [0x04, 0x0b, ...Buffer.from("streamtyped"), 0x81, 0xe8, 0x03];
  private strings: string[] = [];
  private objects = 0;
  private classes = new Map<string, number>();
  private int(value: number) {
    if (value >= -110 && value <= 127) this.bytes.push(value & 255);
    else if (value >= -32768 && value <= 65535) this.bytes.push(0x81, value & 255, (value >> 8) & 255);
    else this.bytes.push(0x82, ...Buffer.from(Uint32Array.of(value).buffer));
  }
  private unshared(data: Buffer) {
    this.int(data.length);
    this.bytes.push(...data);
  }
  private shared(value: string) {
    const index = this.strings.indexOf(value);
    if (index >= 0) return this.int(index - 110);
    this.strings.push(value);
    this.bytes.push(0x84);
    this.unshared(Buffer.from(value, "latin1"));
  }
  private group(encoding: string, write: () => void) {
    this.shared(encoding);
    write();
  }
  private object(chain: Array<[string, number]>, body: () => void) {
    this.bytes.push(0x84);
    this.objects++;
    for (const [name, version] of chain) {
      const seen = this.classes.get(name);
      if (seen !== undefined) {
        this.int(seen - 110);
        return this.finish(body);
      }
      this.bytes.push(0x84);
      this.shared(name);
      this.int(version);
      this.classes.set(name, this.objects++);
    }
    this.bytes.push(0x85);
    this.finish(body);
  }
  private finish(body: () => void) {
    body();
    this.bytes.push(0x86);
  }
  private string(value: string) {
    this.group("@", () => this.object([["NSString", 1], ["NSObject", 0]], () => this.group("+", () => this.unshared(Buffer.from(value)))));
  }
  private number(value: number) {
    this.group("@", () =>
      this.object([["NSNumber", 0], ["NSValue", 0], ["NSObject", 0]], () => {
        this.group("*", () => {
          this.bytes.push(0x84);
          this.objects++;
          this.shared("q");
        });
        this.group("q", () => this.int(value));
      })
    );
  }
  static attributed(text: string, runs: Array<{ length: number; part?: number; mention?: string }>) {
    const a = new Archive();
    a.group("@", () =>
      a.object([["NSMutableAttributedString", 0], ["NSAttributedString", 0], ["NSObject", 0]], () => {
        a.string(text);
        runs.forEach((run, index) =>
          a.group("iI", () => {
            a.int(index + 1);
            a.int(run.length);
            const entries: Array<[string, () => void]> = [];
            if (run.part !== undefined) entries.push(["__kIMMessagePartAttributeName", () => a.number(run.part!)]);
            if (run.mention) entries.push(["__kIMMentionConfirmedMention", () => a.string(run.mention!)]);
            a.group("@", () =>
              a.object([["NSDictionary", 0], ["NSObject", 0]], () => {
                a.group("i", () => a.int(entries.length));
                for (const [key, value] of entries) {
                  a.string(key);
                  value();
                }
              })
            );
          })
        );
      })
    );
    return Buffer.from(a.bytes);
  }
}

const NOW = 800_000_000_000_000_000n;
const ns = (seconds: number) => NOW + BigInt(seconds) * 1_000_000_000n;
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE message(ROWID INTEGER PRIMARY KEY,guid TEXT,text TEXT,attributedBody BLOB,handle_id INTEGER DEFAULT 0,service TEXT DEFAULT 'iMessage',date INTEGER,is_from_me INTEGER DEFAULT 0,associated_message_guid TEXT,associated_message_type INTEGER DEFAULT 0,associated_message_emoji TEXT,item_type INTEGER DEFAULT 0,group_title TEXT,group_action_type INTEGER DEFAULT 0,thread_originator_guid TEXT,reply_to_guid TEXT,date_edited INTEGER DEFAULT 0,date_retracted INTEGER DEFAULT 0);
CREATE TABLE handle(ROWID INTEGER PRIMARY KEY,id TEXT);
CREATE TABLE chat(ROWID INTEGER PRIMARY KEY,guid TEXT,chat_identifier TEXT,display_name TEXT,service_name TEXT);
CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER,message_date INTEGER);
CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);
CREATE TABLE attachment(ROWID INTEGER PRIMARY KEY,guid TEXT,filename TEXT,transfer_name TEXT,mime_type TEXT,uti TEXT,total_bytes INTEGER);
INSERT INTO handle VALUES(1,'+15555550101'),(2,'+15555550102');
INSERT INTO chat VALUES(1,'any;+;chat-group','chat-group','Synthetic Group','iMessage'),(2,'any;-;+15555550101','+15555550101','','iMessage'),(3,'any;-;+15555550102','+15555550102',NULL,'SMS');
INSERT INTO chat_handle_join VALUES(1,2),(1,1),(2,1),(3,2);`);
  const message = (chat: number | null, columns: Record<string, unknown>) => {
    const keys = Object.keys(columns);
    const id = db.query(`INSERT INTO message(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")}) RETURNING ROWID id`).get(...(Object.values(columns) as any[])) as { id: number };
    if (chat !== null) db.query("INSERT INTO chat_message_join VALUES(?,?,?)").run(chat, id.id, columns.date as bigint);
    return id.id;
  };
  const service = new MacMessages(async (_file, args) => JSON.stringify(db.query(args.at(-1)!).all()), "/nonexistent");
  return { db, message, service };
}

test("attributed bodies decode to text and runs with mentions and parts; placeholders are removed", () => {
  const text = "Hi ￼Sam";
  const body = Archive.attributed(text, [{ length: 3, part: 0 }, { length: 1, part: 1 }, { length: 3, part: 2, mention: "+15555550101" }]);
  expect(messageBody("ignored when an archive exists", body.toString("hex"))).toEqual({
    text: "Hi Sam",
    runs: [{ text: "Hi ", part: 0 }, { text: "", part: 1 }, { text: "Sam", mention: "+15555550101", part: 2 }],
    fallback: false,
  });
  // Long and multi-byte strings use the wide length forms.
  const long = "emoji 🦊 ".repeat(90);
  expect(messageBody(null, Archive.attributed(long, [{ length: long.length, part: 0 }]).toString("hex")).text).toBe(long);
  // Only an archive the reader rejects falls back to scanning its bytes.
  const broken = Buffer.concat([Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x84, 0x01, 0x2b, 0x05]), Buffer.from("Hello"), Buffer.from([0x86, 0x84])]);
  expect(messageBody(null, broken.toString("hex"))).toEqual({ text: "Hello", runs: [{ text: "Hello" }], fallback: true });
  expect(messageBody("plain", null)).toEqual({ text: "plain", runs: [{ text: "plain" }], fallback: false });
  expect(messageBody(null, "")).toEqual({ text: "", runs: [], fallback: false });
  expect(messageDate("800000000123456789")).toBe("2026-05-09T06:13:20.123Z");
  expect(messageDate(0)).toBeUndefined();
});

test("chat items fold tapbacks onto their targets and report events, edits, replies and attachments", async () => {
  const { message, service, db } = fixture();
  const target = message(1, { guid: "m-1", text: "one", attributedBody: Archive.attributed("one", [{ length: 3, part: 0 }]), handle_id: 1, date: ns(1) });
  message(1, { guid: "t-1", associated_message_guid: "p:0/m-1", associated_message_type: 2001, handle_id: 2, date: ns(2) });
  message(1, { guid: "t-2", associated_message_guid: "p:0/m-1", associated_message_type: 2000, is_from_me: 1, date: ns(3) });
  message(1, { guid: "t-3", associated_message_guid: "p:0/m-1", associated_message_type: 3000, is_from_me: 1, date: ns(4) });
  message(1, { guid: "t-4", associated_message_guid: "bp:m-1", associated_message_type: 2006, associated_message_emoji: "🦊", handle_id: 1, date: ns(5) });
  message(1, { guid: "e-1", item_type: 2, group_title: "Renamed", group_action_type: 0, handle_id: 1, date: ns(6) });
  message(1, { guid: "m-2", text: "two", is_from_me: 1, reply_to_guid: "m-1", thread_originator_guid: "m-1", date_edited: ns(8), date: ns(7) });
  message(null, { guid: "orphan", text: "deleted chat", date: ns(9) });
  db.exec(`INSERT INTO attachment VALUES(7,'a-7','~/Library/Messages/Attachments/ab/IMG_1.heic','IMG_1.heic','image/heic','public.heic',1234)`);
  db.query("INSERT INTO message_attachment_join VALUES(?,7)").run(target);

  const result = await service.execute("ChatItems", { chatGuid: "any;+;chat-group" });
  expect(Object.keys(result)).toEqual(["kind", "items", "total", "people"]);
  expect(result.total).toBe(3);
  expect(result.items).toEqual([
    {
      kind: "message", id: target, guid: "m-1", chatGuid: "any;+;chat-group", date: messageDate(ns(1)), fromMe: false, service: "iMessage",
      body: { text: "one", runs: [{ text: "one", part: 0 }], fallback: false },
      tapbacks: [
        { type: 2001, fromMe: false, date: messageDate(ns(2)), handle: "+15555550102" },
        { type: 2006, fromMe: false, date: messageDate(ns(5)), emoji: "🦊", handle: "+15555550101" },
      ],
      attachments: [{ id: 7, guid: "a-7", filename: "IMG_1.heic", transferName: "IMG_1.heic", mime: "image/heic", uti: "public.heic", totalBytes: 1234 }],
      handle: "+15555550101",
    },
    { kind: "event", id: 6, guid: "e-1", chatGuid: "any;+;chat-group", date: messageDate(ns(6)), itemType: 2, groupActionType: 0, groupTitle: "Renamed", handle: "+15555550101" },
    {
      kind: "message", id: 7, guid: "m-2", chatGuid: "any;+;chat-group", date: messageDate(ns(7)), fromMe: true, service: "iMessage",
      body: { text: "two", runs: [{ text: "two" }], fallback: false }, tapbacks: [], attachments: [],
      replyToGuid: "m-1", threadOriginatorGuid: "m-1", edited: { date: messageDate(ns(8)) },
    },
  ]);
  // Messages that belong to no chat are not history.
  const everything = await service.execute("ChatItems", {});
  expect(everything.total).toBe(3);
  expect(everything.items.map((x: any) => x.guid)).not.toContain("orphan");
});

test("pages keep a cursor-independent total and break equal-millisecond ties by id", async () => {
  const { message, service } = fixture();
  for (let i = 0; i < 5; i++) message(2, { guid: `g-${i}`, attributedBody: Archive.attributed(`Needle ${i}`, [{ length: 8, part: 0 }]), date: NOW + BigInt(i) });
  const first = await service.execute("SearchIMessages", { query: "needle", limit: 2 });
  expect(first).toMatchObject({ kind: "search", total: 5, truncated: "limit", nextBefore: { date: messageDate(NOW), id: 4 } });
  expect(first.items.map((x: any) => x.guid)).toEqual(["g-3", "g-4"]);
  const next = await service.execute("SearchIMessages", { query: "NEEDLE", limit: 2, before: first.nextBefore });
  expect(next.total).toBe(5);
  expect(next.items.map((x: any) => x.guid)).toEqual(["g-1", "g-2"]);
  const last = await service.execute("ChatItems", { chatGuid: "any;-;+15555550101", limit: 2, before: next.nextBefore });
  expect(last.items.map((x: any) => x.guid)).toEqual(["g-0"]);
  expect(last.total).toBe(5);
  expect(last.nextBefore).toBeUndefined();
  expect(JSON.stringify(first)).not.toContain("bodyHex");
});

test("search matches message bodies only, by archive or text column, with or without SQL folding", async () => {
  const { message, service } = fixture();
  message(2, { guid: "s-1", attributedBody: Archive.attributed("Thanks a lot", [{ length: 12, part: 0 }]), date: ns(1) });
  message(2, { guid: "s-2", text: "no archive, thanks", date: ns(2) });
  message(2, { guid: "s-3", associated_message_guid: "p:0/s-1", associated_message_type: 2001, text: "Loved “Thanks a lot”", date: ns(3) });
  message(2, { guid: "s-4", item_type: 1, text: "thanks", date: ns(4) });
  message(null, { guid: "s-5", text: "thanks from a deleted chat", date: ns(5) });
  message(2, { guid: "s-6", text: "Grüße und DANKE", date: ns(6) });
  const ascii = await service.execute("SearchIMessages", { query: "THANKS" });
  expect(ascii.total).toBe(2);
  expect(ascii.items.map((x: any) => [x.guid, x.tapbacks.length])).toEqual([["s-1", 1], ["s-2", 0]]);
  const unicode = await service.execute("SearchIMessages", { query: "GRÜSSE".replace("SS", "ß").toLowerCase() });
  expect(unicode.items.map((x: any) => x.guid)).toEqual(["s-6"]);
});

test("the page budget truncates by bytes and keeps at least one item", async () => {
  const { message, service } = fixture();
  for (let i = 0; i < 30; i++) message(2, { guid: `b-${i}`, text: "x".repeat(4000), date: ns(i) });
  const page = await service.execute("ChatItems", { chatGuid: "any;-;+15555550101", limit: 200 });
  expect(page.truncated).toBe("bytes");
  expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(64_000);
  expect(page.items.at(-1).guid).toBe("b-29");
  expect(page.nextBefore).toEqual({ date: page.items[0].date, id: page.items[0].id });
});

test("find-chats tolerates chats without messages and activity skips tapbacks and group events", async () => {
  const { message, service } = fixture();
  message(1, { guid: "f-1", text: "hi", date: ns(-60) });
  message(1, { guid: "f-2", associated_message_guid: "p:0/f-1", associated_message_type: 2000, date: ns(-50) });
  message(1, { guid: "f-3", item_type: 3, date: ns(-40) });
  message(3, { guid: "f-4", text: "older", date: ns(-7200) });
  const byHandle = await service.execute("FindIMessageChats", { handle: "+15555550101" });
  expect(byHandle).toEqual({
    kind: "find-chats",
    chats: [
      { id: 1, guid: "any;+;chat-group", identifier: "chat-group", displayName: "Synthetic Group", service: "iMessage", handles: ["+15555550102", "+15555550101"], lastDate: messageDate(ns(-40)) },
      { id: 2, guid: "any;-;+15555550101", identifier: "+15555550101", service: "iMessage", handles: ["+15555550101"] },
    ],
    total: 2,
    people: {},
  });
  const limited = await service.execute("FindIMessageChats", { limit: 1 });
  expect(limited).toMatchObject({ total: 3, truncated: "limit" });
  expect(limited.chats.map((c: any) => c.id)).toEqual([1]);
  const since = new Date(Number((ns(-3600) - 0n) / 1_000_000n) + Date.UTC(2001, 0, 1)).toISOString();
  const activity = await service.execute("IMessageActivity", { since });
  expect(activity).toEqual({
    kind: "activity",
    items: [{ chatGuid: "any;+;chat-group", count: 1, handles: ["+15555550102", "+15555550101"], displayName: "Synthetic Group" }],
    people: {},
  });
});
