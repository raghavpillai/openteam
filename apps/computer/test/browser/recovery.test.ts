import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxStoreSync } from "../../src/box-store-sync";

describe("browser authority recovery set", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("backs up encrypted live state, native profile state, and client certificates", async () => {
    root = await mkdtemp(join(tmpdir(), "openteam-browser-recovery-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const storeRoot = join(root, "box-store");
    const sandRoot = join(home, "sand-data");
    await Promise.all([
      mkdir(join(home, ".openteam", "browser-profile-authority", "current"), {
        recursive: true,
      }),
      mkdir(join(home, ".pki", "nssdb"), { recursive: true }),
      mkdir(join(home, ".pi", "agent"), { recursive: true }),
      mkdir(sandRoot, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(home, ".openteam", "browser-authority.key"), "encrypted-key"),
      writeFile(join(home, ".openteam", "browser-authority.json.enc"), "encrypted-state"),
      writeFile(
        join(home, ".openteam", "browser-profile-authority", "current", "manifest.json"),
        "{}"
      ),
      writeFile(join(home, ".pki", "nssdb", "cert9.db"), "certificate-db"),
    ]);

    const sync = new BoxStoreSync({ home, workspaceRoot: workspace, sandRoot, storeRoot });
    const manifest = await sync.snapshotOut();
    const paths = new Set(manifest.files.map((file) => file.path));

    expect(paths.has("home/box/.openteam/browser-authority.key")).toBeTrue();
    expect(paths.has("home/box/.openteam/browser-authority.json.enc")).toBeTrue();
    expect(
      paths.has("home/box/.openteam/browser-profile-authority/current/manifest.json")
    ).toBeTrue();
    expect(paths.has("home/box/.pki/nssdb/cert9.db")).toBeTrue();
  });
});
