import { expect, test } from "bun:test";
import {
  ShellOutputCollector,
} from "../src";

test("the collector bounds memory but keeps both ends, totals and stream breaks", () => {
  const collector = new ShellOutputCollector();
  collector.push(Buffer.from("partial"), "stdout");
  collector.push(Buffer.from("err\n"), "stderr");
  collector.push(Buffer.from("next\n"), "stderr");
  expect(collector.excerpt()).toEqual({ output: "partial\nerr\nnext\n", truncated: false });
  expect([collector.bytes, collector.lines]).toEqual([16, 2]);

  const large = new ShellOutputCollector();
  large.push(Buffer.from(`HEAD${"x".repeat(60_000)}`), "stdout");
  for (let index = 0; index < 100; index++) large.push(Buffer.from("y".repeat(1_000)), "stdout");
  large.push(Buffer.from("TAIL\n"), "stdout");
  const excerpt = large.excerpt();
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.output.startsWith(`HEAD${"x".repeat(9_996)}\n\n... (output truncated) ...\n\n`)).toBe(true);
  expect(excerpt.output.endsWith(`${"y".repeat(9_995)}TAIL\n`)).toBe(true);
  expect([large.bytes, large.lines]).toEqual([160_009, 1]);
});
