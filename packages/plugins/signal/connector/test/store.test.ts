import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../store";

const self = { aci: "self", number: "+12025550100" };
const stores: MessageStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function store(path = ":memory:") {
  const value = new MessageStore(path);
  value.bind(self);
  stores.push(value);
  return value;
}
const incoming = (
  timestamp: number,
  message: unknown = "hello",
  data: any = {},
  envelope: any = {}
) => ({
  account: self.aci,
  envelope: { sourceUuid: "alice", dataMessage: { timestamp, message, ...data }, ...envelope },
});

test("receives automatic and subscription events, removes duplicates, and preserves Unicode", () => {
  const value = store();
  const message = incoming(1000, "こんにちは 🐈 café");
  value.capture(message);
  value.capture({ subscription: 0, result: message });
  expect(value.list().messages).toHaveLength(1);
  expect(value.list().messages[0]!.body).toBe("こんにちは 🐈 café");
});

test("rejects unrelated account events and binds storage permanently to one ACI", () => {
  const value = store();
  value.capture({ ...incoming(1000), account: "other" });
  value.capture({ envelope: incoming(1001).envelope });
  expect(value.list().messages).toHaveLength(0);
  expect(() => value.bind({ aci: "other" })).toThrow("different Signal account");
  value.bind({ ...self, number: "+12025550199" });
});

test("accepts phone-number event identifiers and numberless accounts", () => {
  const value = store();
  value.capture({ ...incoming(1000), account: self.number });
  expect(value.list().messages).toHaveLength(1);
  const numberless = new MessageStore(":memory:");
  stores.push(numberless);
  numberless.bind({ aci: "numberless", number: null });
  numberless.capture({ ...incoming(1000), account: "numberless" });
  expect(numberless.list().messages).toHaveLength(1);
});

test("partitions direct, group and synchronized sent messages", () => {
  const value = store();
  value.capture(incoming(1000));
  value.capture(incoming(1000, "group", { groupInfo: { groupId: "group-id" } }));
  value.capture({
    account: self.aci,
    envelope: {
      syncMessage: {
        sentMessage: { destinationUuid: "bob", timestamp: 1000, message: "sent on phone" },
      },
    },
  });
  expect(
    value
      .list()
      .messages.map((row) => row.chat)
      .sort()
  ).toEqual(["contact:alice", "contact:bob", "group:group-id"]);
  expect(value.list({ chat: "contact:bob" }).messages[0]!.sender).toBe("self");
});

test.each([
  "viewOnce",
  "expiresInSeconds",
])("excludes %s content and prevents replay revival", (field) => {
  const value = store();
  value.capture(
    incoming(1000, "ephemeral", {
      [field]: field === "viewOnce" ? true : 60,
      attachments: [{ id: "private" }],
    })
  );
  value.capture(incoming(1000, "replayed without flag"));
  expect(value.list().messages).toHaveLength(0);
  const raw = value.db
    .query<{ body: string | null; attachments: string }, []>(
      "SELECT body,attachments FROM messages"
    )
    .get()!;
  expect(raw).toEqual({ body: null, attachments: "[]" });
});

test("ignores metadata, receipt, reaction and malformed envelopes", () => {
  const value = store();
  for (const field of ["isExpirationUpdate", "isEndSession", "isProfileKeyUpdate"])
    value.capture(incoming(1000, "metadata", { [field]: true }));
  value.capture(incoming(1001, null, { reaction: { emoji: "👍" } }));
  for (const timestamp of [null, "1000", -1, 0, Number.MAX_SAFE_INTEGER + 1])
    value.capture(incoming(timestamp as number));
  for (const frame of [null, {}, { result: {} }, { account: self.aci, envelope: {} }])
    value.capture(frame);
  expect(value.list().messages).toHaveLength(0);
});

test("newest edits win even when edits precede originals and stale events replay", () => {
  const value = store();
  const edit = (revision: number, body: string) => ({
    account: self.aci,
    envelope: {
      sourceUuid: "alice",
      editMessage: {
        targetSentTimestamp: 1000,
        dataMessage: { timestamp: revision, message: body },
      },
    },
  });
  value.capture(edit(3000, "latest"));
  value.capture(incoming(1000, "original"));
  value.capture(edit(2000, "stale edit"));
  expect(value.list().messages[0]).toMatchObject({ body: "latest", edited: true, timestamp: 1000 });
});

test.each([
  true,
  false,
])("remote deletion tombstones survive event reordering (delete first %s)", (first) => {
  const value = store();
  const deletion = incoming(2000, null, { remoteDelete: { timestamp: 1000 } });
  if (first) value.capture(deletion);
  value.capture(incoming(1000, "must disappear", { attachments: [{ id: "attachment" }] }));
  value.capture(deletion);
  value.capture(incoming(1000, "replay"));
  expect(value.list().messages).toHaveLength(0);
});

