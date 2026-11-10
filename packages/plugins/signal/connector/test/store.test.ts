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

test("an empty iOS sent view-once placeholder blocks later content replay", () => {
  const value = store();
  const sent = (data: Record<string, unknown>) => ({
    account: self.aci,
    envelope: {
      sourceUuid: self.aci,
      syncMessage: {
        sentMessage: {
          destinationUuid: self.aci,
          timestamp: 1000,
          message: null,
          expiresInSeconds: 0,
          ...data,
        },
      },
    },
  });
  value.capture(sent({ viewOnce: true }));
  value.capture(sent({ message: "unflagged replay", attachments: [{ id: "private-photo" }] }));
  expect(value.list().messages).toHaveLength(0);
  expect(value.db.query("SELECT body,attachments,deleted FROM messages").get()).toEqual({
    body: null,
    attachments: "[]",
    deleted: 1,
  });
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

const syncDelete = (deleteForMe: any, source: string | undefined = self.aci) => ({
  account: self.aci,
  envelope: { ...(source ? { sourceUuid: source } : {}), syncMessage: { deleteForMe } },
});
const conversation = { kind: "contact", id: "alice" };
const targeted = (sentTimestamp: number, author = "alice", chat = conversation) => ({
  messageDeletes: [{ conversation: chat, messages: [{ author, sentTimestamp }] }],
});
const edited = (
  targetSentTimestamp: number,
  timestamp: number,
  message = "edit",
  data: any = {}
) => ({
  account: self.aci,
  envelope: {
    sourceUuid: "alice",
    editMessage: { targetSentTimestamp, dataMessage: { timestamp, message, ...data } },
  },
});

test("phone sync deletions work without a sent-message envelope and remain scoped by chat and author", () => {
  const value = store();
  value.capture(incoming(1000, "direct"));
  value.capture(incoming(1000, "group alice", { groupInfo: { groupId: "group" } }));
  value.capture(
    incoming(1000, "group bob", { groupInfo: { groupId: "group" } }, { sourceUuid: "bob" })
  );
  value.capture(syncDelete(targeted(1000, "alice", { kind: "group", id: "group" })));
  expect(
    value
      .list()
      .messages.map((m) => m.body)
      .sort()
  ).toEqual(["direct", "group bob"]);
  value.capture(syncDelete(targeted(1000)));
  expect(value.list().messages.map((m) => m.body)).toEqual(["group bob"]);
});

test("an explicitly foreign sync source cannot delete or forge synchronized messages", () => {
  const value = store();
  value.capture(incoming(1000));
  const event = syncDelete(targeted(1000), "mallory");
  (event.envelope.syncMessage as any).sentMessage = {
    destinationUuid: "alice",
    timestamp: 2000,
    message: "forged",
  };
  value.capture(event);
  expect(value.list().messages.map((m) => m.body)).toEqual(["hello"]);
});

test("own number aliases normalize to the linked account's ACI", () => {
  const value = store();
  value.capture({
    account: self.aci,
    envelope: {
      sourceUuid: self.aci,
      syncMessage: {
        sentMessage: { destinationNumber: self.number, timestamp: 1000, message: "note" },
      },
    },
  });
  expect(value.list().messages[0]!.chat).toBe("contact:self");
  value.capture(
    syncDelete(targeted(1000, self.number, { kind: "contact", id: self.number }), self.number)
  );
  expect(value.list().messages).toHaveLength(0);
});

test("chained edits keep one stable original and deletion of any revision removes it", () => {
  for (const target of [1000, 2000, 3000]) {
    const value = store();
    value.capture(incoming(1000, "original"));
    const id = value.list().messages[0]!.id;
    value.capture(edited(1000, 2000, "first edit"));
    value.capture(edited(2000, 3000, "second edit"));
    expect(value.list().messages).toHaveLength(1);
    expect(value.list().messages[0]).toMatchObject({
      id,
      timestamp: 1000,
      body: "second edit",
      edited: true,
    });
    value.capture(syncDelete(targeted(target)));
    value.capture(edited(2000, 3000, "replay"));
    expect(value.list().messages).toHaveLength(0);
  }
});

test("every arrival order of original, chained edits and revision deletion converges without revival", () => {
  const frames = [
    incoming(1000, "original"),
    edited(1000, 2000, "first edit"),
    edited(2000, 3000, "last edit"),
    syncDelete(targeted(3000)),
  ];
  const permutations = (remaining: any[]): any[][] =>
    remaining.length === 0
      ? [[]]
      : remaining.flatMap((frame, i) =>
          permutations(remaining.filter((_, j) => i !== j)).map((rest) => [frame, ...rest])
        );
  for (const order of permutations(frames)) {
    const value = store();
    for (const frame of order) value.capture(frame);
    for (const frame of frames.slice(0, 3)) value.capture(frame);
    expect(value.list().messages).toHaveLength(0);
    expect(
      value.db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM messages WHERE body IS NOT NULL OR attachments!='[]'"
        )
        .get()!.count
    ).toBe(0);
  }
});

test("revision aliases and delete-first tombstones survive a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-revision-delete-"));
  directories.push(directory);
  const path = join(directory, "messages.sqlite"),
    first = store(path);
  first.capture(syncDelete(targeted(3000)));
  first.capture(edited(2000, 3000));
  first.close();
  stores.pop();
  const second = store(path);
  second.capture(edited(1000, 2000));
  second.capture(incoming(1000, "replayed original", { attachments: [{ id: "private" }] }));
  expect(second.list().messages).toHaveLength(0);
  expect(second.db.query("SELECT body,attachments FROM messages").all()).toEqual([
    { body: null, attachments: "[]" },
  ]);
});

