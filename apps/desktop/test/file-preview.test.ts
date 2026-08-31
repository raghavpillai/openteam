import { describe, expect, test } from "bun:test";
import type { AssetRef } from "@openbot/contracts";
import {
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "../src/renderer/lib/attachment-preview";

const asset = (fileName: string, mimeType: string, kind: AssetRef["kind"] = "file"): AssetRef => ({
  assetId: "a".repeat(64),
  fileName,
  mimeType,
  byteSize: 1_024,
  kind,
});

describe("Grok-compatible attachment previews", () => {
  test("routes every supported document and media family to its renderer", () => {
    expect(attachmentPreviewKind(asset("brief.docx", "application/octet-stream"))).toBe("docx");
    expect(attachmentPreviewKind(asset("report.pdf", "application/pdf", "pdf"))).toBe("pdf");
    expect(attachmentPreviewKind(asset("model.xlsx", "application/octet-stream"))).toBe("table");
    expect(attachmentPreviewKind(asset("notes.md", "text/plain", "text"))).toBe("markdown");
    expect(attachmentPreviewKind(asset("data.json", "application/json", "text"))).toBe("json");
    expect(attachmentPreviewKind(asset("clip.mp4", "video/mp4", "video"))).toBe("video");
    expect(attachmentPreviewKind(asset("voice.wav", "audio/wav", "audio"))).toBe("audio");
  });

  test("formats compact binary sizes used on file cards", () => {
    expect(formatAttachmentBytes(912)).toBe("912 B");
    expect(formatAttachmentBytes(1_024)).toBe("1 kB");
    expect(formatAttachmentBytes(1_572_864)).toBe("1.5 MB");
  });
});
