import { expect, test } from "bun:test";
import { createBoxClock } from "../src/box-clock";

test("the box clock applies each new zone once, in order, and skips turns without one", async () => {
  const applied: string[] = [];
  const setClock = createBoxClock(async (zone) => {
    await Bun.sleep(5);
    applied.push(zone);
  });
  await Promise.all([setClock("America/New_York"), setClock("America/New_York"), setClock(undefined)]);
  await setClock("Europe/London");
  await setClock("Europe/London");
  expect(applied).toEqual(["America/New_York", "Europe/London"]);
});

test("a failed clock change is logged and retried on the next turn", async () => {
  const lines: string[] = [];
  let fail = true;
  const applied: string[] = [];
  const setClock = createBoxClock(async (zone) => {
    if (fail) throw new Error("read-only file system");
    applied.push(zone);
  }, (line) => lines.push(line));
  await setClock("Asia/Kolkata");
  expect(lines).toEqual(["box-timezone: could not set the box clock to Asia/Kolkata (read-only file system)"]);
  fail = false;
  await setClock("Asia/Kolkata");
  expect(applied).toEqual(["Asia/Kolkata"]);
});
