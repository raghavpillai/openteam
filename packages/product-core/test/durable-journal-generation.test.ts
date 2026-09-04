import { describe, expect, test } from "bun:test";
import { nextDurableSendJournalGeneration } from "../src/durable-delivery";

describe("shared desktop/iOS durable journal generations", () => {
  test("alternates slots independently of elapsed time or clock rollback", () => {
    let generation = nextDurableSendJournalGeneration(undefined, 1_000);
    expect(generation).toBe(1_000);
    for (const now of [2_000, 2_000, 1, 1_000_000, 0]) {
      const next = nextDurableSendJournalGeneration(generation, now);
      expect(next).toBe(generation + 1);
      expect(next % 2).not.toBe(generation % 2);
      generation = next;
    }
  });
  test("refuses generations that would lose integer precision", () => {
    expect(() => nextDurableSendJournalGeneration(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => nextDurableSendJournalGeneration(undefined, Number.NaN)).toThrow();
  });
});
