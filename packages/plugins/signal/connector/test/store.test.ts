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

test("rejects unrelated account events and binds storage permanently to one ACI", () => {
  const value = store();
  value.capture({ ...incoming(1000), account: "other" });
  value.capture({ envelope: incoming(1001).envelope });
  expect(value.list().messages).toHaveLength(0);
  expect(() => value.bind({ aci: "other" })).toThrow("different Signal account");
  value.bind({ ...self, number: "+12025550199" });
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

test("search treats SQL syntax and wildcard characters literally", () => {
  const value = store();
  value.capture(incoming(1000, "literal %_ ' OR 1=1 --"));
  value.capture(incoming(1001, "other"));
  expect(value.list({ query: "%_" }).messages).toHaveLength(1);
  expect(value.list({ query: "' OR 1=1 --" }).messages).toHaveLength(1);
  expect(value.list({ chat: "' OR 1=1 --" }).messages).toHaveLength(0);
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
