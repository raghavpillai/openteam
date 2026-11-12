import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredService, accountDirectory } from "../service";

test("configured account state has restrictive directory and database permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-permissions-"));
  const service = configuredService({
    SIGNAL_STATE_ROOT: root,
    SIGNAL_CLI_PATH: "/missing/signal-cli",
    OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic",
  });
  try {
    const directory = accountDirectory("synthetic", root);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "messages.sqlite")).mode & 0o777).toBe(0o600);
    await expect(service.status()).rejects.toThrow("Could not launch signal-cli");
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
