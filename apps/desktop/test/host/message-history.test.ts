import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MacMessages } from "../../src/main/host/messages";
import { decodeMessageBody, messageDate, messageTimestamp } from "../../src/main/host/message-body";
const encoded = (text: string) => {
  const bytes = Buffer.from(text);
  const length =
    bytes.length < 128
      ? Buffer.from([bytes.length])
      : Buffer.from([0x81, bytes.length & 255, bytes.length >> 8]);
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped"),
    Buffer.from([1, 43]),
    length,
    bytes,
    Buffer.from([0x86, 0x84]),
  ]);
};
test("archived message bodies retain long UTF-8 text and nanosecond cursors", () => {
  for (const text of ["Hi", "emoji 🦊 ".repeat(90), "x".repeat(3000)])
    expect(decodeMessageBody(null, encoded(text).toString("hex"))).toEqual({
      text,
      fallback: true,
    });
  expect(decodeMessageBody(null, "deadbeef")).toBeNull();
  for (const stamp of ["800000000123456789", "800000000123456788", "800000000000000000"])
    expect(messageTimestamp(messageDate(stamp)).toString()).toBe(stamp);
});
test("Messages history searches archived bodies, reports real totals, and pages without skipping equal-millisecond items", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE message(guid TEXT,text TEXT,attributedBody BLOB,date INTEGER,is_from_me INTEGER,service TEXT,handle_id INTEGER,associated_message_type INTEGER,associated_message_guid TEXT,date_edited INTEGER,date_retracted INTEGER);
 CREATE TABLE handle(id TEXT);CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);CREATE TABLE chat(guid TEXT);CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);CREATE TABLE attachment(guid TEXT,transfer_name TEXT,mime_type TEXT,total_bytes INTEGER);`);
  const insert = db.query("INSERT INTO message VALUES (?,NULL,?,?,0,'iMessage',NULL,0,NULL,0,0)");
  for (let i = 0; i < 5; i++)
    insert.run(`guid-${i}`, encoded(`Needle ${i}`), 800000000123456780n + BigInt(i));
  const service = new MacMessages(async (_file, args) =>
    JSON.stringify(db.query(args.at(-1)!).all())
  );
  try {
    const first = await service.execute("SearchIMessages", { query: "needle", limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items.map((x: any) => x.guid)).toEqual(["guid-3", "guid-4"]);
    const next = await service.execute("SearchIMessages", {
      query: "needle",
      limit: 2,
      before: first.nextBefore,
    });
    expect(next.total).toBe(3);
    expect(next.items.map((x: any) => x.guid)).toEqual(["guid-1", "guid-2"]);
    const last = await service.execute("ChatItems", { limit: 2, before: next.nextBefore });
    expect(last.items.map((x: any) => x.guid)).toEqual(["guid-0"]);
    expect(last.nextBefore).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("bodyHex");
  } finally {
    db.close();
  }
});
