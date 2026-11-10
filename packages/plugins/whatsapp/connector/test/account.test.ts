import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WhatsAppAccount } from "../account";
import { prepareStore, settings, type Event, type Running } from "../process";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

export class FakeProcess {
  authenticated = false;
  calls: Array<{ args: string[]; readOnly: boolean }> = [];
  follows: Array<{ args: string[]; emit: (event: Event) => void; finish: (code: number) => void }> = [];
  failWrite = false;
  holdWrite?: Promise<void>;
  execute = async (args: string[], readOnly = false) => {
    this.calls.push({ args, readOnly });
    if (args.join(" ") === "auth status") return { success: true, data: { authenticated: this.authenticated, linked_jid: "123456789@s.whatsapp.net" }, error: null };
    if (args.join(" ") === "auth logout") this.authenticated = false;
    if (args[0] === "send") {
      await this.holdWrite;
      if (this.failWrite) throw new Error("Uncertain send outcome");
    }
    return { success: true, data: { sent: true, messages: [], source: { scope: "local_archive" } }, error: null };
  };
  follow = (args: string[], emit: (event: Event) => void): Running => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => { finish = resolve; });
    this.follows.push({ args, emit, finish });
    return { done, stop: async () => { finish(0); await done; } };
  };
}

async function fixture(authenticated = false, readOnly = false) {
  // Keep the Unix socket path below platform limits, including on macOS.
  const home = await mkdtemp("/tmp/wa-"); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const configuration = settings({ OPENTEAM_PLUGIN_ACCOUNT_ID: "account", WHATSAPP_READ_ONLY: String(readOnly), WHATSAPP_MEDIA_ROOT: home }, home);
  await prepareStore(configuration);
  const process = new FakeProcess(); process.authenticated = authenticated;
  const account = new WhatsAppAccount(process, configuration); cleanup.push(() => account.close());
  return { account, process, configuration };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await f.account.initialize();
  const socket = Bun.listen({ unix: join(f.configuration.store, ".send.sock"), socket: { data() {} } });
  cleanup.push(async () => { socket.stop(true); });
  f.process.follows.at(-1)!.emit({ event: "connected" });
}

test("new accounts expose pairing state without pairing or sending automatically", async () => {
  const f = await fixture(); await f.account.initialize();
  expect(f.process.follows).toHaveLength(0);
  const status = await f.account.status();
  expect(status.authenticated).toBe(false); expect(status.connection_state).toBe("needs_pairing");
  expect(f.process.calls.every((call) => call.readOnly)).toBe(true);
});

test("pairing refreshes transient challenges, then switches bootstrap to send-capable sync", async () => {
  const f = await fixture();
  const pending = f.account.pair(); await Bun.sleep(1);
  const auth = f.process.follows[0]!;
  expect(auth.args[0]).toBe("auth"); expect(auth.args).not.toContain("--follow");
  auth.emit({ event: "qr_code", data: { code: "first-qr" } });
  expect((await pending)?.code).toBe("first-qr");
  expect((await f.account.status()).sync_running).toBe(false);
  auth.emit({ event: "qr_code", data: { code: "fresh-qr" } });
  expect((await f.account.pair())?.code).toBe("fresh-qr"); expect(f.process.follows).toHaveLength(1);
  f.process.authenticated = true; auth.emit({ event: "connected" }); auth.finish(0);
  for (let n = 0; n < 20 && f.process.follows.length < 2; n++) await Bun.sleep(1);
  expect(f.process.follows[1]!.args.slice(0, 2)).toEqual(["sync", "--follow"]);
  expect((await f.account.status()).sync_running).toBe(true);
  expect((await f.account.status()).pairing_available).toBe(false);
});

