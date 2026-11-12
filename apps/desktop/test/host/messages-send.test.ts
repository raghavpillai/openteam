import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { MESSAGES_SEND_FILES_TOOL } from "@openteam/contracts/messages-send";
import { NativeActionReceipts } from "../../src/main/host/action-receipts";
import { HostCapabilities } from "../../src/main/host/capabilities";
import { MacMessages } from "../../src/main/host/messages";
import { nativeCommand } from "../../src/main/host/native-command";
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
      });
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
      for (const path of paths) expect(await stat(path).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("attachment-only sends retain durable receipts and detect changed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-receipt-test-"));
  let calls = 0;
  const host = new HostCapabilities(
    new MacMessages(async (command, args) => {
      if (command.endsWith("sqlite3")) return "[]";
      calls++;
      expect(args[2]).toBe("");
      expect(await readFile(args[6]!)).toEqual(Buffer.from(file().bytesBase64, "base64"));
      return "submitted";
    }),
    undefined,
    "darwin",
    new NativeActionReceipts(join(root, "receipts.json"))
  );
  const request = {
    tool: MESSAGES_SEND_FILES_TOOL,
    botId: "bot",
    callId: "send-1",
    arguments: { to: "+15555550100", attachments: [file()] },
  };
  try {
    const first = await host.handle(request);
    expect(await host.handle(request)).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      host.handle({
        ...request,
        arguments: { ...request.arguments, attachments: [file("changed")] },
      })
    ).rejects.toThrow("different arguments");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["partial", "process failure", "automation_denied"]) {
  test(`an attachment send with ${outcome} preserves the retry rules`, async () => {
    const root = await mkdtemp(join(tmpdir(), "messages-failure-test-"));
    let calls = 0;
    let path = "";
    const host = new HostCapabilities(
      new MacMessages(async (command, args) => {
        if (command.endsWith("sqlite3")) return "[]";
        calls++;
        path = args[6]!;
        if (outcome === "process failure") throw new Error("interrupted");
        return outcome;
      }),
      undefined,
      "darwin",
      new NativeActionReceipts(join(root, "receipts.json"))
    );
    const request = {
      tool: MESSAGES_SEND_FILES_TOOL,
      botId: "bot",
      callId: "send-1",
      arguments: { to: "+15555550100", attachments: [file()] },
    };
    try {
      await expect(host.handle(request)).rejects.toThrow(
        outcome === "automation_denied" ? "Automation for Messages" : "outcome is uncertain"
      );
      expect(await stat(path).catch(() => null)).toBeNull();
      await expect(host.handle(request)).rejects.toThrow(
        outcome === "automation_denied" ? "Automation for Messages" : "outcome is uncertain"
      );
      expect(calls).toBe(outcome === "automation_denied" ? 2 : 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    }),
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
