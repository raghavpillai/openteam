import { describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES } from "@openteam/contracts/capabilities";
import {
  attachmentLimitForName,
  attachmentSizeRejection,
} from "@openteam/contracts/media-input";
import {
  selectAttachments,
} from "../src/attachments";

const limits = CLIENT_CAPABILITIES.uploads;
const file = (fileName: string, byteSize = 1) => ({ fileName, byteSize });

describe("GrokBot input policy shared by desktop and iOS", () => {

  test("exact byte boundaries pass; empty and one byte over fail", () => {
    for (const name of ["a.png", "a.txt", "a.mp4", "a.ogv"]) {
      const maximum = attachmentLimitForName(name);
      expect(attachmentSizeRejection(name, maximum)).toBeNull();
      expect(attachmentSizeRejection(name, maximum + 1)).toBe("too-large");
      expect(attachmentSizeRejection(name, 0)).toBe("empty");
    }
    expect(attachmentSizeRejection("unknown-size.txt", undefined)).toBeNull();
  });

  test("uses only the remaining capacity and preserves selection order", () => {
    const max = limits.maxAttachmentsPerMessage;
    const selection = Array.from({ length: max + 1 }, (_, i) => file(`file-${i}.txt`));
    for (const staged of [0, 1, max - 1, max, max + 1]) {
      const result = selectAttachments(selection, staged, limits);
      expect(result.accepted).toEqual(selection.slice(0, Math.max(0, max - staged)));
      expect(result.notice).not.toBeNull();
    }
  });
});
