import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../store";

// Deterministic synthetic traffic: no provider process or live account is used.
const account = { aci: "chaos-self", number: "+12025550100" };
const alice = "chaos-alice";
const group = "chaos-group";
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
function shuffled<T>(values: T[], next: () => number) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
function incoming(timestamp: number, message: string | null, data: any = {}, sender = alice) {
  return {
    account: account.aci,
    envelope: { sourceUuid: sender, dataMessage: { timestamp, message, ...data } },
  };
}
function edit(target: number, timestamp: number, body: string) {
  return {
    account: account.aci,
    envelope: {
      sourceUuid: alice,
      editMessage: {
        targetSentTimestamp: target,
        dataMessage: { timestamp, message: body, attachments: [{ id: `attachment-${timestamp}` }] },
      },
    },
  };
}
function sync(deletes: any, sourceUuid = account.aci) {
  return { account: account.aci, envelope: { sourceUuid, syncMessage: { deleteForMe: deletes } } };
}
const conversation = { kind: "contact", id: alice };
const addressed = (timestamp: number) => ({ author: alice, sentTimestamp: timestamp });
function store(path = ":memory:") {
  const value = new MessageStore(path);
  value.bind(account);
  return value;
}

test("chaos: 128 seeded edit/delete/duplicate orders cannot resurrect content or cross chat boundaries", () => {
  for (let seed = 1; seed <= 128; seed++) {
    const next = random(seed);
    const value = store();
    try {
      const revisions = [
        incoming(1000, "original", { attachments: [{ id: "original-file" }] }),
        edit(1000, 2000, "edit-one"),
        edit(2000, 3000, "edit-two"),
        edit(3000, 4000, "edit-final"),
      ];
      const target = [1000, 2000, 3000, 4000][Math.floor(next() * 4)]!;
      const deletion =
        seed % 2
          ? incoming(5000, null, { remoteDelete: { timestamp: target } })
          : sync({ messageDeletes: [{ conversation, messages: [addressed(target)] }] });
      const independent = incoming(1000, "separate group", { groupInfo: { groupId: group } });
      for (const event of shuffled(
        [...revisions, ...revisions, deletion, deletion, independent],
        next
      ))
        value.capture(event);
      // Exercise replay after all aliases and tombstones are known.
      for (const event of shuffled(revisions, next)) value.capture(event);
      expect(value.list({ chat: `contact:${alice}` }).messages, `seed ${seed}`).toEqual([]);
      expect(value.list({ chat: `group:${group}` }).messages.map((row) => row.body)).toEqual([
        "separate group",
      ]);
      const deleted = value.db
        .query<{ body: string | null; attachments: string }, []>(
          "SELECT body,attachments FROM messages WHERE deleted=1"
        )
        .all();
      expect(deleted.every((row) => row.body === null && row.attachments === "[]")).toBe(true);
      expect(deleted.length).toBeGreaterThan(0);
    } finally {
      value.close();
    }
  }
});

