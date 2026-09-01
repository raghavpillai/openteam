import { describe, expect, test } from "bun:test";

const source = (path: string) =>
  Bun.file(new URL(`../src/renderer/${path}`, import.meta.url)).text();

describe("chat performance and functionality reconciliation", () => {
  test("stages generic attachments as raw blobs without base64 amplification", async () => {
    const prompt = await source("components/ai-elements/prompt-input.tsx");

    expect(prompt).toContain("URL.createObjectURL(file)");
    expect(prompt).toContain("onStage(attachment.file, attachment.file.name)");
    expect(prompt).toContain("pendingAttachments,\n        MAX_PARALLEL_UPLOADS,");
    expect(prompt).toContain("attachments: AssetRef[]");
    expect(prompt).not.toContain("FileReader");
    expect(prompt).not.toContain("readAsDataURL");
    expect(prompt).not.toContain("bytesBase64");
  });

  test("keeps bounded virtual histories while restoring rich message branches", async () => {
    const chat = await source("components/openbot/chat-pane.tsx");

    expect(chat).toContain("maxItems: 80");
    expect(chat).toContain("durableSendAuthoritativeEcho(delivery, messages)");
    expect(chat).toContain("return authoritative ? [authoritative.id] : []");
    expect(chat).toContain("authoritativeById.get(delivery.acceptedMessage.id)");
    expect(chat).toContain("messageDisplayProjection(message)");
    expect(chat).toContain("@openbot/product-core");
    expect(chat).toContain('import("./file-attachment")');
    expect(chat).toContain('import("./bot-template-share")');
    expect(chat).toContain("<BotTemplateConversationFlow");
    expect(chat).toContain("onOpenRoutine={onOpenRoutine}");
    expect(chat).toContain("approvalPresentation(approval)");
    expect(chat).toContain("@openbot/product-core");
    expect(chat).not.toContain('details.type === "autoReview"');
    expect(chat).not.toContain('details.type === "localTool"');
    expect(chat).not.toContain('from "./file-attachment"');
    expect(chat).not.toContain('from "./bot-template-share"');
  });

  test("keeps thread and media interactions accessible under bounded rendering", async () => {
    const [thread, image] = await Promise.all([
      source("components/openbot/thread-tray.tsx"),
      source("components/openbot/image-attachment.tsx"),
    ]);

    expect(thread).toContain("maxItems: 70");
    expect(thread).toContain("inert={!open}");
    expect(thread).toContain("onStage={onStage}");
    expect(thread).toContain("onDiscardStages={onDiscardStages}");
    expect(image).toContain('loading={variant === "composer" ? "eager" : "lazy"}');
    expect(image).toContain('decoding="async"');
    expect(image).toContain('event.key === "ArrowLeft"');
    expect(image).toContain('event.key === "ArrowRight"');
    expect(image).toContain('aria-label="Previous media"');
    expect(image).toContain('aria-label="Next media"');
  });
});
