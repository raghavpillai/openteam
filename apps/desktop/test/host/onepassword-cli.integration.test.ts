import { test, expect } from "bun:test";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedOnePasswordCli, MANAGED_ONEPASSWORD_CLI_VERSION, privateCliCommand } from "../../src/main/host/onepassword-cli";

test.skipIf(process.env.OPENTEAM_MANAGED_CLI_TEST !== "1" || process.platform !== "darwin")(
  "real vendor download, signed native launcher, cached reuse and credential-command rejection",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "managed-cli-live-")));
    const launcher = await realpath(join(import.meta.dirname, "../..", "dist-electron/openteam-op-launcher"));
    try {
      const cli = new ManagedOnePasswordCli({ dataDir: root, launcherPath: launcher, systemPaths: [] });
      const path = await cli.resolve();
      expect((await privateCliCommand(launcher, [root, path, "--version"])).trim()).toBe(MANAGED_ONEPASSWORD_CLI_VERSION);
      expect(await cli.resolve()).toBe(path);
      await expect(privateCliCommand(launcher, [root, path, "item", "get", "never-read"])).rejects.toThrow();
      await expect(privateCliCommand(launcher, [root, "/usr/bin/true", "--version"])).rejects.toThrow();
      // Damage a signed cached executable: it must be replaced, never executed.
      const executable = await readFile(path); executable[0] = executable[0]! ^ 0xff;
      await writeFile(path, executable);
      expect(await cli.resolve()).toBe(path);
      expect((await privateCliCommand(launcher, [root, path, "--version"])).trim()).toBe(MANAGED_ONEPASSWORD_CLI_VERSION);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000
);
