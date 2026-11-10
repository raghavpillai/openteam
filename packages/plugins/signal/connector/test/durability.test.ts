import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../store";
import { configuredService, accountDirectory } from "../service";

test("committed disk history survives SIGKILL and WAL recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-crash-"));
  const path = join(root, "messages.sqlite");
  const writer = Bun.spawn(
    [process.execPath, new URL("./crash-writer.ts", import.meta.url).pathname, path],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  try {
    const ready = await writer.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toBe("committed\n");
    writer.kill("SIGKILL");
    await writer.exited;
    const recovered = new MessageStore(path);
    try {
      recovered.bind({ aci: "crash-test" });
      expect(
        recovered.db.query<{ count: number }, []>("SELECT count(*) AS count FROM messages").get()!
          .count
      ).toBe(1000);
      expect(recovered.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      for (let i = 0; i < 1000; i++)
        recovered.capture({
          account: "crash-test",
          envelope: {
            sourceUuid: "sender",
            dataMessage: { timestamp: 1000 + i, message: `durable ${i}` },
          },
        });
      expect(
        recovered.db.query<{ count: number }, []>("SELECT count(*) AS count FROM messages").get()!
          .count
      ).toBe(1000);
    } finally {
      recovered.close();
    }
  } finally {
    writer.kill();
    await writer.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

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
