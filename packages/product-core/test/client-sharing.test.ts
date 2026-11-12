import { describe, expect, test } from "bun:test";
import type { ChannelMessageView } from "@openteam/contracts";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  activityContentSummary,
  attachmentByteLimit,
  attachmentPreviewKind,
  firstOversizedAttachment,
  formatAttachmentBytes,
  projectRichMessage,
} from "../src";

const message = (metadata: unknown): ChannelMessageView => ({
  id: "message-1",
  sequence: "1",
  channelId: "channel-1",
  sender: "agent",
  senderBotId: "bot-1",
  sourceRunId: null,
  content: "hello",
  metadata,
  createdAt: "2026-09-01T00:00:00.000Z",
});

describe("shared desktop and iOS product policy", () => {
  test("uses one capability-driven upload policy for video and regular files", () => {
    const video = { fileName: "demo.MOV", mimeType: "application/octet-stream", byteSize: 201 };
    const document = { fileName: "notes.md", mimeType: "text/markdown", byteSize: 101 };
    const capabilities = {
      ...CLIENT_CAPABILITIES.uploads,
      maxRegularBytes: 100,
      maxVideoBytes: 200,
    };

    expect(attachmentByteLimit(video, capabilities)).toBe(200);
    expect(firstOversizedAttachment([video, document], capabilities)).toEqual({
      candidate: video,
      limit: 200,
    });
    expect(formatAttachmentBytes(1_572_864)).toBe("1.5 MB");
    expect(
      attachmentPreviewKind({
        assetId: "asset-1",
        fileName: "report.csv",
        mimeType: "application/octet-stream",
        byteSize: 10,
        kind: "file",
      })
    ).toBe("table");
  });

  test("fails closed for incomplete secret requests", () => {
    expect(
      projectRichMessage(message({ type: "secret-request", secretRequest: { label: "Token" } }))
    ).toBeNull();
    expect(
      projectRichMessage(
        message({
          type: "secret-request",
          secretRequest: { label: "Token", connector: "github", field: "token" },
        })
      )
    ).toMatchObject({ kind: "secret-request", provided: false });
  });

  test("bounds cyclic untrusted activity payloads", () => {
    const payload: Record<string, unknown> = { output: "ok" };
    payload.self = payload;
    const summary = activityContentSummary(payload);
    expect(summary).toContain('"self": "[Circular]"');
    expect(summary?.length).toBeLessThanOrEqual(1_501);
  });
});
