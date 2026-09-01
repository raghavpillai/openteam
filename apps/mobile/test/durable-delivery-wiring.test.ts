import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("mobile durable delivery wiring", () => {
  test("isolates and crash-recovers persisted send journals", async () => {
    const [context, storage] = await Promise.all([
      source("src/state/openbot-context.tsx"),
      source("src/durable-send-storage.ts"),
    ]);

    expect(context).toContain("durableAccountScope(client.baseUrl)");
    expect(context).toContain("getAuthAccountIdForServer(serverUrl)");
    expect(context).toContain('getAuthTokenForServer(serverUrl) ?? "local"');
    expect(storage).toContain(".a.json");
    expect(storage).toContain(".b.json");
    expect(storage).toContain(".next");
    expect(storage).toContain("right.generation - left.generation");
  });

  test("restores cancelled payloads without overwriting a non-empty composer", async () => {
    const [composer, route, thread] = await Promise.all([
      source("src/components/composer.tsx"),
      source("app/chat/[channelId].tsx"),
      source("src/components/thread-sheet.tsx"),
    ]);

    expect(composer).toContain("if (text.trim() || attachments.length > 0 || replyTarget) return");
    expect(composer).toContain("recovery.attachments.map");
    expect(composer).toContain("recovery.stagedAttachments ?? []");
    expect(composer).not.toContain("if (staged.length > 0) void onDiscardStages?.(staged)");
    expect(route).toContain("await cancelQueuedMessage(nonce)");
    expect(route).toContain("stagedAttachments: payload.stagedAttachments");
    expect(thread).toContain("await onCancelQueued(nonce)");
    expect(thread).toContain("stagedAttachments: payload.stagedAttachments");
  });

  test("ties a queued send to the exact composer draft it consumed", async () => {
    const [composer, context, drafts] = await Promise.all([
      source("src/components/composer.tsx"),
      source("src/state/openbot-context.tsx"),
      source("src/drafts.ts"),
    ]);

    expect(composer).toContain("consumedDraft: { key: string; id: string }");
    expect(composer).toContain("{ key: draftKey, id: draftId }");
    expect(context).toContain("clearConversationDraftIfCurrent(");
    expect(context).toContain("record.payload.consumedDraft.id");
    expect(drafts).toContain("current?.id !== expectedId");
  });

  test("stages offline attachments locally and commits them during durable flush", async () => {
    const [composer, context, stage, bubble] = await Promise.all([
      source("src/components/composer.tsx"),
      source("src/state/openbot-context.tsx"),
      source("src/durable-attachment-stage.ts"),
      source("src/components/message-bubble.tsx"),
    ]);

    expect(stage).toContain("FileSystem.copyAsync");
    expect(stage).toContain("FileSystem.moveAsync");
    expect(composer).toContain("await onStage(attachment.source)");
    expect(composer).not.toContain("uploadsBlockSend");
    expect(context).toContain("commitStagedAttachments: async (record)");
    expect(context).toContain('code: "attachment_commit_timeout"');
    expect(context).toContain("discardStagedAttachments: discardMobileDeliveryAttachments");
    expect(bubble).toContain("stagedImages");
    expect(bubble).toContain("stagedFiles");
  });

  test("durably restores deterministic failures into main and thread composers", async () => {
    const [composer, context, route, thread, drafts, delivery] = await Promise.all([
      source("src/components/composer.tsx"),
      source("src/state/openbot-context.tsx"),
      source("app/chat/[channelId].tsx"),
      source("src/components/thread-sheet.tsx"),
      source("src/drafts.ts"),
      source("../../packages/product-core/src/durable-delivery.ts"),
    ]);

    expect(context).toContain("sendController.getRecoverySnapshot()");
    expect(context).toContain("acknowledgeDeliveryRecovery");
    expect(route).toContain("presentedRecoveryNonces");
    expect(route).toContain("onRecoveryConsumed={acknowledgeDeliveryRecovery}");
    expect(thread).toContain("deliveryRecoveries.find");
    expect(thread).toContain("onRecoveryConsumed={onAcknowledgeRecovery}");
    expect(composer).toContain("appliedRecoveryNonce.current = recovery.id");
    expect(composer).toContain("recoveryOwned: true");
    expect(drafts).toContain("recoveryNonce?: string");
    expect(delivery).toContain("durableSendPromptDigest");
    expect(delivery).toContain("acknowledgeRecovery");
  });
});
