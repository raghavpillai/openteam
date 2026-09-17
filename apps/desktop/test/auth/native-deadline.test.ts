import { expect, test } from "bun:test";
import { readNativeAuthWithDeadline } from "../../src/renderer/client/native-auth-deadline";

test("a stuck native read exits checking, and a late read cannot settle the timed-out request", async () => {
  let finish!: (value: string) => void;
  let accepted = false;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const result = readNativeAuthWithDeadline(pending, 5).then(value => { accepted = true; return value; });
  await expect(result).rejects.toThrow("Secure sign-in storage did not respond");
  finish("synthetic late session");
  await Promise.resolve();
  expect(accepted).toBe(false);
  expect(await readNativeAuthWithDeadline(Promise.resolve("retry"), 50)).toBe("retry");
});

test("successful and rejected native reads preserve their result", async () => {
  const value = { token: "synthetic session" };
  expect(await readNativeAuthWithDeadline(Promise.resolve(value), 50)).toBe(value);
  await expect(readNativeAuthWithDeadline(Promise.reject(new Error("fixture error")), 50)).rejects.toThrow("fixture error");
});
