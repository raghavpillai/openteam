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

const fixture = (available = true, timeoutMs = 1000) => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-auth-token-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "auth-session.bin");
  const encryption: AuthTokenEncryption = {
    backend: () => (available ? "test-keychain" : "unavailable"),
    isAvailable: async () => available,
    encrypt: async (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: async (value) => {
      const encoded = value.toString();
      if (!encoded.startsWith("encrypted:")) throw new Error("corrupt");
      return { result: Buffer.from(encoded.slice("encrypted:".length), "base64").toString() };
    },
  };
  return { path, encryption, store: new DesktopAuthTokenStore(path, encryption, timeoutMs) };
};

describe("desktop OS-backed authentication storage", () => {
  test("does not probe the OS keychain when a profile has no saved session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openteam-auth-token-empty-"));
    temporaryDirectories.push(directory);
    let availabilityChecks = 0;
    const store = new DesktopAuthTokenStore(join(directory, "auth-session.bin"), {
      backend: () => "test-keychain",
      isAvailable: async () => {
        availabilityChecks += 1;
        throw new Error("The empty-profile read must not touch the keychain");
      },
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => ({ result: value.toString() }),
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

  test("an explicit temporary session never accesses Keychain or stores its token", async () => {
    const { path, encryption, store } = fixture();
    encryption.isAvailable = async () => { throw new Error("Keychain must not be called"); };
    encryption.encrypt = async () => { throw new Error("Keychain must not be called"); };
    encryption.decrypt = async () => { throw new Error("Keychain must not be called"); };
    encryption.backend = () => { throw new Error("Keychain must not be called"); };
    expect(await store.writeSession("temporary-token")).toEqual({
      token: "temporary-token", persistence: "memory", backend: "session",
    });
    expect((await store.read()).token).toBe("temporary-token");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.session-only`, "utf8")).toBe("");
    expect(statSync(`${path}.session-only`).mode & 0o777).toBe(0o600);
    expect((await new DesktopAuthTokenStore(path, encryption).read()).token).toBeNull();
    await store.clear();
    expect((await store.read()).token).toBeNull();
  });

  test("temporary login and sign-out preserve saved bytes without restoring them after restart", async () => {
    const { path, encryption, store } = fixture();
    writeFileSync(path, "encrypted:previous-session", { mode: 0o600 });
    encryption.isAvailable = async () => { throw new Error("No access to saved credentials"); };
    await store.writeSession("new-temporary-token");
    expect(readFileSync(path, "utf8")).toBe("encrypted:previous-session");
    await store.clear();
    expect(readFileSync(path, "utf8")).toBe("encrypted:previous-session");
    expect((await store.read()).token).toBeNull();
    expect((await new DesktopAuthTokenStore(path, encryption).read()).token).toBeNull();
  });

  test("choosing remember again uses encryption and restores the new session", async () => {
    const { path, encryption, store } = fixture();
    await store.writeSession("temporary-token");
    expect((await store.write("remembered-token")).persistence).toBe("encrypted");
    expect(existsSync(`${path}.session-only`)).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("remembered-token");
    expect((await new DesktopAuthTokenStore(path, encryption).read()).token).toBe("remembered-token");
  });

  test("a pending saved-session read cannot replace an explicitly requested temporary session", async () => {
    const { path, encryption, store } = fixture();
    writeFileSync(path, "old-encrypted-session");
    let finish!: (value: { result: string }) => void;
    let started!: () => void;
    const decryptStarted = new Promise<void>(resolve => { started = resolve; });
    encryption.decrypt = () => new Promise(resolve => { finish = resolve; started(); });
    const read = store.read();
    await decryptStarted;
    const temporary = store.writeSession("fresh-login-token");
    finish({ result: "old-token" });
    await expect(read).rejects.toThrow("cancelled");
    await temporary;
    expect((await store.read()).token).toBe("fresh-login-token");
    expect(readFileSync(path, "utf8")).toBe("old-encrypted-session");
  });

  test("temporary sessions reject empty and oversized tokens", async () => {
    const { path, store } = fixture();
    await expect(store.writeSession(" ")).rejects.toThrow("invalid");
    await expect(store.writeSession("x".repeat(16 * 1024 + 1))).rejects.toThrow("invalid");
    expect(existsSync(`${path}.session-only`)).toBe(false);
  });

  test("sign-out racing a temporary login preserves saved credentials and cannot revive either session", async () => {
    const { path, encryption, store } = fixture();
    writeFileSync(path, "old-encrypted-session");
    const pending = store.writeSession("cancelled-token");
    const cleared = store.clear();
    await expect(pending).rejects.toThrow("cancelled");
    await cleared;
    expect(readFileSync(path, "utf8")).toBe("old-encrypted-session");
    expect((await store.read()).token).toBeNull();
    expect((await new DesktopAuthTokenStore(path, encryption).read()).token).toBeNull();
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

  test("does not destroy saved bytes when native decryption fails", async () => {
    const { path, store } = fixture();
    writeFileSync(path, "not-valid-encrypted-state", { mode: 0o600 });

    await expect(store.read()).rejects.toThrow("Secure sign-in storage could not be accessed");
    expect(readFileSync(path, "utf8")).toBe("not-valid-encrypted-state");
  });

  test("removes both memory and encrypted state on sign-out", async () => {
    const { path, store } = fixture();
    await store.write("session-token");
    await store.clear();

    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBeNull();
  });

  test("a stalled keychain leaves the event loop responsive, times out, and can retry", async () => {
    const { path, encryption, store } = fixture(true, 20);
    const ready = encryption.isAvailable;
    let finish!: (value: boolean) => void;
    encryption.isAvailable = () => new Promise(resolve => { finish = resolve; });
    const write = store.write("expired-token");
    let heartbeat = false;
    setTimeout(() => { heartbeat = true; }, 1);
    await expect(write).rejects.toThrow("Secure sign-in storage did not respond");
    expect(heartbeat).toBe(true);
    finish(true);
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBeNull();
    encryption.isAvailable = ready;
    expect((await store.write("retry-token")).token).toBe("retry-token");
  });

  test("a denied configured keychain cannot silently authorize an in-memory session", async () => {
    const { path, encryption, store } = fixture(false);
    encryption.backend = () => "keychain";
    await expect(store.write("unapproved-token")).rejects.toThrow("Secure sign-in storage is unavailable");
    expect((await store.read()).token).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("a late native encryption completion never persists a timed-out sign-in", async () => {
    const { path, encryption, store } = fixture(true, 20);
    let finish!: (value: Buffer) => void;
    encryption.encrypt = () => new Promise(resolve => { finish = resolve; });
    await expect(store.write("expired-token")).rejects.toThrow("Secure sign-in storage did not respond");
    finish(Buffer.from("encrypted:late"));
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBeNull();
  });

  test("sign-out invalidates a pending encryption before it can restore a session", async () => {
    const { path, encryption, store } = fixture();
    let finish!: (value: Buffer) => void;
    let started!: () => void;
    const encryptStarted = new Promise<void>(resolve => { started = resolve; });
    encryption.encrypt = () => new Promise(resolve => { finish = resolve; started(); });
    const write = store.write("cancelled-token");
    await encryptStarted;
    const cleared = store.clear();
    finish(Buffer.from("encrypted:cancelled"));
    await expect(write).rejects.toThrow("cancelled");
    await cleared;
    expect((await store.read()).token).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("failed replacement preserves the previous encrypted session", async () => {
    const { path, encryption, store } = fixture();
    await store.write("previous-token");
    const previous = readFileSync(path);
    encryption.encrypt = async () => { throw new Error("permission denied"); };
    await expect(store.write("new-token")).rejects.toThrow("could not be accessed");
    expect(readFileSync(path)).toEqual(previous);
    expect((await store.read()).token).toBe("previous-token");
  });

  test("rotated native keys rewrite only encrypted session bytes", async () => {
    const { path, encryption, store } = fixture();
    writeFileSync(path, "old-encrypted-format");
    encryption.decrypt = async () => ({ result: "rotated-token", shouldReEncrypt: true });
    expect((await store.read()).token).toBe("rotated-token");
    expect(readFileSync(path, "utf8")).not.toContain("rotated-token");
    expect(readFileSync(path, "utf8")).toStartWith("encrypted:");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