test("cancel stops unapproved pairing and remote logout never silently relinks", async () => {
  const f = await fixture();
  const pending = f.account.pair("15551234567"); await Bun.sleep(1);
  f.process.follows[0]!.emit({ event: "pair_code", data: { code: "ABCD-1234" } });
  expect((await pending)?.kind).toBe("phone");
  expect(await f.account.cancelPairing()).toEqual({ cancelled: true });
  expect((await f.account.status()).pairing_available).toBe(false);
  f.process.authenticated = true; await f.account.initialize();
  const sync = f.process.follows.at(-1)!; sync.emit({ event: "logged_out" }); sync.finish(0);
  await Bun.sleep(1); await f.account.initialize();
  expect(f.process.follows).toHaveLength(2);
  expect((await f.account.status()).authenticated).toBe(false);
  await expect(f.account.write(["send", "text"])).rejects.toThrow("logged out");
});

test("events from a cancelled attempt cannot corrupt a replacement pairing", async () => {
  const f = await fixture();
  const first = f.account.pair(); await Bun.sleep(1);
  const old = f.process.follows[0]!;
  old.emit({ event: "qr_code", data: { code: "old-challenge" } }); await first;
  await f.account.cancelPairing();
  const second = f.account.pair("15551234567"); await Bun.sleep(1);
  const current = f.process.follows[1]!;
  current.emit({ event: "pair_code", data: { code: "NEW-CODE" } }); await second;
  old.emit({ event: "error", data: { message: "context cancelled" } });
  old.emit({ event: "connected" });
  old.emit({ event: "qr_code", data: { code: "stale-challenge" } });
  const status = await f.account.status();
  expect(status.connection_state).toBe("awaiting_pairing");
  expect(status.last_error).toBeNull();
  expect((await f.account.pair())?.code).toBe("NEW-CODE");
});

test("transport retries invalidate QR snapshots and diagnostics retain no pairing or message secrets", async () => {
  const f = await fixture();
  const pending = f.account.pair(); await Bun.sleep(1);
  const auth = f.process.follows[0]!;
  auth.emit({ event: "qr_code", data: { code: "private-first-challenge" } });
  expect((await pending)?.generation).toBe(1);
  auth.emit({ event: "qr_code", data: { code: "private-refreshed-challenge" } });
  const current = await f.account.pair();
  expect(current?.generation).toBe(2);
  expect(current?.generatedAt).toBeLessThanOrEqual(Date.now());
  for (let i = 0; i < 60; i++) auth.emit({ event: "qr_code", data: { code: "private-later-challenge" } });
  expect((await f.account.status()).diagnostics).toHaveLength(40);
  auth.emit({ event: "warning", data: { code: "auth_connect_retry", message: "private message" } });
  let status = await f.account.status();
  expect(status.pairing_available).toBe(false); expect(status.pairing).toBeNull();
  expect(status.connection_state).toBe("pairing_starting");
  auth.emit({ event: "warning", data: { code: "private-warning-payload" } });
  auth.emit({ event: "error", data: { message: "websocket: failed for private-phone-number" } });
  auth.finish(1); await Bun.sleep(1);
  status = await f.account.status();
  expect(status.last_exit_code).toBe(1);
  expect(status.last_error).toContain("transport");
  expect(status.diagnostics.some((item) => item.code === "auth_connect_retry")).toBe(true);
  expect(JSON.stringify(status)).not.toContain("private-");
  expect((await f.account.status()).diagnostics.length).toBeLessThanOrEqual(40);
});