test("chaos: attachment-only redaction survives 64 seeded edit orders, reopen and replay", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-chaos-redaction-"));
  try {
    for (let seed = 1; seed <= 64; seed++) {
      const path = join(root, `seed-${seed}.sqlite`);
      let value = store(path);
      const revisions = [
        incoming(1000, "original", { attachments: [{ id: "original-file" }] }),
        edit(1000, 2000, "edit-one"),
        edit(2000, 3000, "edit-final"),
      ];
      const target = [1000, 2000, 3000][seed % 3]!;
      const redaction = sync({
        attachmentDeletes: [{ conversation, targetMessage: addressed(target) }],
      });
      try {
        for (const event of shuffled([...revisions, redaction, redaction], random(seed)))
          value.capture(event);
        value.close();
        value = store(path);
        for (const event of shuffled([...revisions, ...revisions], random(seed + 1000)))
          value.capture(event);
        const messages = value.list({ chat: `contact:${alice}` }).messages;
        expect(messages, `seed ${seed}`).toHaveLength(1);
        expect(messages[0]!.body).toBe("edit-final");
        expect(messages[0]!.attachments).toEqual([]);
        expect(() => value.attachment(messages[0]!.id, `attachment-${target}`)).toThrow(
          "unavailable"
        );
      } finally {
        value.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chaos: 96 seeded ephemeral/replay orders stay excluded and foreign sync cannot wipe ordinary messages", () => {
  for (let seed = 1; seed <= 96; seed++) {
    const value = store();
    try {
      const revisions = [
        incoming(1000, "original"),
        edit(1000, 2000, "first edit"),
        edit(2000, 3000, "final edit"),
      ];
      const ephemeral = incoming(
        seed % 3 === 0 ? 3000 : 1000,
        "ephemeral",
        seed % 2
          ? { viewOnce: true, attachments: [{ id: "private-file" }] }
          : { expiresInSeconds: 30, attachments: [{ id: "private-file" }] }
      );
      const survivor = incoming(9000, "ordinary", { attachments: [{ id: "ordinary-file" }] });
      const malicious = sync(
        { messageDeletes: [{ conversation, messages: [addressed(9000)] }] },
        "foreign-device-account"
      );
      for (const event of shuffled([...revisions, ephemeral, survivor, malicious], random(seed)))
        value.capture(event);
      for (const event of revisions) value.capture(event);
      expect(
        value.list().messages.map((row) => row.body),
        `seed ${seed}`
      ).toEqual(["ordinary"]);
      expect(value.attachment(value.list().messages[0]!.id, "ordinary-file")).toBeDefined();
    } finally {
      value.close();
    }
  }
});

test("chaos: 32 non-monotonic arrival histories honor conversation anchors without deleting later arrivals", () => {
  for (let seed = 1; seed <= 32; seed++) {
    const value = store();
    try {
      const timestamps = shuffled(
        Array.from({ length: 10 }, (_, index) => 10000 + index),
        random(seed)
      );
      for (const timestamp of timestamps)
        value.capture(incoming(timestamp, `message-${timestamp}`));
      const deletion = sync({
        conversationDeletes: [
          {
            conversation,
            isFullDelete: true,
            mostRecentMessages: [addressed(timestamps[3]!)],
            mostRecentNonExpiringMessages: [],
          },
        ],
      });
      value.capture(deletion);
      // A lower server timestamp arriving later must not be treated as older locally.
      value.capture(incoming(100, "late delivery with older timestamp"));
      value.capture(incoming(20000, "other conversation", { groupInfo: { groupId: group } }));
      value.capture(
        sync({
          conversationDeletes: [
            {
              conversation,
              isFullDelete: true,
              mostRecentMessages: [addressed(999999)],
              mostRecentNonExpiringMessages: [],
            },
          ],
        })
      );
      value.capture(deletion);
      expect(value.list({ chat: `contact:${alice}` }).messages.map((row) => row.body)).toEqual([
        "late delivery with older timestamp",
        ...timestamps
          .slice(4)
          .reverse()
          .map((timestamp) => `message-${timestamp}`),
      ]);
      expect(value.list({ chat: `group:${group}` }).messages[0]!.body).toBe("other conversation");
    } finally {
      value.close();
    }
  }
});

test("chaos: a storage write failure rolls back every target in a deletion batch", () => {
  const value = store();
  try {
    value.capture(incoming(1000, "first", { attachments: [{ id: "first-file" }] }));
    value.capture(incoming(2000, "second", { attachments: [{ id: "second-file" }] }));
    const before = value.list().messages;
    value.db.exec(`CREATE TEMP TRIGGER injected_storage_failure BEFORE INSERT ON messages
      WHEN NEW.timestamp=2000 BEGIN SELECT RAISE(ABORT,'synthetic disk write failure'); END;`);
    const deletion = sync({
      messageDeletes: [{ conversation, messages: [addressed(1000), addressed(2000)] }],
    });
    expect(() => value.capture(deletion)).toThrow("synthetic disk write failure");
    expect(value.list().messages).toEqual(before);
    for (const message of before)
      expect(value.attachment(message.id, message.attachments[0]!.id)).toBeDefined();
    value.db.exec("DROP TRIGGER injected_storage_failure");
    value.capture(deletion);
    expect(value.list().messages).toEqual([]);
    for (const message of before)
      expect(() => value.attachment(message.id, message.attachments[0]!.id)).toThrow("unavailable");
  } finally {
    value.close();
  }
});

test("chaos: SIGKILL preserves committed redaction and unknown sends while rolling back an in-flight write", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-chaos-kill-"));
  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      const path = join(root, `crash-${iteration}.sqlite`);
      const child = Bun.spawn(
        [process.execPath, new URL("./chaos-store-writer.ts", import.meta.url).pathname, path],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      try {
        const reader = child.stdout.getReader();
        const ready = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Writer did not reach crash boundary")), 5000)
          ),
        ]);
        expect(new TextDecoder().decode(ready.value)).toBe("in-flight\n");
        child.kill("SIGKILL");
        await child.exited;
        const recovered = store(path);
        try {
          expect(recovered.db.query("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
          expect(recovered.list().messages.map((row) => row.body)).toEqual(["survivor"]);
          expect(
            recovered.previousSend("uncertain", { to: alice, body: "maybe-sent" })
          ).toMatchObject({ existing: true, state: "unknown" });
          // Both replay and retry identity must retain their durable privacy/safety state.
          recovered.capture(incoming(1000, "replay", { attachments: [{ id: "redacted-file" }] }));
          expect(recovered.list().messages.map((row) => row.body)).toEqual(["survivor"]);
          expect(recovered.beginSend("uncertain", { to: alice, body: "maybe-sent" })).toMatchObject(
            { existing: true, state: "unknown" }
          );
        } finally {
          recovered.close();
        }
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
