import { expect, test } from "bun:test";
import { countdownKey, waitForAutomaticSetup } from "../src/setup-countdown";

test("Enter starts now; Esc, q, Ctrl-C, and Ctrl-D cancel; other input is ignored", () => {
  for (const chunk of ["\r", "\n", "\r\n", "\r\r"]) expect(countdownKey(chunk)).toBe("start");
  for (const chunk of ["\x1b", "\x1b\x1b", "q", "Q", "\x03", "\x04", "x\x03"])
    expect(countdownKey(chunk)).toBe("cancel");
  for (const chunk of ["x", " ", "\x1b[A", "\x1bOB", "multi\nline", "qq"])
    expect(countdownKey(chunk)).toBeNull();
});

test("redirected input never silently approves automatic setup", async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    expect(await waitForAutomaticSetup()).toBe(false);
});
