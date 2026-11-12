import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { AssetStore } from "@openteam/messaging";
import { MESSAGES_SEND_FILES_TOOL } from "@openteam/contracts/messages-send";
import { MessagesSendService } from "../src/services/messages-send-service";

const context = {
  runId: "run",
  botId: "bot",
  conversationId: "conversation",
  channelId: "channel",
  deliveryId: null,
  origin: "user" as const,
  callId: "call",
  isFork: false,
  replyToMessageId: null,
};

async function fixture(allowed = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "imessage-service-")));
  const assets = new AssetStore({ root: join(root, "assets"), allowedFileRoots: [root] });
  let message: any;
  const calls: any[] = [];
  let failure: string | undefined;
  const db: any = {
    channel: { findUnique: async () => ({ kind: "bot_dm" }) },
    channelMessage: {
      findUnique: async () => message,
      findUniqueOrThrow: async () => message,
      update: async ({ data }: any) => (message = { ...message, ...data }),
    },
    $executeRaw: async () => 0,
    event: { create: async () => ({}) },
    $transaction: async (work: any) => work(db),
  };
  const messaging: any = {
    assets,
    sendVisible: async (_context: unknown, input: any) => {
      message = {
        id: "card",
        sequence: 1n,
        channelId: "channel",
        sender: "bot",
        senderBotId: "bot",
        sourceRunId: "run",
        content: "Send this message?",
        createdAt: new Date(),
        channel: { archivedAt: null },
        metadata: input,
      };
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
    callCapability: async (_machineId: string, body: unknown) => {
      calls.push(body);
      if (failure) throw new Error(failure);
      return { kind: "send", verified: false };
    },
  };
  return {
    root,
    assets,
    calls,
    service: new MessagesSendService(db, messaging, machines),
    card: () => message,
    fail: (reason: string) => {
      failure = reason;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a PDF is snapshotted before approval and its reviewed bytes are sent exactly once", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "report.pdf");
    const original = "%PDF-1.7\noriginal";
    await writeFile(path, original);
    expect(
      await f.service.create(context, { to: "+15555550100", attachmentPaths: [path] })
    ).toMatchObject({ delivery: "awaiting_approval" });
    const stored = f.card().metadata.imessage;
    expect(stored.text).toBe("");
    expect(stored.attachments).toMatchObject([
      { fileName: "report.pdf", byteSize: original.length },
    ]);
    expect(stored.attachmentPaths).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("bytesBase64");
    expect(f.calls).toHaveLength(0);
    await writeFile(path, "%PDF-1.7\nchanged after approval was requested");
    await Effect.runPromise(f.service.mutate("card", { action: "send" }));
    expect(f.calls).toEqual([
      {
        tool: MESSAGES_SEND_FILES_TOOL,
        botId: "bot",
        callId: "imessage-send:card",
        arguments: {
          text: "",
          to: "+15555550100",
          attachments: [
            { fileName: "report.pdf", bytesBase64: Buffer.from(original).toString("base64") },
          ],
        },
      },
    ]);
    expect(f.card().metadata.cardState).toBe("sent");
    expect(f.card().metadata.outcomeText).toContain(`report.pdf (${original.length} bytes)`);
    await Effect.runPromise(f.service.mutate("card", { action: "send" }));
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("discarding files never reaches the Mac and existing recipient grants still send files", async () => {
  for (const allowed of [false, true]) {
    const f = await fixture(allowed);
    try {
      const path = join(f.root, "invoice.pdf");
      await writeFile(path, "%PDF-1.7\ninvoice");
      const result = await f.service.create(context, {
        text: "Invoice attached",
        to: "+15555550100",
        attachmentPaths: [path],
      });
      if (allowed) {
        expect(result).toMatchObject({ delivery: "sent" });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].arguments.text).toBe("Invoice attached");
      } else {
        await Effect.runPromise(f.service.mutate("card", { action: "cancel" }));
        expect(f.card().metadata.cardState).toBe("dismissed");
        expect(f.calls).toHaveLength(0);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("photos, PDFs and other file types can be approved together with their original names and bytes", async () => {
  const f = await fixture();
  try {
    const files = [
      {
        name: "photo.png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
          "base64"
        ),
        mime: "image/png",
      },
      {
        name: "document.pdf",
        bytes: await readFile(
          new URL("../../computer/test/fixtures/input-parity/fixture.pdf", import.meta.url)
        ),
        mime: "application/pdf",
      },
      { name: "notes.txt", bytes: Buffer.from("A plain text attachment."), mime: "text/plain" },
    ];
    for (const file of files) await writeFile(join(f.root, file.name), file.bytes);
    await f.service.create(context, {
      to: "+15555550100",
      attachmentPaths: files.map((file) => join(f.root, file.name)),
    });
    expect(
      f.card().metadata.imessage.attachments.map((file: any) => [file.fileName, file.mimeType])
    ).toEqual(files.map((file) => [file.name, file.mime]));
    await Effect.runPromise(f.service.mutate("card", { action: "send" }));
    expect(f.calls[0].arguments.attachments).toEqual(
      files.map((file) => ({ fileName: file.name, bytesBase64: file.bytes.toString("base64") }))
    );
  } finally {
    await f.cleanup();
  }
});

test("partial sends stay unconfirmed and older desktops explain how to enable attachments", async () => {
  for (const reason of [
    "Messages send outcome is uncertain; some items may have been sent",
    "Unknown desktop capability",
  ]) {
    const f = await fixture();
    try {
      const path = join(f.root, "report.pdf");
      await writeFile(path, "%PDF-1.7\nfixture");
      await f.service.create(context, {
        text: "Here",
        chatId: "any;+;chat123",
        attachmentPaths: [path],
      });
      f.fail(reason);
      await Effect.runPromise(f.service.mutate("card", { action: "send" }));
      const metadata = f.card().metadata;
      expect(metadata.cardState).toBe(reason.startsWith("Unknown") ? "failed" : "unknown");
      if (reason.startsWith("Unknown"))
        expect(metadata.sendError).toBe("Update OpenTeam on My Mac to send attachments.");
      else expect(metadata.outcomeText).toContain("never send it again automatically");
      await Effect.runPromise(f.service.mutate("card", { action: "send" }));
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }
});

test("missing, oversized and protected files fail before a card or any send", async () => {
  const f = await fixture();
  try {
    await expect(
      f.service.create(context, {
        to: "+15555550100",
        attachmentPaths: [join(f.root, "missing.pdf")],
      })
    ).rejects.toThrow("No file");
    const path = join(f.root, "report.pdf");
    await writeFile(path, Buffer.alloc(14 * 1024 * 1024));
    await expect(
      f.service.create(context, { to: "+15555550100", attachmentPaths: [path, path] })
    ).rejects.toThrow("25 MiB in total");
    await expect(
      f.service.create(context, { to: "+15555550100", attachmentPaths: ["/etc/hosts"] })
    ).rejects.toThrow("outside an allowed");
    expect(f.card()).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
