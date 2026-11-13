import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryPage } from "../directory";
import { SignalService, accountDirectory, configuredService } from "../service";
import { MessageStore } from "../store";

const self = { aci: "11111111-1111-4111-8111-111111111111", number: "+12025550100" };
const services: SignalService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });

class FakeRpc {
  connected = true;
  resolveExit!: () => void;
  exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  calls: Array<{ method: string; params: any }> = [];
  sendError = false;
  rejectSetup = false;
  accounts: any[] = [self];
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (this.rejectSetup) throw new Error("synthetic connection failure");
    if (method === "version") return { version: "0.14.10" };
    if (method === "listAccounts") return this.accounts;
    if (["startLink", "finishLink", "send"].includes(method)) await Bun.sleep(10);
    if (method === "startLink") return { deviceLinkUri: "sgnl://linkdevice?uuid=synthetic&pub_key=synthetic" };
    if (method === "finishLink") return (this.accounts = [self]), self;
    if (method === "send" && this.sendError) throw new Error("synthetic timeout after transmission");
    if (method === "send") return { timestamp: 1000 };
    return params;
  }
  async close() { this.connected = false; this.resolveExit(); }
}

function fake() {
  const peer = new FakeRpc();
  const service = new SignalService(new MessageStore(":memory:"), () => peer);
  services.push(service);
  return { peer, service };
}

test("OpenTeam account IDs produce distinct fixed-length paths without traversal", () => {
  const a = accountDirectory("../../one", "/tmp/test");
  expect(a).toMatch(/^\/tmp\/test\/[a-f0-9]{64}$/);
  expect(a).not.toBe(accountDirectory("two", "/tmp/test"));
  expect(a).toBe(accountDirectory("../../one", "/tmp/test"));
  expect(() => accountDirectory(" ")).toThrow();
});

test("account RPC always takes its account from the bound identity", async () => {
  const { peer, service } = fake();
  await service.accountRequest("listContacts", { account: "other-account" });
  expect(peer.calls.at(-1)).toEqual({ method: "listContacts", params: { account: self.number } });
});

test("multiple local accounts fail closed before subscribing or exposing data", async () => {
  const { peer, service } = fake();
  peer.accounts = [self, { aci: "other" }];
  await expect(service.connect()).rejects.toThrow("at most one account");
  expect(peer.calls.some((call) => call.method === "subscribeReceive")).toBe(false);
});

test("concurrent duplicate sends transmit once and subsequent retries return saved results", async () => {
  const { peer, service } = fake();
  const results = await Promise.all(Array.from({ length: 20 }, () => service.send("request-123", { noteToSelf: true }, "hello")));
  expect(peer.calls.filter((call) => call.method === "send")).toHaveLength(1);
  expect(results.filter((value) => value.state === "sent")).toHaveLength(1);
  expect(await service.send("request-123", { noteToSelf: true }, "hello")).toMatchObject({ existing: true, state: "sent" });
  await expect(service.send("request-123", { noteToSelf: true }, "different")).rejects.toThrow("different message content");
});

test("ambiguous send failures remain unknown and never automatically resend", async () => {
  const { peer, service } = fake();
  peer.sendError = true;
  await expect(service.send("request-123", { noteToSelf: true }, "hello")).rejects.toThrow("timeout");
  expect(await service.send("request-123", { noteToSelf: true }, "hello")).toMatchObject({ existing: true, state: "unknown" });
  expect(peer.calls.filter((call) => call.method === "send")).toHaveLength(1);
});

test("identity rejection after linking closes the peer and prevents routing to the rejected account", async () => {
  const store = new MessageStore(":memory:");
  store.bind({ aci: "previous-account" });
  store.capture({ account: "previous-account", envelope: { sourceUuid: "sender", dataMessage: { timestamp: 1000, message: "previous history" } } });
  const peer = new FakeRpc();
  peer.accounts = [];
  const attempts: FakeRpc[] = [peer];
  const service = new SignalService(store, () => {
    if (attempts.at(-1)!.connected) return attempts.at(-1)!;
    const next = new FakeRpc();
    attempts.push(next);
    return next;
  });
  services.push(service);
  const link = await service.startLink();
  await expect(service.finishLink(link.sessionId)).rejects.toThrow("different Signal account");
  expect(peer.connected).toBe(false);
  await expect(service.status()).rejects.toThrow("different Signal account");
  await expect(service.send("rejected-send", { noteToSelf: true }, "synthetic")).rejects.toThrow("different Signal account");
  expect(attempts.flatMap((attempt) => attempt.calls).some((call) => call.method === "send")).toBe(false);
  expect(store.list().messages[0]!.body).toBe("previous history");
});

test("a post-transmission SQLite failure remains unknown across restart and never resends", async () => {
  // Real SQLite failures in synthetic storage; never fill the host filesystem.
  const root = mkdtempSync(join(tmpdir(), "signal-ledger-fault-"));
  const path = join(root, "messages.sqlite");
  const store = new MessageStore(path);
  store.bind(self);
  store.db.exec("CREATE TRIGGER fail_confirmation BEFORE UPDATE ON sends BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END");
  const peers = [new FakeRpc(), new FakeRpc()];
  const transmissions = () => peers.flatMap((peer) => peer.calls).filter((call) => call.method === "send").length;
  const first = new SignalService(store, () => peers[0]!);
  const reopened = new SignalService(new MessageStore(path), () => peers[1]!);
  services.push(first, reopened);
  try {
    await expect(first.send("failed-commit-123", { noteToSelf: true }, "synthetic")).rejects.toThrow("synthetic storage fault");
    await first.close();
    expect(await reopened.send("failed-commit-123", { noteToSelf: true }, "synthetic")).toMatchObject({ existing: true, state: "unknown", result: null });
    await expect(reopened.send("failed-commit-123", { noteToSelf: true }, "changed")).rejects.toThrow("different message content");
    expect(transmissions()).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured account state has restrictive directory and database permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "signal-permissions-"));
  const service = configuredService({ SIGNAL_STATE_ROOT: root, SIGNAL_CLI_PATH: "/missing/signal-cli", OPENTEAM_PLUGIN_ACCOUNT_ID: "synthetic" });
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

test("directory pages split by encoded size below the host's string limit and reject invalid or oversized entries", () => {
  const records = Array.from({ length: 120 }, (_, i) => ({ id: String(i).padStart(3, "0"), name: "Group " + i, metadata: '\u0000\\"🐈'.repeat(500) }));
  const collected: unknown[] = [];
  let offset: number | null = 0, pages = 0;
  while (offset !== null) {
    const page = directoryPage("groups", records, { offset, limit: 100 });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(70_000);
    expect((page.groups as unknown[]).length).toBeGreaterThan(0);
    collected.push(...(page.groups as unknown[]));
    offset = page.nextOffset;
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(collected).toEqual(records);
  for (const value of [null, {}, [null], [[]]]) expect(() => directoryPage("groups", value)).toThrow("invalid directory");
  expect(() => directoryPage("contacts", [{ uuid: "one", name: "x".repeat(80_000) }])).toThrow("single directory entry");
});
