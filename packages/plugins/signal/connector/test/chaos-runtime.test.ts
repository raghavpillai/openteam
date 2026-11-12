import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { discoverPackages } from "../../../scripts/generate";

const fixture = new URL("./chaos-runtime-fixture.ts", import.meta.url).pathname;
const temporary = mkdtempSync(join(tmpdir(), "signal-chaos-runtime-"));
let packagePath: string;
let staging: string | undefined;
let sequence = 0;
const roots: string[] = [];
beforeAll(async () => {
  const source = new URL("../../", import.meta.url).pathname;
  staging = mkdtempSync(join(source, "../.signal-chaos-"));
  cpSync(source, join(staging, "signal"), {
    recursive: true,
    filter: (path) => !path.includes("/connector/test") && !path.endsWith("tsconfig.json"),
  });
  const [definition] = await discoverPackages(staging);
  const imported = importPackageArchive(exportPackageArchive(definition!)).definition;
  packagePath = join(temporary, "package");
  for (const [path, text] of Object.entries(imported.files ?? {})) {
    mkdirSync(dirname(join(packagePath, path)), { recursive: true });
    writeFileSync(join(packagePath, path), text);
  }
  for (const [path, base64] of Object.entries(imported.binaryFiles ?? {})) {
    mkdirSync(dirname(join(packagePath, path)), { recursive: true });
    writeFileSync(join(packagePath, path), Buffer.from(base64, "base64"));
  }
});
afterAll(() => {
  // Reap only fixture PIDs launched by this suite if an assertion interrupted cleanup.
  for (const root of roots)
    for (const event of journal(root))
      if (event.kind === "boot") {
        const command = Bun.spawnSync([
          "ps",
          "-p",
          String(event.pid),
          "-o",
          "command=",
        ]).stdout.toString();
        if (command.includes(fixture) || command.includes(join(root, "synthetic-signal-cli"))) {
          try {
            process.kill(event.pid, "SIGKILL");
          } catch {
            /* already reaped */
          }
        }
      }
  rmSync(temporary, { recursive: true, force: true });
  if (staging) rmSync(staging, { recursive: true, force: true });
});
function peerRoot(label: string, crashes = 0) {
  const root = join(temporary, "peer-" + ++sequence);
  mkdirSync(root);
  roots.push(root);
  writeFileSync(
    join(root, "peer-control.json"),
    JSON.stringify({
      label,
      crashes,
      account: { aci: `synthetic-${label}`, number: null },
    })
  );
  return root;
}
function journal(root: string): any[] {
  try {
    return readFileSync(join(root, "peer-journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
async function until(predicate: () => boolean | Promise<boolean>, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Synthetic fault barrier was not reached");
    await Bun.sleep(5);
  }
}
async function packaged(root: string) {
  const executable = join(root, "synthetic-signal-cli");
  writeFileSync(executable, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, {
    mode: 0o700,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packagePath, "connector/server.mjs")],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      SIGNAL_CLI_PATH: executable,
      OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic-chaos",
      OPENTEAM_PLUGIN_STATE_DIR: root,
    },
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "signal-chaos", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as Array<{ text: string }>)[0]!.text;
    if (response.isError) throw new Error(text);
    return JSON.parse(text);
  };
  await call("signal_status");
  return { client, transport, call };
}

test("chaos: killing whole packaged MCP after provider commit cannot resend an ambiguous message", async () => {
  const root = peerRoot("hostkill");
  const first = await packaged(root);
  const args = { requestId: "chaos-send-hostkill", noteToSelf: true, message: "commit-and-hang" };
  const interrupted = first.call("send_message", args).then(
    () => "unexpected success",
    () => "disconnected"
  );
  try {
    await until(() => journal(root).some((event) => event.kind === "send"));
    process.kill(first.transport.pid!, "SIGKILL");
    expect(await interrupted).toBe("disconnected");
  } finally {
    await first.client.close();
  }
  const second = await packaged(root);
  try {
    expect(await second.call("send_message", args)).toMatchObject({
      existing: true,
      state: "unknown",
    });
    expect(journal(root).filter((event) => event.kind === "send")).toHaveLength(1);
  } finally {
    await second.client.close();
  }
});

test("chaos: two exported accounts isolate history, attachment authority and identical request IDs", async () => {
  const rootA = peerRoot("account-A"),
    rootB = peerRoot("account-B");
  const [a, b] = await Promise.all([packaged(rootA), packaged(rootB)]);
  try {
    const args = { requestId: "same-request-two-accounts", noteToSelf: true, message: "ordinary" };
    expect(
      (await Promise.all([a.call("send_message", args), b.call("send_message", args)])).every(
        (r) => r.state === "sent"
      )
    ).toBe(true);
    const ownA = (await a.call("list_messages")).messages,
      ownB = (await b.call("list_messages")).messages;
    expect(ownA.map((m: any) => m.body)).toEqual(["account-A"]);
    expect(ownB.map((m: any) => m.body)).toEqual(["account-B"]);
    expect(
      await a.call("read_attachment", {
        messageId: ownA[0].id,
        attachmentId: ownA[0].attachments[0].id,
      })
    ).toEqual({ data: Buffer.from("account-A").toString("base64") });
    await expect(
      b.call("read_attachment", { messageId: ownA[0].id, attachmentId: ownA[0].attachments[0].id })
    ).rejects.toThrow("unavailable");
    expect(
      journal(rootA)
        .filter((event) => event.kind === "send")
        .map((event) => event.account)
    ).toEqual(["synthetic-account-A"]);
    expect(
      journal(rootB)
        .filter((event) => event.kind === "send")
        .map((event) => event.account)
    ).toEqual(["synthetic-account-B"]);
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
  }
});
