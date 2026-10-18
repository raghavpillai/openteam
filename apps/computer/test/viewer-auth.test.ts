import { describe, expect, test } from "bun:test";
import { createViewerPassword } from "../src/screen-broker";

describe("screen viewer authentication", () => {
  test("generates the full 48 bits supported by classic VNC authentication", () => {
    const passwords = new Set(Array.from({ length: 32 }, createViewerPassword));

    expect(passwords.size).toBe(32);
    for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });
});