test("search treats SQL syntax and wildcard characters literally", () => {
  const value = store();
  value.capture(incoming(1000, "literal %_ ' OR 1=1 --"));
  value.capture(incoming(1001, "other"));
  expect(value.list({ query: "%_" }).messages).toHaveLength(1);
  expect(value.list({ query: "' OR 1=1 --" }).messages).toHaveLength(1);
  expect(value.list({ chat: "' OR 1=1 --" }).messages).toHaveLength(0);
});

test("synchronized edits update a sent message and group admin deletion targets its author", () => {
  const value = store();
  value.capture({
    account: self.aci,
    envelope: {
      syncMessage: {
        sentMessage: {
          destinationUuid: "bob",
          timestamp: 1000,
          message: "sent original",
        },
      },
    },
  });
  value.capture({
    account: self.aci,
    envelope: {
      syncMessage: {
        sentMessage: {
          destinationUuid: "bob",
          editMessage: {
            targetSentTimestamp: 1000,
            dataMessage: { timestamp: 2000, message: "sent edit" },
          },
        },
      },
    },
  });
  expect(value.list({ chat: "contact:bob" }).messages[0]).toMatchObject({
    body: "sent edit",
    edited: true,
  });
  value.capture(incoming(3000, "group message", { groupInfo: { groupId: "group" } }));
  value.capture(
    incoming(
      4000,
      null,
      {
        groupInfo: { groupId: "group" },
        adminDelete: { targetAuthorUuid: "alice", targetTimestamp: 3000 },
      },
      { sourceUuid: "admin" }
    )
  );
  expect(value.list({ chat: "group:group" }).messages).toHaveLength(0);
});

test("stable sequence pagination survives identical timestamps, new arrivals and duplicate replay", () => {
  const value = store();
  for (let i = 0; i < 235; i++)
    value.capture(incoming(1000, `message ${i}`, {}, { sourceUuid: `sender-${i}` }));
  const first = value.list({ limit: 100 });
  value.capture(incoming(1001, "new arrival"));
  const second = value.list({ limit: 100, before: first.nextCursor! });
  const third = value.list({ limit: 100, before: second.nextCursor! });
  const all = [...first.messages, ...second.messages, ...third.messages];
  expect(new Set(all.map((row) => row.id)).size).toBe(235);
  expect(third.nextCursor).toBeNull();
});

test.each([0, -1, 101, 1.5, NaN])("rejects invalid page size %s", (limit) => {
  expect(() => store().list({ limit })).toThrow();
});

test("attachment lookup requires an owned live message and strips filesystem paths", () => {
  const value = store();
  value.capture(
    incoming(1000, null, {
      attachments: [
        {
          id: "a",
          filename: "hello.txt",
          storedFilename: "/secret/path",
          contentType: "text/plain",
          size: 5,
        },
      ],
    })
  );
  const message = value.list().messages[0]!;
  expect(JSON.stringify(message)).not.toContain("/secret/path");
  expect(value.attachment(message.id, "a")).toEqual({ chat: "contact:alice", sender: "alice" });
  expect(() => value.attachment(message.id, "../../private")).toThrow();
  value.capture(incoming(2000, null, { remoteDelete: { timestamp: 1000 } }));
  expect(() => value.attachment(message.id, "a")).toThrow();
});

test("messages, identity and uncertain sends survive a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-store-"));
  directories.push(directory);
  const path = join(directory, "messages.sqlite");
  const first = store(path);
  first.capture(incoming(1000, "durable"));
  first.beginSend("request-1", { message: "once" });
  first.close();
  stores.pop();
  const second = store(path);
  expect(second.list().messages[0]!.body).toBe("durable");
  expect(second.beginSend("request-1", { message: "once" })).toMatchObject({
    existing: true,
    state: "unknown",
  });
  expect(() => second.beginSend("request-1", { message: "different" })).toThrow(
    "different message content"
  );
  second.finishSend("request-1", { timestamp: 123 });
  expect(second.beginSend("request-1", { message: "once" })).toMatchObject({
    existing: true,
    state: "sent",
    result: { timestamp: 123 },
  });
});

test("two SQLite connections atomically claim a send exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-send-"));
  directories.push(directory);
  const first = store(join(directory, "messages.sqlite"));
  const second = store(join(directory, "messages.sqlite"));
  expect(first.beginSend("same-id", "same payload").existing).toBe(false);
  expect(second.beginSend("same-id", "same payload").existing).toBe(true);
});

test("a 10000-message stream remains deduplicated after complete replay", () => {
  const value = store();
  for (let replay = 0; replay < 2; replay++)
    for (let i = 0; i < 10000; i++) value.capture(incoming(1000 + i, `stress ${i}`));
  expect(
    value.db.query<{ count: number }, []>("SELECT count(*) AS count FROM messages").get()!.count
  ).toBe(10000);
});
