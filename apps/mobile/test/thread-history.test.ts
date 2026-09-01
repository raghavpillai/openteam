import { describe, expect, test } from "bun:test";
import { mayHaveEarlierThreadReplies, threadReplyCountLabel } from "@openbot/product-core/messages";

describe("mobile thread pagination semantics", () => {
  test("marks a reply count partial only while contiguous history is newer than its root", () => {
    expect(mayHaveEarlierThreadReplies("128", "280", true)).toBe(true);
    expect(mayHaveEarlierThreadReplies("128", "128", true)).toBe(false);
    expect(mayHaveEarlierThreadReplies("128", "80", true)).toBe(false);
    expect(mayHaveEarlierThreadReplies("128", "280", false)).toBe(false);
  });

  test("stays conservative for a missing or non-numeric pagination cursor", () => {
    expect(mayHaveEarlierThreadReplies("128", null, true)).toBe(true);
    expect(mayHaveEarlierThreadReplies("local-root", "100", true)).toBe(true);
  });

  test("distinguishes loaded reply subsets from complete counts", () => {
    expect(threadReplyCountLabel(138, true)).toBe("138 loaded replies");
    expect(threadReplyCountLabel(250, false)).toBe("250 replies");
    expect(threadReplyCountLabel(1, true)).toBe("1 loaded reply");
  });
});
