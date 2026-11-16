import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MESSAGES_SEND_FILES_TOOL } from "@openteam/contracts/messages-send";
import { NativeActionReceipts } from "../../src/main/host/action-receipts";
import { HostCapabilities } from "../../src/main/host/capabilities";
import { MacMessages } from "../../src/main/host/messages";
import { NativeCommandError, nativeCommand } from "../../src/main/host/native-command";
import { startHostBridge } from "../../src/main/host/bridge";
import { createComputerSettingsStore } from "../../src/main/computer-settings";

const file = (body = "%PDF-1.7\nfixture") => ({
  fileName: 'report " & do shell script ".pdf',
  bytesBase64: Buffer.from(body).toString("base64"),
});

for (const destination of [{ to: "+15555550100" }, { chatId: "any;+;chat123" }]) {
  test(`Messages stages exact bytes and safe argv for ${destination.to ? "a person" : "a group"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "messages-send-test-"));
    const paths: string[] = [];
    const attachments = [file(), file("second PDF with the same filename")];
    const text = 'hello " & do shell script "do-not-run"';
    try {
      const messages = new MacMessages(async (command, args) => {
        if (command.endsWith("sqlite3")) return '[{"guid":"any;+;chat123"}]';
        expect(command).toBe("/usr/bin/osascript");
        expect(args.slice(2, 6)).toEqual([
          text,
          destination.to ?? destination.chatId,
          destination.chatId ? "chat" : "participant",
          "auto",
        ]);
        expect(args[1]).not.toContain(text);
        expect(args[1]).not.toContain(attachments[0]!.fileName);
        expect(args[1]).toContain('if submittedCount > 0 then return "partial"');
        paths.push(...args.slice(6));
        for (const [index, path] of paths.entries()) {
          expect(basename(path)).toBe(attachments[index]!.fileName);
          expect(await readFile(path)).toEqual(
            Buffer.from(attachments[index]!.bytesBase64, "base64")
          );
          expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        if (process.platform === "darwin") {
          // Compile only. This never runs the script or sends a real message.
          await nativeCommand("/usr/bin/osacompile", [
            "-o",
            join(root, "send.scpt"),
            "-e",
            args[1]!,
          ]);
        }
        return "submitted";
      }, undefined, join(root, "outbox"));
      expect(
        await messages.execute("SendIMessage", { ...destination, text, attachments })
      ).toMatchObject({
        kind: "send",
        verified: false,
        attachments: attachments.map((f) => ({
          fileName: f.fileName,
          byteSize: Buffer.byteLength(f.bytesBase64, "base64"),
        })),
      });
      expect(paths).toHaveLength(2);
      // Messages may first read the file after the AppleScript reply, so the staged copy stays.
      for (const [index, path] of paths.entries()) {
        expect(await readFile(path)).toEqual(Buffer.from(attachments[index]!.bytesBase64, "base64"));
        expect(path.startsWith(join(root, "outbox"))).toBe(true);
      }
      expect((await stat(join(root, "outbox"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const payload = (fileName: string, bytes = Buffer.from([0, 255, 1, 128, 13, 10])) => ({ fileName, bytesBase64: bytes.toString("base64") });

// A host whose receipts and outbox live under root; a second one over the same root is an app restart.
const receiptHost = (root: string, run: (args: string[]) => Promise<string>) =>
  new HostCapabilities(
    new MacMessages(async (command, args) => (command.endsWith("sqlite3") ? "[]" : run(args)), undefined, join(root, "outbox")),
    undefined,
    "darwin",
    new NativeActionReceipts(join(root, "receipts.json"))
  );
const sendFiles = { tool: MESSAGES_SEND_FILES_TOOL, botId: "bot", callId: "send-1", arguments: { to: "+15555550100", attachments: [file()] } };

test("attachment-only sends retain durable receipts and detect changed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-receipt-test-"));
  let calls = 0;
  let staged = "";
  const host = receiptHost(root, async (args) => {
    calls++;
    staged = args[6]!;
    expect(args[2]).toBe("");
    expect(await readFile(args[6]!)).toEqual(Buffer.from(file().bytesBase64, "base64"));
    return "submitted";
  });
  try {
    const first = await host.handle(sendFiles);
    expect(await host.handle(sendFiles)).toEqual(first);
    expect(calls).toBe(1);
    const restarted = receiptHost(root, async () => { throw new Error("must not resubmit after restart"); });
    expect(await restarted.handle(sendFiles)).toEqual(first);
    expect(await readFile(staged)).toEqual(Buffer.from(file().bytesBase64, "base64"));
    await expect(host.handle({ ...sendFiles, arguments: { ...sendFiles.arguments, attachments: [file("changed")] } })).rejects.toThrow("different arguments");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// An Automation refusal (-1743) sent nothing, so a retry runs and nothing stays staged. A partial
// send or a process death after submission blocks every retry, even after a restart, and keeps the
// staged bytes because Messages may still read them.
for (const outcome of ["partial", "process failure", "automation_denied"]) {
  test(`an attachment send with ${outcome} preserves the retry rules`, async () => {
    const root = await mkdtemp(join(tmpdir(), "messages-failure-test-"));
    let calls = 0;
    let path = "";
    const host = receiptHost(root, async (args) => {
      calls++;
      path = args[6]!;
      if (outcome === "process failure") throw new Error("interrupted");
      return outcome;
    });
    const message = outcome === "automation_denied" ? "Automation for Messages" : "outcome is uncertain";
    try {
      await expect(host.handle(sendFiles)).rejects.toThrow(message);
      if (outcome === "automation_denied") expect(await stat(path).catch(() => null)).toBeNull();
      else expect(await readFile(path)).toEqual(Buffer.from(file().bytesBase64, "base64"));
      await expect(host.handle(sendFiles)).rejects.toThrow(message);
      expect(calls).toBe(outcome === "automation_denied" ? 2 : 1);
      if (outcome !== "automation_denied") {
        const restarted = receiptHost(root, async () => { calls++; throw new Error("must not replay"); });
        await expect(restarted.handle(sendFiles)).rejects.toThrow(message);
        expect(calls).toBe(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("overlapping sends with the same file names stay byte-exact after Messages returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-overlap-"));
  const captured: { paths: string[]; text: string }[] = [];
  const formats = ["pdf", "png", "jpg", "gif", "txt", "csv", "zip", "wav", "docx", "xlsx"];
  try {
    const host = new MacMessages(async (command, args) => {
      if (command.endsWith("sqlite3")) return "[]";
      captured.push({ paths: args.slice(6), text: args[2]! });
      return "submitted";
    }, undefined, join(root, "outbox"));
    const attachments = formats.map((ext) => payload(`résumé 日本語.${ext}`));
    const changed = attachments.map((f) => payload(f.fileName, Buffer.from("different bytes")));
    await Promise.all([
      host.execute("SendIMessage", { to: "+15555550100", attachments }),
      host.execute("SendIMessage", { to: "+15555550100", text: "caption", attachments: changed }),
    ]);
    expect(new Set(captured.flatMap((batch) => batch.paths)).size).toBe(20);
    // Read on a later event-loop turn, as Messages does.
    await new Promise((resolve) => setImmediate(resolve));
    for (const batch of captured) {
      const expected = batch.text === "" ? attachments : changed;
      for (const [index, path] of batch.paths.entries())
        expect(await readFile(path)).toEqual(Buffer.from(expected[index]!.bytesBase64, "base64"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Messages is never invoked for a cancelled send, an unstageable file, or an invalid batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-reject-"));
  try {
    // Cancelled after staging: the staged files are removed.
    const controller = new AbortController();
    let sends = 0;
    const cancelled = new MacMessages(async (command) => {
      if (command.endsWith("sqlite3")) { controller.abort(); return "[]"; }
      sends++;
      return "submitted";
    }, undefined, join(root, "outbox"));
    await expect(cancelled.execute("SendIMessage", { to: "+15555550100", attachments: [payload("file.zip")] }, controller.signal)).rejects.toThrow();
    expect(sends).toBe(0);
    expect(await readdir(join(root, "outbox"))).toEqual([]);
    // The outbox path is occupied by a file, and the batches are too many, escaping, or too large.
    let nativeCalls = 0;
    const occupied = join(root, "not-a-directory");
    await writeFile(occupied, "occupied");
    const host = new MacMessages(async () => { nativeCalls++; return "[]"; }, undefined, occupied);
    for (const attachments of [
      Array.from({ length: 11 }, () => payload("file.txt")),
      [payload("../escape.txt")],
      [payload("file.zip", Buffer.alloc(25 * 1024 * 1024 + 1))],
    ])
      await expect(host.execute("SendIMessage", { to: "+15555550100", attachments })).rejects.toThrow();
    expect(nativeCalls).toBe(0);
    await expect(host.execute("SendIMessage", { to: "+15555550100", attachments: [payload("file.txt")] })).rejects.toThrow();
    // Only the optional history query ran, never osascript.
    expect(nativeCalls).toBe(1);
    expect(await readFile(occupied, "utf8")).toBe("occupied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the private file verb respects Messages settings and refuses unstaged paths", async () => {
  let executions = 0;
  const messages = {
    execute: async () => {
      executions++;
    },
  } as unknown as MacMessages;
  const host = new HostCapabilities(messages, undefined, "darwin", undefined, {
    enabled: async () => false,
  });
  await expect(
    host.handle({
      tool: MESSAGES_SEND_FILES_TOOL,
      botId: "bot",
      arguments: { to: "+15555550100", attachments: [file()] },
    })
  ).rejects.toThrow("Messages is turned off");
  expect(executions).toBe(0);
  const enabled = new HostCapabilities(messages, undefined, "darwin");
  await expect(
    enabled.handle({
      tool: "SendIMessage",
      botId: "bot",
      arguments: { to: "+15555550100", text: "x", attachmentPaths: ["/workspace/report.pdf"] },
    })
  ).rejects.toThrow("copied from the box");
  expect(executions).toBe(0);
});

test("the authenticated HTTP bridge carries a full-size attachment while other routes keep their small request cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-http-test-"));
  const bytes = Buffer.alloc(25 * 1024 * 1024, 65);
  let sends = 0;
  const capabilities = new HostCapabilities(
    new MacMessages(async (command, args) => {
      if (command.endsWith("sqlite3")) return "[]";
      sends++;
      expect(await readFile(args[6]!)).toEqual(bytes);
      return "submitted";
    }, undefined, join(root, "outbox")),
    undefined,
    "darwin",
    new NativeActionReceipts(join(root, "receipts.json"))
  );
  const server = await startHostBridge({
    token: "test-token",
    port: 0,
    terminalDir: root,
    computerSettings: createComputerSettingsStore(join(root, "settings.json")),
    runJob: async () => {
      throw new Error("No shell job should run");
    },
    capabilities,
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const post = (path: string, value: unknown) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const response = await post("/v1/capabilities", {
      tool: MESSAGES_SEND_FILES_TOOL,
      botId: "bot",
      callId: "full-size",
      arguments: {
        to: "+15555550100",
        attachments: [{ fileName: "large.pdf", bytesBase64: bytes.toString("base64") }],
      },
    });
    expect(await response.json()).toMatchObject({
      kind: "send",
      attachments: [{ fileName: "large.pdf", byteSize: bytes.length }],
    });
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    const oversized = await post("/v1/shell", { command: "x".repeat(129 * 1024) });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ error: "Request body is too large" });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("native command failures stay generic: stderr is never read, so nothing in it can leak", async () => {
  const error = (await nativeCommand("/bin/sh", ["-c", "echo secret-detail >&2; exit 3"]).catch((cause) => cause)) as NativeCommandError;
  expect(error).toBeInstanceOf(NativeCommandError);
  expect(error.reason).toBe("failed");
  expect(error.message).not.toContain("secret-detail");
});
