import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectorHostTools } from "@openteam/plugin-sdk";
import { pluginCatalog } from "../../../src";
// Keep app dependencies outside the portable connector's compile boundary.
const repository = new URL("../../../../../", import.meta.url);
const { StdioMcpManager } = await import(new URL("apps/computer/src/mcp-manager.ts", repository).href);
const { deviceLinkResult, deviceLinkChallenge, publicDeviceLink } = await import(new URL("apps/server/src/services/plugin/device-link.ts", repository).href);
const { PluginTransport } = await import(new URL("apps/server/src/services/plugin/transport.ts", repository).href);

const eventually = async (run: () => Promise<any>, predicate: (value: any) => boolean) => {
  const deadline = Date.now() + 5000;
  let value: any;
  do { value = await run(); if (predicate(value)) return value; await Bun.sleep(20); } while (Date.now() < deadline);
  throw new Error(`Offline lifecycle did not reach expected state: ${JSON.stringify(value)}`);
};

test("installed WhatsApp adapter uses shared QR projection across cancellation, bootstrap, recovery, changed-package update and removal", async () => {
  const root = await mkdtemp("/tmp/wa-host-");
  const manager = new StdioMcpManager(join(root, "cache"), 5000);
  const definition = pluginCatalog.find(p => p.key === "whatsapp")!;
  const connector = definition.connections[0]!;
  const accountId = "synthetic-host-account";
  const state = join(root, "cache", "accounts", createHash("sha256").update(accountId).digest("hex").slice(0, 32));
  const shim = join(root, "native");
  let generation = 0;
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/managed-server.ts")], target: "bun" });
  expect(bundle.success).toBe(true);
  const native = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/managed-native.ts")], target: "bun" });
  expect(native.success).toBe(true);
  await writeFile(shim, `#!${process.execPath}\n${await native.outputs[0]!.text()}`); await chmod(shim, 0o700);
  const input = { ...connector.configuration!, command: process.execPath, args: ["${PLUGIN_ROOT}/connector/server.mjs"],
    persistentState: connector.persistentState, packageFiles: { ...definition.files, "connector/server.mjs": await bundle.outputs[0]!.text() },
    env: { HOME: root, OPENTEAM_PLUGIN_ACCOUNT_ID: accountId, WHATSAPP_TEST_NATIVE_EXECUTABLE: shim, WHATSAPP_READ_ONLY: "true" } };
  const call = async (name: string, args = {}) => deviceLinkResult(await manager.call(accountId, input, name, args, generation));
  const status = () => call("whatsapp_link_status");
  const control = (value: string) => writeFile(join(state, "control"), value);
  try {
    const inventory = await manager.discover(accountId, input, generation);
    const hidden = connectorHostTools(connector);
    expect(hidden).toHaveLength(5);
    for (const name of hidden) expect(inventory.find((t: any) => t.name === name)?._meta?.["openteam/hostOnly"]).toBe(true);
    const transport: any = new PluginTransport({ pluginConnection: { findUnique: async () => ({ connectorKey: connector.key, installation: { manifest: definition } }) } } as any, {} as any, "", async () => Response.json({ tools: inventory }));
    transport.stdioRuntime = async () => ({});
    const visible = await transport.discoverStdio({ id: accountId, configuration: {} });
    for (const name of hidden) expect(visible.map((t: any) => t.name)).not.toContain(name);
    expect(visible.map((t: any) => t.name)).toContain("connection_status");
    expect((await status()).linking).toBe(false);
    expect(await Bun.file(join(state, "native-boots")).exists()).toBe(false);
    const first = await call("whatsapp_start_link");
    await call("whatsapp_finish_link", { sessionId: first.sessionId });
    let projection: any = { ...first, instructions: connector.deviceLink!.instructions };
    expect(publicDeviceLink({ deviceLink: projection }).qrCodeDataUrl).toStartWith("data:image/png;base64,");
    await control("invalidate");
    const invalid = await eventually(status, s => s.challenge?.qrCodeDataUrl === null);
    projection = deviceLinkChallenge(projection, invalid);
    expect(publicDeviceLink({ deviceLink: projection }).qrCodeDataUrl).toBeNull();
    await control("qr:replacement");
    const rotated = await eventually(status, s => s.challenge?.qrCodeDataUrl !== null && s.challenge?.generation > invalid.challenge.generation);
    projection = deviceLinkChallenge(projection, rotated);
    expect(projection.sessionExpiresAt).toBe(first.sessionExpiresAt);
    expect(deviceLinkChallenge(projection, invalid)).toBeUndefined();
    await call("whatsapp_cancel_link", { sessionId: first.sessionId });
    const second = await call("whatsapp_start_link");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await call("whatsapp_cancel_link", { sessionId: first.sessionId })).toEqual({ cancelled: false });
    expect(deviceLinkChallenge({ ...second, instructions: "test" }, rotated)).toBeUndefined();
    // Killing an unapproved MCP clears its in-memory session and never starts
    // native authentication automatically on the next process boot.
    await manager.close(accountId, ++generation);
    const beforeRestart = (await readFile(join(state, "native-boots"), "utf8")).trim().split("\n").length;
    await manager.discover(accountId, input, generation);
    expect(await status()).toEqual({ linked: false, linking: false });
    expect((await readFile(join(state, "native-boots"), "utf8")).trim().split("\n")).toHaveLength(beforeRestart);
    const staleFinish: any = await manager.call(accountId, input, "whatsapp_finish_link", { sessionId: second.sessionId }, generation);
    expect(staleFinish.isError).toBe(true);
    const replacement = await call("whatsapp_start_link");
    expect(replacement.sessionId).not.toBe(second.sessionId);
    await control("bootstrap");
    const bootstrap = await eventually(status, s => s.linking && s.challenge?.qrCodeDataUrl === null);
    expect(bootstrap.linked).toBe(false); expect(bootstrap.sessionId).toBe(replacement.sessionId);
    await control("finish");
    expect((await eventually(status, s => s.linked)).sessionId).toBe(replacement.sessionId);
    await writeFile(join(state, "synthetic-archive"), "retained-history");
    await control("disconnect");
    expect((await eventually(status, s => s.recovering)).linked).toBe(false);
    await control("recover"); await eventually(status, s => s.linked);
    const boots = (await readFile(join(state, "native-boots"), "utf8")).trim().split("\n").length;
    await manager.close(accountId, ++generation);
    input.packageFiles["connector/server.mjs"] += "\n// synthetic released update\n";
    await manager.discover(accountId, input, generation);
    await eventually(status, s => s.linked);
    expect(await readFile(join(state, "synthetic-authenticated"), "utf8")).toBe("synthetic-device-keys");
    expect(await readFile(join(state, "synthetic-archive"), "utf8")).toBe("retained-history");
    expect((await readFile(join(state, "native-boots"), "utf8")).trim().split("\n")).toHaveLength(boots + 1);
    expect((await call("connection_status")).pairing_running).toBe(false);
    await call("whatsapp_remove_account");
    await manager.forget(accountId, ++generation);
    expect(await Bun.file(join(state, "synthetic-authenticated")).exists()).toBe(false);
  } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }); }
}, 30000);