test("a rotated pairing secret requests a rescan within the same running attempt", async () => {
  const f = await fixture();
  const pending = f.account.pair(); await Bun.sleep(1);
  const auth = f.process.follows[0]!;
  auth.emit({ event: "qr_code", data: { code: "ref1,noise,identity,private-secret1,1" } });
  expect((await pending)?.rescanRequired).toBe(false);
  auth.emit({ event: "qr_code", data: { code: "ref2,noise,identity,private-secret1,1" } });
  expect((await f.account.pair())?.rescanRequired).toBe(false);
  auth.emit({ event: "qr_code", data: { code: "ref2,noise,identity,private-secret2,1" } });
  expect((await f.account.pair())?.rescanRequired).toBe(true);
  auth.emit({ event: "qr_code", data: { code: "ref3,noise,identity,private-secret2,1" } });
  expect((await f.account.pair())?.rescanRequired).toBe(true);
  const status = await f.account.status();
  expect(status.pairing_running).toBe(true);
  expect(status.sync_running).toBe(false);
  expect(status.pairing?.requires_rescan).toBe(true);
  expect(status.diagnostics.filter((item) => item.event === "qr_secret_rotated")).toHaveLength(1);
  expect(JSON.stringify(status)).not.toContain("private-secret");
  expect(f.process.follows).toHaveLength(1);
  await f.account.cancelPairing();
  expect((await f.account.status()).pairing_running).toBe(false);
  const replacement = f.account.pair(); await Bun.sleep(1);
  f.process.follows[1]!.emit({ event: "qr_code", data: { code: "ref4,noise,identity,private-secret3,1" } });
  expect((await replacement)?.rescanRequired).toBe(false);
});

test("write failures never retry; reads proceed during a serialized send", async () => {
  const f = await fixture(true); await ready(f);
  let release!: () => void;
  f.process.holdWrite = new Promise<void>((resolve) => { release = resolve; });
  const first = f.account.write(["send", "text"]); await Bun.sleep(1);
  await f.account.read(["messages", "list"]);
  expect(f.process.calls.at(-1)?.args).toEqual(["messages", "list"]);
  release(); await first;
  f.process.failWrite = true;
  await expect(f.account.write(["send", "text"])).rejects.toThrow("Uncertain");
  expect(f.process.calls.filter((call) => call.args[0] === "send")).toHaveLength(2);
});

test("backfill restores continuous sync even after a failed history request", async () => {
  const f = await fixture(true); await ready(f);
  const original = f.process.execute;
  f.process.execute = async (args, readOnly) => {
    if (args[0] === "history") throw new Error("phone did not answer");
    return original(args, readOnly);
  };
  await expect(f.account.backfill(["history", "backfill"])).rejects.toThrow("phone did not answer");
  expect(f.process.follows).toHaveLength(2);
  expect(f.process.follows.at(-1)!.args.slice(0, 2)).toEqual(["sync", "--follow"]);
});

test("read-only accounts reject writes independently of tool discovery", async () => {
  const f = await fixture(true, true);
  await expect(f.account.write(["send", "text"])).rejects.toThrow("read-only");
  await expect(f.account.logout()).rejects.toThrow("read-only");
  expect(f.process.calls).toHaveLength(0);
});

test("warnings expose machine codes rather than sensitive payloads; close stops future work", async () => {
  const f = await fixture(true); await f.account.initialize();
  const sync = f.process.follows[0]!;
  sync.emit({ event: "warning", data: { code: "storage_limit", message: "private message text" } });
  const status = await f.account.status(); expect(status.last_warning).toBe("storage_limit");
  expect(JSON.stringify(status)).not.toContain("private message text");
  await f.account.close();
  await expect(f.account.restart()).rejects.toThrow("shutting down");
});

test("pairing exposes actionable passkey errors without private upstream data", async () => {
  const f = await fixture(); const pending = f.account.pair(); await Bun.sleep(1);
  const auth = f.process.follows[0]!;
  auth.emit({ event: "error", data: { message: "passkey verification required for private-phone-number" } }); auth.finish(1);
  await expect(pending).rejects.toThrow("passkey");
  const status = await f.account.status(); expect(status.last_error).not.toContain("private-phone-number");
});

test("unlinking an already revoked account does not attempt a remote logout", async () => {
  const f = await fixture();
  const result = await f.account.logout(); expect(result.data.already_unlinked).toBe(true);
  expect(f.process.calls.some((call) => call.args.join(" ") === "auth logout")).toBe(false);
});