test.each([
  "remote",
  "admin",
])("ordinary %s deletes also resolve edited revision aliases", (kind) => {
  const value = store(),
    group = { groupInfo: { groupId: "group" } };
  value.capture(incoming(1000, "original", group));
  value.capture(edited(1000, 2000, "edited", group));
  value.capture(
    incoming(
      3000,
      null,
      {
        ...group,
        ...(kind === "remote"
          ? { remoteDelete: { timestamp: 2000 } }
          : { adminDelete: { targetAuthorUuid: "alice", targetTimestamp: 2000 } }),
      },
      { sourceUuid: kind === "remote" ? "alice" : "admin" }
    )
  );
  expect(value.list().messages).toHaveLength(0);
});

test("attachment deletion durably denies all attachments on only the addressed message while retaining text", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-attachment-delete-"));
  directories.push(directory);
  const path = join(directory, "messages.sqlite"),
    first = store(path);
  const deletion = syncDelete({
    attachmentDeletes: [
      {
        conversation,
        targetMessage: { author: "alice", sentTimestamp: 2000 },
        clientUuid: "cross-device-id",
      },
    ],
  });
  first.capture(incoming(1000, "retained text", { attachments: [{ id: "one" }, { id: "two" }] }));
  first.capture(
    edited(1000, 2000, "retained edit", { attachments: [{ id: "one" }, { id: "two" }] })
  );
  const id = first.list().messages[0]!.id;
  first.capture(incoming(4000, "unrelated", { attachments: [{ id: "other" }] }));
  first.capture(deletion);
  expect(first.list().messages.find((m) => m.id === id)).toMatchObject({
    body: "retained edit",
    attachments: [],
  });
  expect(() => first.attachment(id, "one")).toThrow("unavailable");
  expect(first.list().messages[0]!.attachments).toEqual([
    { id: "other", contentType: "application/octet-stream", filename: null, size: null },
  ]);
  first.close();
  stores.pop();
  const second = store(path);
  second.capture(edited(2000, 3000, "later edit", { attachments: [{ id: "one" }] }));
  expect(second.list().messages.find((m) => m.id === id)).toMatchObject({
    body: "later edit",
    attachments: [],
  });
  expect(() => second.attachment(id, "one")).toThrow("unavailable");
});

test("attachment deletion preceding the message never admits its downloaded references", () => {
  const value = store();
  value.capture(
    syncDelete({
      attachmentDeletes: [
        { conversation, targetMessage: { author: "alice", sentTimestamp: 1000 } },
      ],
    })
  );
  value.capture(incoming(1000, "text", { attachments: [{ id: "one" }] }));
  expect(value.list().messages[0]).toMatchObject({ body: "text", attachments: [] });
});

test("conversation deletion uses known arrival anchors, preserves later messages, and survives replay", () => {
  const value = store();
  value.capture(incoming(9000, "old arrival with later clock"));
  value.capture(incoming(1000, "anchor"));
  value.capture(incoming(500, "new arrival with earlier clock"));
  value.capture(incoming(600, "different chat", {}, { sourceUuid: "bob" }));
  const deletion = syncDelete({
    conversationDeletes: [
      {
        conversation,
        mostRecentMessages: [{ author: "alice", sentTimestamp: 1000 }],
        isFullDelete: true,
      },
    ],
  });
  value.capture(deletion);
  value.capture(incoming(1000, "anchor replay"));
  value.capture(deletion);
  expect(
    value
      .list()
      .messages.map((m) => m.body)
      .sort()
  ).toEqual(["different chat", "new arrival with earlier clock"]);
});

test("missing, malformed and merely tombstoned conversation anchors never cause broad wipes", () => {
  const value = store();
  value.capture(incoming(1000, "keep"));
  value.capture(syncDelete(targeted(2000)));
  for (const sentTimestamp of [2000, 3000, null, -1, Number.MAX_SAFE_INTEGER + 1])
    value.capture(
      syncDelete({
        conversationDeletes: [
          {
            conversation,
            mostRecentMessages: [{ author: "alice", sentTimestamp }],
            isFullDelete: true,
          },
        ],
      })
    );
  value.capture(syncDelete({ localOnlyConversationDeletes: [{ conversation }] }));
  expect(value.list().messages.map((m) => m.body)).toEqual(["keep"]);
});

test("conversation non-expiring fallback anchors and edited revisions are recognized", () => {
  const value = store();
  value.capture(incoming(1000, "before"));
  value.capture(incoming(2000, "anchor"));
  value.capture(edited(2000, 2500));
  value.capture(incoming(3000, "after"));
  value.capture(
    syncDelete({
      conversationDeletes: [
        {
          conversation,
          mostRecentMessages: [{ author: "alice", sentTimestamp: 9999 }],
          mostRecentNonExpiringMessages: [{ author: "alice", sentTimestamp: 2500 }],
          isFullDelete: false,
        },
      ],
    })
  );
  expect(value.list().messages.map((m) => m.body)).toEqual(["after"]);
});
