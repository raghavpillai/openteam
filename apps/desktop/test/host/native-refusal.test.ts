import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeActionReceipts } from "../../src/main/host/action-receipts";
import { NativeCommandError, nativeCommand } from "../../src/main/host/native-command";

test("an Automation refusal leaves the send free to run once allowed; other failures stay uncertain", async () => {
  // Errors stay generic: stderr is never read, so nothing in it can leak.
  const other = await nativeCommand("/bin/sh", ["-c", "echo secret-detail >&2; exit 3"]).catch((cause) => cause as NativeCommandError);
  expect(other).toBeInstanceOf(NativeCommandError);
  expect(other.reason).toBe("failed");
  expect(other.message).not.toContain("secret-detail");
  const error = new NativeCommandError("macOS refused to let OpenTeam control Messages (Automation)", "automation_denied");

  const root = await mkdtemp(join(tmpdir(), "openteam-receipts-"));
  try {
    const receipts = new NativeActionReceipts(join(root, "receipts.json"));
    let runs = 0;
    await expect(receipts.execute("bot", "call-1", { text: "hi" }, async () => { runs++; throw error; })).rejects.toBe(error);
    // Nothing was sent, so the same call runs again; an unknown failure would block it.
    await expect(receipts.execute("bot", "call-1", { text: "hi" }, async () => { runs++; return { sent: true }; })).resolves.toEqual({ sent: true });
    await expect(receipts.execute("bot", "call-2", { text: "hi" }, async () => { throw other; })).rejects.toBe(other);
    await expect(receipts.execute("bot", "call-2", { text: "hi" }, async () => ({ sent: true }))).rejects.toThrow("outcome is uncertain");
    expect(runs).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a send that macOS refuses with -1743 reports an Automation denial, not a generic failure", async () => {
  const { MacMessages } = await import("../../src/main/host/messages");
  const messages = new MacMessages(async (file) => (file.endsWith("sqlite3") ? "[]" : "automation_denied\n"));
  const error = await messages.execute("SendIMessage", { text: "hi", to: "+15555550100" }).catch((cause) => cause);
  expect(error).toBeInstanceOf(NativeCommandError);
  expect((error as NativeCommandError).reason).toBe("automation_denied");
});
