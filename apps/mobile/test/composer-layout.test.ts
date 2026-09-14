import { expect, test } from "bun:test";
import { composerInputHeight } from "../src/composer-layout";

test("stale native measurements cannot clip pasted multiline text", () => {
  expect(composerInputHeight("First\n\nLast", 22, 22)).toBe(66);
  expect(composerInputHeight("First\nLast", 0, 30)).toBe(44);
});

test("wrapped text grows to its measured height, caps scrolling, and clears cleanly", () => {
  expect(composerInputHeight("A wrapped paragraph", 90, 30)).toBe(82);
  expect(composerInputHeight("line\n".repeat(12), 400, 30)).toBe(102);
  expect(composerInputHeight("", 400, 30)).toBe(22);
});
