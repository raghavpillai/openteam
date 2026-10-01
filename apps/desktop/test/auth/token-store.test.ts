import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAuthTokenStore } from "../../src/main/auth-token-store";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "openteam-session-"));
  directories.push(directory);
  const path = join(directory, "profile", "auth-session.json");
  return { directory, path, store: new DesktopAuthTokenStore(path) };
};

describe("desktop file session storage", () => {
  test("fresh profiles and legacy encrypted sessions do not require keychain migration", async () => {
    const { path, store, directory } = fixture();
    writeFileSync(join(directory, "auth-session.bin"), "v10-encrypted-session");
    expect(await store.read()).toEqual({ token: null, persistence: "disk", backend: "file" });
    expect(existsSync(path)).toBe(false);
  });
  test("persists a session across restart with owner-only permissions", async () => {
    const { path, store } = fixture();
    await store.write("session-token");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, token: "session-token" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await new DesktopAuthTokenStore(path).read()).token).toBe("session-token");
    expect(readdirSync(join(path, ".."))).toEqual(["auth-session.json"]);
  });
  test("sign-out removes the persisted session across restart", async () => {
    const { path, store } = fixture();
    await store.write("session-token");
    await store.clear();
    expect(existsSync(path)).toBe(false);
    expect((await new DesktopAuthTokenStore(path).read()).token).toBeNull();
  });
  test("sign-out cancels a queued sign-in", async () => {
    const { path, store } = fixture();
    const write = store.write("cancelled-token");
    const clear = store.clear();
    await expect(write).rejects.toThrow("cancelled");
    await clear;
    expect(existsSync(path)).toBe(false);
    expect((await store.read()).token).toBeNull();
  });
  test("invalid or legacy bytes are never accepted as credentials", async () => {
    const { path } = fixture();
    mkdirSync(join(path, ".."), { recursive: true });
    for (const bytes of ["v10-encrypted", "{", "null", '{"version":2,"token":"x"}', '{"version":1,"token":3}', JSON.stringify({version:1,token:"x".repeat(17000)})]) {
      writeFileSync(path, bytes);
      expect((await new DesktopAuthTokenStore(path).read()).token).toBeNull();
    }
  });
  test("invalid replacements preserve the saved session", async () => {
    const { path, store } = fixture();
    await store.write("previous-token");
    await expect(store.write(" ")).rejects.toThrow("invalid");
    expect((await new DesktopAuthTokenStore(path).read()).token).toBe("previous-token");
  });
  test("filesystem failures reject sign-in and do not cache a session", async () => {
    const { directory } = fixture();
    const parent = join(directory, "not-a-directory");
    writeFileSync(parent, "occupied");
    const store = new DesktopAuthTokenStore(join(parent, "session.json"));
    await expect(store.write("unsaved-token")).rejects.toThrow();
    rmSync(parent);
    expect((await store.read()).token).toBeNull();
  });
});
