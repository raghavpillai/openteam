import { describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  attachmentLimitForName,
  attachmentSizeRejection,
  mediaExtension,
} from "@openteam/contracts/media-input";
import {
  attachmentTextPreview,
  selectAttachments,
  ATTACHMENT_CODE_PREVIEW_CHAR_LIMIT,
} from "../src/attachments";

const limits = CLIENT_CAPABILITIES.uploads;
const file = (fileName: string, byteSize = 1) => ({ fileName, byteSize });

describe("GrokBot input policy shared by desktop and iOS", () => {
  test("bounds display previews without altering the document", () => {
    const exact = "x".repeat(1_500_000);
    expect(attachmentTextPreview(exact)).toEqual({ content: exact, truncated: false });
    expect(attachmentTextPreview(`${exact}TAIL`)).toEqual({ content: exact, truncated: true });
    expect(ATTACHMENT_CODE_PREVIEW_CHAR_LIMIT).toBe(200_000);
  });
  test("video allowance uses the native extension map, not a MIME override", () => {
    for (const name of ["a.MOV", "a.m4v", "a.mp4", "a.ogv", "a.webm"])
      expect(attachmentLimitForName(name)).toBe(209_715_200);
    for (const name of ["a.mkv", "a.avi", "a.mpeg", "a.png", ".mp4", "a.mp4.txt"])
      expect(attachmentLimitForName(name)).toBe(26_214_400);
    expect(mediaExtension("C:\\file.mp4\\notes.TXT")).toBe(".txt");
    expect(
      selectAttachments([{ ...file("notes.bin", 26_214_401), mimeType: "video/mp4" }], 0, limits)
        .accepted
    ).toEqual([]);
  });

  test("exact byte boundaries pass; empty and one byte over fail", () => {
    for (const name of ["a.png", "a.txt", "a.mp4", "a.ogv"]) {
      const maximum = attachmentLimitForName(name);
      expect(attachmentSizeRejection(name, maximum)).toBeNull();
      expect(attachmentSizeRejection(name, maximum + 1)).toBe("too-large");
      expect(attachmentSizeRejection(name, 0)).toBe("empty");
    }
    expect(attachmentSizeRejection("unknown-size.txt", undefined)).toBeNull();
  });

  test("retains valid files in mixed selections without backfilling overflow slots", () => {
    const selection = [
      file("empty.txt", 0),
      file("big.png", 26_214_401),
      ...Array.from({ length: 5 }, (_, i) => file(`valid-${i}.txt`)),
    ];
    const result = selectAttachments(selection, 0, limits);
    expect(result.accepted.map((f) => f.fileName)).toEqual([
      "valid-0.txt",
      "valid-1.txt",
      "valid-2.txt",
      "valid-3.txt",
    ]);
    expect(result.notice).toContain('"empty.txt" is empty, so it wasn\'t attached.');
    expect(result.notice).toContain('"big.png" is too large to attach (max 25 MB).');
    expect(selectAttachments([file("big.mp4", 209_715_201)], 0, limits).notice).toBe(
      '"big.mp4" is too large to attach (max 200 MB for video).'
    );
  });

  test("uses only the remaining capacity and preserves selection order", () => {
    const selection = Array.from({ length: 7 }, (_, i) => file(`file-${i}.txt`));
    for (const staged of [0, 1, 5, 6, 7]) {
      const result = selectAttachments(selection, staged, limits);
      expect(result.accepted).toEqual(selection.slice(0, Math.max(0, 6 - staged)));
      expect(result.notice).not.toBeNull();
    }
  });
});
