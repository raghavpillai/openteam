import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { AssetStore } from "@openteam/messaging";
import { MESSAGES_SEND_FILES_TOOL } from "@openteam/contracts/messages-send";
import { MessagesSendService } from "../src/services/messages-send-service";

const context = { runId: "run", botId: "bot", conversationId: "conversation", channelId: "channel", deliveryId: null, origin: "user" as const, callId: "call", isFork: false, replyToMessageId: null };
const to = "+15555550100";

async function fixture(allowed = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "imessage-service-")));
  let message: any;
  const calls: any[] = [];
  const db: any = {
    channel: { findUnique: async () => ({ kind: "bot_dm" }) },
    channelMessage: { findUnique: async () => message, findUniqueOrThrow: async () => message, update: async ({ data }: any) => (message = { ...message, ...data }) },
    $executeRaw: async () => 0,
    event: { create: async () => ({}) },
    $transaction: async (work: any) => work(db),
  };
  const messaging: any = {
    assets: new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] }),
    sendVisible: async (_context: unknown, input: any) => {
      message = { id: "card", sequence: 1n, channelId: "channel", sender: "bot", senderBotId: "bot", sourceRunId: "run", content: "Send this message?", createdAt: new Date(), channel: { archivedAt: null }, metadata: input };
      return { acknowledgement: { sent: true, message_id: "card" } };
    },
    enqueueWake: async () => ({ run: { id: "wake" } }),
    scheduleTranscriptProjection: async () => {},
  };
  const machines: any = {
    messagesMachine: async () => ({ machineId: "mac", label: "My Mac" }),
    messagesSendAllowed: async () => allowed,
    allowMessagesRecipient: async () => {},
    relay: { connected: () => true },
    callCapability: async (_machineId: string, body: unknown) => { calls.push(body); return { kind: "send", verified: false }; },
  };
  return { root, calls, service: new MessagesSendService(db, messaging, machines), card: () => message, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a PDF is snapshotted before approval and its reviewed bytes are sent exactly once", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "report.pdf"), original = "%PDF-1.7\noriginal";
    await writeFile(path, original);
    expect(await f.service.create(context, { to, attachmentPaths: [path] })).toMatchObject({ delivery: "awaiting_approval" });
    const stored = f.card().metadata.imessage;
    expect(stored).toMatchObject({ text: "", attachments: [{ fileName: "report.pdf", byteSize: original.length }] });
    expect(stored.attachmentPaths).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("bytesBase64");
    expect(f.calls).toHaveLength(0);
    await writeFile(path, "%PDF-1.7\nchanged after approval was requested");
    await Effect.runPromise(f.service.mutate("card", { action: "send" }));
    expect(f.calls).toEqual([{ tool: MESSAGES_SEND_FILES_TOOL, botId: "bot", callId: "imessage-send:card",
      arguments: { text: "", to, attachments: [{ fileName: "report.pdf", bytesBase64: Buffer.from(original).toString("base64") }] } }]);
    // Checked before toMatchObject: Bun 1.3 swaps asymmetric matchers into the received object.
    expect(f.card().metadata.outcomeText).toContain("delivery is unconfirmed");
    expect(f.card().metadata).toMatchObject({ cardState: "sent", outcomeText: expect.stringContaining(`report.pdf (${original.length} bytes)`) });
    await Effect.runPromise(f.service.mutate("card", { action: "send" }));
    expect(f.calls).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("discarding files never reaches the Mac and existing recipient grants still send files", async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    try {
      const path = join(f.root, "invoice.pdf");
      await writeFile(path, "%PDF-1.7\ninvoice");
      const result = await f.service.create(context, { text: "Invoice attached", to, attachmentPaths: [path] });
      if (allowed) {
        expect(result).toMatchObject({ delivery: "sent" });
        expect(f.calls.map(call => call.arguments.text)).toEqual(["Invoice attached"]);
      } else {
        await Effect.runPromise(f.service.mutate("card", { action: "cancel" }));
        expect(f.card().metadata.cardState).toBe("dismissed");
        expect(f.calls).toHaveLength(0);
      }
    } finally { await f.cleanup(); }
  }
});

test("missing, oversized and protected files fail before a card or any send", async () => {
  const f = await fixture();
  try {
    await expect(f.service.create(context, { to, attachmentPaths: [join(f.root, "missing.pdf")] })).rejects.toThrow("No file");
    const path = join(f.root, "report.pdf");
    await writeFile(path, Buffer.alloc(14 * 1024 * 1024));
    await expect(f.service.create(context, { to, attachmentPaths: [path, path] })).rejects.toThrow("25 MiB in total");
    await expect(f.service.create(context, { to, attachmentPaths: ["/etc/hosts"] })).rejects.toThrow("outside an allowed");
    expect(f.card()).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});
