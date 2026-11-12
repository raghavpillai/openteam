import { afterEach, expect, test } from "bun:test";
import { SignalService, accountDirectory } from "../service";
import { MessageStore } from "../store";

const self = { aci: "11111111-1111-4111-8111-111111111111", number: "+12025550100" };
const fixture = new URL("./fixture.ts", import.meta.url).pathname;
const services: SignalService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

class FakeRpc {
  connected = true;
  resolveExit!: () => void;
  exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  calls: Array<{ method: string; params: any }> = [];
  sendError = false;
  rejectSetup = false;
  accounts: any[] = [self];
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (this.rejectSetup) throw new Error("synthetic connection failure");
    if (method === "version") return { version: "0.14.10" };
    if (method === "listAccounts") return this.accounts;
    if (method === "startLink") {
      await Bun.sleep(10);
      return { deviceLinkUri: "sgnl://linkdevice?uuid=synthetic&pub_key=synthetic" };
    }
    if (method === "finishLink") {
      this.accounts = [self];
      await Bun.sleep(10);
      return self;
    }
    if (method === "send") {
      await Bun.sleep(10);
      if (this.sendError) throw new Error("synthetic timeout after transmission");
      return { timestamp: 1000 };
    }
    return params;
  }
  async close() {
    this.connected = false;
    this.resolveExit();
  }
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
  const results = await Promise.all(
    Array.from({ length: 20 }, () => service.send("request-123", { noteToSelf: true }, "hello"))
  );
  expect(peer.calls.filter((call) => call.method === "send")).toHaveLength(1);
  expect(results.filter((value) => value.state === "sent")).toHaveLength(1);
  expect(await service.send("request-123", { noteToSelf: true }, "hello")).toMatchObject({
    existing: true,
    state: "sent",
  });
  await expect(service.send("request-123", { noteToSelf: true }, "different")).rejects.toThrow(
    "different message content"
  );
});

test("ambiguous send failures remain unknown and never automatically resend", async () => {
  const { peer, service } = fake();
  peer.sendError = true;
  await expect(service.send("request-123", { noteToSelf: true }, "hello")).rejects.toThrow(
    "timeout"
  );
  expect(await service.send("request-123", { noteToSelf: true }, "hello")).toMatchObject({
    existing: true,
    state: "unknown",
  });
  expect(peer.calls.filter((call) => call.method === "send")).toHaveLength(1);
});

test("identity rejection after linking closes the peer and prevents routing to the rejected account", async () => {
  const store = new MessageStore(":memory:");
  store.bind({ aci: "previous-account" });
  store.capture({
    account: "previous-account",
    envelope: {
      sourceUuid: "sender",
      dataMessage: { timestamp: 1000, message: "previous history" },
    },
  });
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
  await expect(service.send("rejected-send", { noteToSelf: true }, "synthetic")).rejects.toThrow(
    "different Signal account"
  );
  expect(attempts.flatMap((attempt) => attempt.calls).some((call) => call.method === "send")).toBe(
    false
  );
  expect(store.list().messages[0]!.body).toBe("previous history");
});
