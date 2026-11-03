import { expect, test } from "bun:test";
import { parseMemoryLimit } from "../src/desktop-memory";

test("desktop limit uses binary sizes and rejects unlimited, ambiguous and unsafe values", () => {
  expect(parseMemoryLimit("10g")).toBe(10 * 1024 ** 3);
  expect(parseMemoryLimit("256MB")).toBe(256 * 1024 ** 2);
  expect(parseMemoryLimit("10737418240")).toBe(10 * 1024 ** 3);
  for (const value of ["", "0", "-1", "max", "10 GB", "1.5g", "12garbage", "8m", "999999999999999999999g"]) {
    expect(() => parseMemoryLimit(value)).toThrow();
  }
});
