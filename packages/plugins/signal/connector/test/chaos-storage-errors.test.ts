import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../store";
import { SignalService } from "../service";

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
