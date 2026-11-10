import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../store";
import { SignalService, configuredService } from "../service";

// Real SQLite failures in synthetic storage; never fill the host filesystem.
const account = { aci: "storage-fault-self" };
function service(store: MessageStore, onSend = () => {}) {
  let done!: () => void;
  const peer = {
    connected: true,
    exited: new Promise<void>((resolve) => {
      done = resolve;
    }),
    async request(method: string) {
      if (method === "version") return { version: "0.14.10" };
      if (method === "listAccounts") return [account];
      if (method === "send") {
        onSend();
        return { timestamp: 1234 };
      }
      return 0;
    },
    async close() {
      peer.connected = false;
      done();
    },
  };
  return new SignalService(store, () => peer);
}

test("SQLITE_FULL refuses a new send before provider transmission and recovers after space returns", async () => {
  const store = new MessageStore(":memory:");
  store.bind(account);
  const pages = (store.db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  store.db.exec(`PRAGMA max_page_count=${pages}`);
  let full = false;
  for (let i = 0; i < 20_000; i++) {
    try {
      store.beginSend(`fill-${i}`, { synthetic: i });
    } catch (error) {
      expect(String(error)).toContain("full");
      full = true;
      break;
    }
  }
  expect(full).toBe(true);
  let transmissions = 0;
  const connector = service(store, () => {
    transmissions++;
  });
  try {
    await expect(
      connector.send("after-full-123", { noteToSelf: true }, "synthetic")
    ).rejects.toThrow("full");
    expect(transmissions).toBe(0);
    expect(
      store.previousSend("after-full-123", { noteToSelf: true, message: "synthetic" })
    ).toBeUndefined();
    expect(store.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    store.db.exec("PRAGMA max_page_count=1000000");
    expect(await connector.send("after-full-123", { noteToSelf: true }, "synthetic")).toMatchObject(
      { state: "sent" }
    );
    expect(transmissions).toBe(1);
  } finally {
    await connector.close();
  }
});

test("a post-transmission SQLite failure remains unknown across restart and never resends", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-ledger-fault-"));
  const path = join(root, "messages.sqlite");
  const store = new MessageStore(path);
  store.bind(account);
  store.db.exec(
    "CREATE TRIGGER fail_confirmation BEFORE UPDATE ON sends BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END"
  );
  let transmissions = 0;
  const connector = service(store, () => {
    transmissions++;
  });
  let reopened: SignalService | undefined;
  try {
    await expect(
      connector.send("failed-commit-123", { noteToSelf: true }, "synthetic")
    ).rejects.toThrow("synthetic storage fault");
    expect(transmissions).toBe(1);
    await connector.close();
    const recovered = new MessageStore(path);
    reopened = service(recovered, () => {
      transmissions++;
    });
    expect(
      await reopened.send("failed-commit-123", { noteToSelf: true }, "synthetic")
    ).toMatchObject({ existing: true, state: "unknown", result: null });
    expect(transmissions).toBe(1);
    await expect(
      reopened.send("failed-commit-123", { noteToSelf: true }, "changed")
    ).rejects.toThrow("different message content");
    expect(transmissions).toBe(1);
  } finally {
    await connector.close();
    await reopened?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupted account database is rejected without replacing it or starting a runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-corrupt-fault-"));
  const path = join(root, "messages.sqlite");
  const original = Buffer.from("synthetic corrupt database: preserve for diagnosis");
  writeFileSync(path, original);
  try {
    expect(() =>
      configuredService({
        OPENTEAM_PLUGIN_STATE_DIR: root,
        SIGNAL_CLI_PATH: "/missing/synthetic-runtime",
      })
    ).toThrow();
    expect(readFileSync(path)).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
