import { expect, test } from "bun:test";
import { memoryLogicalId, normalizeMemoryContent } from "../src/memory-facts";

test("memory length limits keep complete Unicode characters", () => {
  expect(normalizeMemoryContent("x".repeat(499) + "😀")).toBe("x".repeat(499));
  expect(normalizeMemoryContent("x".repeat(498) + "😀" + "tail")).toBe("x".repeat(498) + "😀");
});

test("normalized memory text survives UTF-8 transport without changing", () => {
  for (const input of ["name " + String.fromCharCode(0xd83d) + " here", String.fromCharCode(0xde00) + " value", "x".repeat(499) + "😀"]) {
    const normalized = normalizeMemoryContent(input);
    expect(Buffer.from(normalized).toString("utf8")).toBe(normalized);
  }
});

test("seeded normalized memories have stable text and ids across repeated normalization", () => {
  const pieces = ["A", "é", "ß", "😀", " ", "\t", "\n", String.fromCharCode(0xd83d), String.fromCharCode(0xde00)];
  let seed = 207;
  for (let sample = 0; sample < 100; sample++) {
    let input = sample === 0 ? "a".repeat(499) + " b" : "";
    for (let i = 0; i < 520; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      input += pieces[seed % pieces.length];
    }
    const normalized = normalizeMemoryContent(input);
    expect(normalized.length).toBeLessThanOrEqual(500);
    expect(normalized).toBe(normalized.trim());
    expect(Buffer.from(normalized).toString("utf8")).toBe(normalized);
    expect(normalizeMemoryContent(normalized)).toBe(normalized);
    expect(memoryLogicalId(normalized)).toBe(memoryLogicalId(input));
  }
});
