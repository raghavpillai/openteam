import { expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { messageDisplayProjection } from "../src/messages";

test("a pending message exposes every staged filename through the twenty-file limit", () => {
  const staged = Array.from({ length: 21 }, (_, index) => ({
    stagingId: `stage-file-${index}`, fileName: `資料 ${index}.pdf`,
    mimeType: "application/pdf", byteSize: 100, kind: "pdf" as const,
  }));
  const message: ChannelMessageView = {
    id: "pending", sequence: "1", channelId: "channel-1", sender: "user",
    senderBotId: null, sourceRunId: null, content: "Files", createdAt: new Date(0).toISOString(),
    metadata: { clientStagedAttachments: staged },
  };
  expect(messageDisplayProjection(message).stagedAttachments).toEqual(staged.slice(0, 20));
});
