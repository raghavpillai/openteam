import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MacMessages } from "../../src/main/host/messages";
import { NativeActionReceipts } from "../../src/main/host/action-receipts";
import { HostCapabilities } from "../../src/main/host/capabilities";

const payload = (fileName: string, bytes = Buffer.from([0, 255, 1, 128, 13, 10])) => ({ fileName, bytesBase64: bytes.toString("base64") });
const to = "+15555550100";

test("ten mixed formats remain byte-exact after delayed consumption and overlapping sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-chaos-"));
  const captured: { paths: string[]; text: string }[] = [];
  const formats = ["pdf", "png", "jpg", "gif", "txt", "csv", "zip", "wav", "docx", "xlsx"];
  try {
    const host = new MacMessages(async (command, args) => {
      if (command.endsWith("sqlite3")) return "[]";
      captured.push({ paths: args.slice(6), text: args[2]! });
      return "submitted";
    }, undefined, join(root, "outbox"));
    const attachments = formats.map(ext => payload(`résumé 日本語.${ext}`));
    const changed = attachments.map(f => payload(f.fileName, Buffer.from("different bytes")));
    await Promise.all([
      host.execute("SendIMessage", { to, attachments }),
      host.execute("SendIMessage", { to, text: "caption", attachments: changed }),
    ]);
    expect(captured).toHaveLength(2);
    expect(new Set(captured.flatMap(batch => batch.paths)).size).toBe(20);
    // Read only after both native calls returned, from a later event-loop turn.
    await new Promise(resolve => setImmediate(resolve));
    for (let batch = 0; batch < captured.length; batch++) {
      const expected = captured[batch]!.text === "" ? attachments : changed;
      for (let i = 0; i < formats.length; i++) {
        expect(await readFile(captured[batch]!.paths[i]!)).toEqual(Buffer.from(expected[i]!.bytesBase64, "base64"));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation before submission cleans staged files without invoking Messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-chaos-abort-"));
  const controller = new AbortController();
  let sends = 0;
  try {
    const host = new MacMessages(async command => {
      if (command.endsWith("sqlite3")) { controller.abort(); return "[]"; }
      sends++;
      return "submitted";
    }, undefined, join(root, "outbox"));
    await expect(host.execute("SendIMessage", { to, attachments: [payload("file.zip")] }, controller.signal)).rejects.toThrow();
    expect(sends).toBe(0);
    expect(await readdir(join(root, "outbox"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("process death after accepting a file preserves bytes and prevents replay after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-chaos-death-"));
  let staged = "";
  let sends = 0;
  const request = { tool: "SendIMessageWithAttachments", botId: "b", callId: "once", arguments: { to, attachments: [payload("file.wav")] } };
  try {
    const host = new HostCapabilities(new MacMessages(async (command, args) => {
      if (command.endsWith("sqlite3")) return "[]";
      sends++;
      staged = args[6]!;
      throw new Error("simulated process death after submission");
    }, undefined, join(root, "outbox")), undefined, "darwin", new NativeActionReceipts(join(root, "receipts.json")));
    await expect(host.handle(request)).rejects.toThrow("outcome is uncertain");
    const restarted = new HostCapabilities(new MacMessages(async () => { sends++; throw new Error("must not replay"); }, undefined, join(root, "outbox")), undefined, "darwin", new NativeActionReceipts(join(root, "receipts.json")));
    await expect(restarted.handle(request)).rejects.toThrow("outcome is uncertain");
    expect(sends).toBe(1);
    expect(await readFile(staged)).toEqual(Buffer.from(request.arguments.attachments[0]!.bytesBase64, "base64"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging failure and invalid batches never invoke Messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-chaos-reject-"));
  let nativeCalls = 0;
  try {
    const outbox = join(root, "not-a-directory");
    await writeFile(outbox, "occupied");
    const host = new MacMessages(async () => { nativeCalls++; return "[]"; }, undefined, outbox);
    for (const attachments of [
      Array.from({ length: 11 }, () => payload("file.txt")),
      [payload("../escape.txt")],
      [payload("file.zip", Buffer.alloc(25 * 1024 * 1024 + 1))],
    ]) await expect(host.execute("SendIMessage", { to, attachments })).rejects.toThrow();
    expect(nativeCalls).toBe(0);
    await expect(host.execute("SendIMessage", { to, attachments: [payload("file.txt")] })).rejects.toThrow();
    // Only the optional history query ran, never osascript.
    expect(nativeCalls).toBe(1);
    expect(await readFile(outbox, "utf8")).toBe("occupied");
  } finally { await rm(root, { recursive: true, force: true }); }
});
