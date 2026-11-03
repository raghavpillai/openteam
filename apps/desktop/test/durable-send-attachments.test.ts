import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRef, ChannelMessageView } from "@openteam/contracts";
import {
  createDurableSendController,
  parseDurableSendJournal,
  type DurableSendJournal,
  type DurableSendPayload,
  type DurableSendRecord,
  type DurableStagedAttachment,
} from "@openteam/product-core/durable-delivery";
import { DurableSendJournalStore } from "../src/main/durable-send-journal-store";

const assets = (count: number): AssetRef[] => Array.from({ length: count }, (_, index) => ({
  assetId: (index + 1).toString(16).padStart(64, "0"),
  fileName: `資料 ${index}.png`, mimeType: "image/png", byteSize: 100, kind: "image",
}));

const payload = (count: number, mode: "uploaded" | "staged" | "mixed"): DurableSendPayload => {
  const attachments: AssetRef[] = [], stagedAttachments: DurableStagedAttachment[] = [];
  assets(count).forEach((asset, position) => {
    if (mode === "uploaded" || (mode === "mixed" && position % 2 === 0)) attachments.push(asset);
    else {
      const { assetId: _, ...metadata } = asset;
      stagedAttachments.push({ ...metadata, stagingId: `stage-file-${position}`, position });
    }
  });
  return { content: "Keep every file", attachments,
    ...(stagedAttachments.length ? { stagedAttachments } : {}), replyToMessageId: "reply-1" };
};

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-attachment-restart-"));
  const scope = "attachment-restart", target = { channelId: "channel-1", conversationId: null };
  let offline = true, nonce = 0, clock = 1000;
  const dispatches: DurableSendRecord[] = [], commits: DurableStagedAttachment[][] = [];
  const messages: ChannelMessageView[] = [];
  const controllers: ReturnType<typeof createDurableSendController>[] = [];
  const read = () => new DurableSendJournalStore(directory).read(scope) as Promise<DurableSendJournal>;
  const controller = () => {
    const disk = new DurableSendJournalStore(directory);
    const instance = createDurableSendController(scope, {
      read: () => disk.read(scope), write: journal => disk.write(scope, journal),
    }, {
      now: () => ++clock, createNonce: () => `attachment-nonce-${++nonce}`,
      isTransportDown: () => offline,
      resolveAcceptance: async () => ({ status: "not_found" }),
      classifyError: () => "offline",
      commitStagedAttachments: async record => {
        const staged = record.payload.stagedAttachments ?? [];
        commits.push(staged);
        return staged.map(({ position }) => assets(20)[position!]);
      },
      dispatch: async record => {
        dispatches.push(structuredClone(record));
        const message: ChannelMessageView = {
          id: `accepted-${record.nonce}`, sequence: String(messages.length + 1),
          channelId: target.channelId, sender: "user", senderBotId: null, sourceRunId: null,
          content: record.payload.content, createdAt: new Date(clock).toISOString(),
          metadata: { attachments: record.payload.attachments, replyTo: record.payload.replyToMessageId },
        };
        messages.push(message);
        return { message };
      },
    });
    controllers.push(instance);
    return instance;
  };
  return { target, read, controller, dispatches, commits, messages,
    reconnect: () => { offline = false; },
    cleanup: async () => {
      controllers.forEach(controller => controller.dispose());
      await rm(directory, { recursive: true, force: true });
    },
  };
};

for (const count of [6, 7, 20]) {
  for (const mode of ["uploaded", "staged", "mixed"] as const) {
    test(`${count} ${mode} attachments survive disk restart and reconnect without losing or duplicating another message`, async () => {
      const f = await fixture();
      try {
        const first = f.controller();
        const text = await first.enqueue({ target: f.target, payload: { content: "Unrelated queued text", attachments: [] } });
        const files = await first.enqueue({ target: f.target, payload: payload(count, mode) });
        expect((await f.read()).records).toHaveLength(2);
        expect(f.dispatches).toHaveLength(0);
        first.dispose();

        const restored = f.controller();
        await restored.restore();
        await restored.flush();
        expect(restored.getSnapshot().map(record => record.nonce)).toEqual([text.nonce, files.nonce]);
        expect(restored.getSnapshot()[1]?.payload).toEqual(files.payload);
        expect(f.dispatches).toHaveLength(0);

        f.reconnect();
        await restored.flush();
        expect(f.dispatches.map(record => record.nonce)).toEqual([text.nonce, files.nonce]);
        expect(f.dispatches[1]?.payload.attachments).toEqual(assets(count));
        expect(f.commits).toHaveLength(mode === "uploaded" ? 0 : 1);
        expect(restored.getSnapshot().every(record => record.phase === "accepted-awaiting-echo")).toBe(true);
        restored.dispose();

        const reopened = f.controller();
        await reopened.restore();
        expect(reopened.getSnapshot()).toHaveLength(2);
        await reopened.flush();
        expect(f.dispatches).toHaveLength(2);
        await reopened.reconcile(f.messages);
        expect(reopened.getSnapshot()).toEqual([]);
        expect((await f.read()).records).toEqual([]);
      } finally { await f.cleanup(); }
    });
  }
}

const invalidPayloads: Array<[string, () => DurableSendPayload]> = [
  ["21 uploaded files", () => payload(21, "uploaded")],
  ["21 staged files", () => payload(21, "staged")],
  ["21 mixed files", () => payload(21, "mixed")],
  ["out-of-range staged position", () => {
    const value = payload(20, "staged"); value.stagedAttachments![19].position = 20; return value;
  }],
  ["duplicate staged position", () => {
    const value = payload(20, "staged"); value.stagedAttachments![19].position = 18; return value;
  }],
];

for (const [name, invalid] of invalidPayloads) {
  test(`rejects ${name} before persisting and preserves the existing disk queue`, async () => {
    const f = await fixture();
    try {
      const first = f.controller();
      const text = await first.enqueue({ target: f.target, payload: { content: "Keep this message", attachments: [] } });
      const before = await f.read();
      await expect(first.enqueue({ target: f.target, payload: invalid() })).rejects.toThrow("attachments");
      expect(await f.read()).toEqual(before);
      expect(first.getSnapshot().map(record => record.nonce)).toEqual([text.nonce]);
      first.dispose();
      const restarted = f.controller();
      await restarted.restore();
      expect(restarted.getSnapshot().map(record => record.nonce)).toEqual([text.nonce]);
    } finally { await f.cleanup(); }
  });
}

test("still rejects a partially tampered journal instead of replaying a subset", async () => {
  const f = await fixture();
  try {
    const first = f.controller();
    await first.enqueue({ target: f.target, payload: { content: "First", attachments: [] } });
    await first.enqueue({ target: f.target, payload: payload(20, "mixed") });
    const journal = await f.read();
    expect(parseDurableSendJournal(journal, journal.scope).records).toHaveLength(2);
    journal.records[1].payload.content = "Tampered without its matching digest";
    expect(parseDurableSendJournal(journal, journal.scope).records).toEqual([]);
  } finally { await f.cleanup(); }
});
