import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearStoppedBrowserCaches } from "../src/browser/cache-maintenance";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const exited = { exitCode: 0, signalCode: null } as const;
const preserved = [
  "Local State",
  "Default/Cookies",
  "Default/Network/Cookies",
  "Default/Network/Cookies-journal",
  "Default/Login Data",
  "Default/Login Data For Account",
  "Default/Web Data",
  "Default/Preferences",
  "Default/Secure Preferences",
  "Default/Session Storage/000001.log",
  "Default/Local Storage/leveldb/000001.log",
  "Default/IndexedDB/https_example.indexeddb.leveldb/000001.log",
  "Default/Service Worker/CacheStorage/cache/data",
  "Default/Service Worker/Database/000001.log",
  "Default/Extensions/extension/script.js",
  "Default/Local Extension Settings/extension/state",
  "Default/Sessions/Session_1",
  "Default/Sessions/Tabs_1",
  "Default/Current Session",
  "Default/Current Tabs",
  "Default/History",
  "downloads/report.pdf",
  "custom-profile/Cache/keep",
  "Profile 1/Network/Cookies",
  "Profile 1/Sessions/Tabs_1",
];
const caches = [
  "Default/Cache/data",
  "Default/Code Cache/js/data",
  "Default/GPUCache/data",
  "Profile 1/Cache/data",
  "GPUCache/data",
];
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openteam-browser-cache-")));
  directories.push(root);
  const profile = join(root, "profile");
  mkdirSync(profile);
  for (const [i, name] of [...preserved, ...caches].entries()) {
    const path = join(profile, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([0, 255, i, 42, 13, 10]));
  }
  return { root, profile };
};

test("removes only identified caches after clean exit and preserves exact auth/session/site-data bytes", () => {
  const { profile } = fixture();
  const bytes = preserved.map((name) => readFileSync(join(profile, name)));
  expect(clearStoppedBrowserCaches(profile, exited)).toHaveLength(5);
  for (const name of caches) expect(existsSync(join(profile, name))).toBe(false);
  for (const [i, name] of preserved.entries())
    expect(readFileSync(join(profile, name))).toEqual(bytes[i]!);
  for (const name of ["", "Default", "Profile 1"])
    expect(existsSync(join(profile, name))).toBe(true);
});

test("live, unknown, forced, and unsuccessful browser exits leave caches and cookies untouched", () => {
  const { profile } = fixture();
  for (const browser of [
    undefined,
    { exitCode: null, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" as const },
    { exitCode: 1, signalCode: null },
  ]) {
    expect(clearStoppedBrowserCaches(profile, browser)).toEqual([]);
    for (const name of [...preserved, ...caches])
      expect(existsSync(join(profile, name))).toBe(true);
  }
});

test("remaining singleton markers including dangling links skip all cleanup", () => {
  const { profile } = fixture();
  symlinkSync("missing-host-123", join(profile, "SingletonLock"));
  expect(clearStoppedBrowserCaches(profile, exited)).toEqual([]);
  for (const name of caches) expect(existsSync(join(profile, name))).toBe(true);
});

test("skips symlinked profile roots, parents, cache directories, and nested cache links", () => {
  for (const mode of ["root", "parent", "default", "cache", "nested"]) {
    const { root, profile } = fixture();
    const outside = join(root, "auth");
    mkdirSync(outside);
    writeFileSync(join(outside, "Cookies"), "precious session bytes");
    let target = profile;
    if (mode === "root") {
      target = join(root, "alias");
      symlinkSync(profile, target);
    }
    if (mode === "parent") {
      symlinkSync(root, join(root, "alias"));
      target = join(root, "alias", "profile");
    }
    if (mode === "default") {
      rmSync(join(profile, "Default"), { recursive: true });
      symlinkSync(outside, join(profile, "Default"));
    }
    if (mode === "cache") {
      rmSync(join(profile, "Default/Cache"), { recursive: true });
      symlinkSync(outside, join(profile, "Default/Cache"));
    }
    if (mode === "nested") symlinkSync(outside, join(profile, "Default/Cache/site-data"));
    clearStoppedBrowserCaches(target, exited);
    expect(readFileSync(join(outside, "Cookies"), "utf8")).toBe("precious session bytes");
    if (mode === "nested") expect(existsSync(join(profile, "Default/Cache/data"))).toBe(true);
    if (mode === "root" || mode === "parent")
      for (const name of caches) expect(existsSync(join(profile, name))).toBe(true);
  }
});
