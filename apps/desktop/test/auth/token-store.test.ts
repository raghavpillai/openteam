import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAuthTokenStore, type AuthTokenEncryption } from "../../src/main/auth-token-store";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = (available = true) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-auth-token-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "auth-session.bin");
  const encryption: AuthTokenEncryption = {
    backend: () => (available ? "test-keychain" : "unavailable"),
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: (value) => {
      const encoded = value.toString();
      if (!encoded.startsWith("encrypted:")) throw new Error("corrupt");
      return Buffer.from(encoded.slice("encrypted:".length), "base64").toString();
    },
  };
  return { path, store: new DesktopAuthTokenStore(path, encryption) };
};

describe("desktop OS-backed authentication storage", () => {
  test("does not probe the OS keychain when a profile has no saved session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-auth-token-empty-"));
    temporaryDirectories.push(directory);
    let availabilityChecks = 0;
    const store = new DesktopAuthTokenStore(join(directory, "auth-session.bin"), {
      backend: () => "test-keychain",
      isAvailable: () => {
        availabilityChecks += 1;
        throw new Error("The empty-profile read must not touch the keychain");
      },
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    });

    expect(await store.read()).toEqual({
      token: null,
      persistence: "encrypted",
      backend: "test-keychain",
    });
    expect(availabilityChecks).toBe(0);
  });

  test("persists only encrypted bytes with private file permissions", async () => {
    const { path, store } = fixture();
    await store.write("session-token-value");

    expect(readFileSync(path, "utf8")).not.toContain("session-token-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await store.read()).token).toBe("session-token-value");
  });

  test("uses memory only and removes stale disk state when encryption is unavailable", async () => {
    const { path, store } = fixture(false);
    writeFileSync(path, "old-plaintext-token");

    const saved = await store.write("memory-session");
    expect(saved).toMatchObject({ token: "memory-session", persistence: "memory" });
    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBe("memory-session");
  });

  test("preserves encrypted disk state while the keychain is temporarily unavailable", async () => {
    const { path, store } = fixture(false);
    writeFileSync(path, "encrypted:recoverable", { mode: 0o600 });

    expect((await store.read()).token).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("encrypted:recoverable");
  });

  test("clears corrupt encrypted state instead of reviving it", async () => {
    const { path, store } = fixture();
    writeFileSync(path, "not-valid-encrypted-state", { mode: 0o600 });

    expect((await store.read()).token).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("removes both memory and encrypted state on sign-out", async () => {
    const { path, store } = fixture();
    await store.write("session-token");
    await store.clear();

    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBeNull();
  });
});
