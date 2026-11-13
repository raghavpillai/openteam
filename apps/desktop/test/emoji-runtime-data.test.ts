import { expect, test } from "bun:test";
import source from "emojibase-data/en/compact.json";
import { emojiPickerRuntimeEntries, type EmojiRuntimeSource } from "../scripts/emoji-runtime-data";

const terms = (entry: EmojiRuntimeSource) => {
  const emoticons = Array.isArray(entry.emoticon) ? entry.emoticon : entry.emoticon ? [entry.emoticon] : [];
  return new Set([entry.unicode, entry.label, ...(entry.tags ?? []), ...emoticons].join(" ")
    .trim().toLocaleLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ").split(" "));
};

test("smaller emoji build data preserves every searchable word, label, glyph and category order", () => {
  const runtime = emojiPickerRuntimeEntries(source);
  const original = new Map(source.map(entry => [entry.unicode, entry]));
  expect(runtime.length).toBeGreaterThan(1900);
  for (const entry of runtime) {
    const before = original.get(entry.unicode)!;
    // Query matching and ranking depend only on this word set and glyph/order.
    expect(terms(entry)).toEqual(terms(before));
    expect([entry.label, entry.group, entry.emoticon]).toEqual([before.label, before.group, before.emoticon]);
  }
  expect(runtime.map(entry => entry.unicode)).toEqual(source.filter(entry => entry.group !== undefined && entry.group !== 2)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map(entry => entry.unicode));
  expect(JSON.stringify(runtime).length).toBeLessThan(190_000);
});
