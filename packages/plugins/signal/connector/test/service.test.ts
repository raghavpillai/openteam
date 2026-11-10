import { afterEach, expect, test } from "bun:test";
import { SignalService, accountDirectory } from "../service";
import { MessageStore } from "../store";
import { SignalRpc } from "../rpc";

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

test("simultaneous startup calls share one initialization and receive subscription", async () => {
  const { peer, service } = fake();
  await Promise.all(Array.from({ length: 30 }, () => service.connect()));
  expect(peer.calls.map((call) => call.method)).toEqual([
    "version",
    "listAccounts",
    "subscribeReceive",
  ]);
});

test("account RPC always takes its account from the bound identity", async () => {
  const { peer, service } = fake();
  await service.accountRequest("listContacts", { account: "other-account" });
  expect(peer.calls.at(-1)).toEqual({ method: "listContacts", params: { account: self.number } });
});

test("unlinked state keeps setup available and rejects account operations", async () => {
  const { peer, service } = fake();
  peer.accounts = [];
  expect(await service.status()).toMatchObject({ linked: false });
  await expect(service.accountRequest("listGroups")).rejects.toThrow("Link a Signal account");
  await expect(service.send("request-123", { noteToSelf: true }, "hello")).rejects.toThrow(
    "Link a Signal account"
  );
  await expect(service.finishLink("foreign-session")).rejects.toThrow("expired or belongs");
});

test("multiple local accounts fail closed before subscribing or exposing data", async () => {
  const { peer, service } = fake();
  peer.accounts = [self, { aci: "other" }];
  await expect(service.connect()).rejects.toThrow("at most one account");
  expect(peer.calls.some((call) => call.method === "subscribeReceive")).toBe(false);
});

test("numberless account requests use ACI", async () => {
  const { peer, service } = fake();
  peer.accounts = [{ aci: self.aci, number: null }];
  await service.accountRequest("listGroups");
  expect(peer.calls.at(-1)!.params.account).toBe(self.aci);
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

test("saved send outcomes remain inspectable while the runtime is unavailable", async () => {
  const { peer, service } = fake();
  peer.sendError = true;
  await service.send("request-123", { noteToSelf: true }, "hello").catch(() => {});
  peer.connected = false;
  peer.rejectSetup = true;
  expect(await service.send("request-123", { noteToSelf: true }, "hello")).toMatchObject({
    existing: true,
    state: "unknown",
  });
  expect(peer.calls.filter((call) => call.method === "send")).toHaveLength(1);
});

test.each([
  [{}, "hello"],
  [{ recipient: "alice", groupId: "group" }, "hello"],
  [{ noteToSelf: true }, ""],
  [{ recipient: " " }, "hello"],
  [{ noteToSelf: true }, "x".repeat(16001)],
])("invalid sends fail before contacting Signal %#", async (destination, message) => {
  const { peer, service } = fake();
  await expect(
    service.send("request-123", destination as any, message as string)
  ).rejects.toThrow();
  expect(peer.calls).toHaveLength(0);
});

test("link approval uses the exact server-issued URI and subscribes only after binding storage", async () => {
  const { peer, service } = fake();
  peer.accounts = [];
  const session = await service.startLink();
  await Promise.all([service.finishLink(session.sessionId), service.finishLink(session.sessionId)]);
  expect(peer.calls.filter((call) => call.method === "finishLink")).toHaveLength(1);
  expect(peer.calls.find((call) => call.method === "finishLink")!.params.deviceLinkUri).toBe(
    session.deviceLinkUri
  );
  expect(peer.calls.find((call) => call.method === "finishLink")!.params.deviceName).toBe("OpenTeam Signal");
  expect(await service.status()).toMatchObject({ linked: true });
  await expect(service.startLink()).rejects.toThrow("already linked");
});

test("concurrent linking requests share one provisioning session", async () => {
  const { peer, service } = fake();
  peer.accounts = [];
  const [first, second] = await Promise.all([service.startLink(), service.startLink()]);
  expect(first.sessionId).toBe(second.sessionId);
  expect(peer.calls.filter((call) => call.method === "startLink")).toHaveLength(1);
});

test("subprocess crashes trigger automatic reinitialization and deduplicated collection", async () => {
  let launches = 0;
  let current!: SignalRpc;
  const service = new SignalService(
    new MessageStore(":memory:"),
    (receive) => {
      launches++;
      return (current = new SignalRpc([process.execPath, fixture, "linked"], receive));
    },
    20
  );
  services.push(service);
  await service.connect();
  await current.request("crash").catch(() => {});
  for (let i = 0; i < 50 && launches < 2; i++) await Bun.sleep(10);
  await service.connect();
  expect(launches).toBe(2);
  expect(service.store.list().messages).toHaveLength(1);
  expect(await service.status()).toMatchObject({ linked: true, connected: true });
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

test("subscription failure after linking tears down initialization and permits recovery", async () => {
  const first = new FakeRpc();
  first.accounts = [];
  const normal = first.request.bind(first);
  first.request = async (method, params) => {
    if (method === "subscribeReceive") throw new Error("synthetic subscription failure");
    return normal(method, params);
  };
  const recovered = new FakeRpc();
  const service = new SignalService(new MessageStore(":memory:"), () =>
    first.connected ? first : recovered
  );
  services.push(service);
  const link = await service.startLink();
  await expect(service.finishLink(link.sessionId)).rejects.toThrow("subscription failure");
  expect(first.connected).toBe(false);
  expect(await service.status()).toMatchObject({ linked: true, connected: true });
  expect(recovered.calls.some((call) => call.method === "subscribeReceive")).toBe(true);
});

test("automatic reconnect continues after a transient synchronous launch failure", async () => {
  const first = new FakeRpc();
  let launches = 0;
  const service = new SignalService(
    new MessageStore(":memory:"),
    () => {
      launches++;
      if (launches === 1) return first;
      if (launches === 2) throw new Error("synthetic temporary launch failure");
      return new FakeRpc();
    },
    10
  );
  services.push(service);
  await service.connect();
  await first.close();
  for (let i = 0; i < 50 && launches < 3; i++) await Bun.sleep(10);
  expect(launches).toBe(3);
  expect(await service.status()).toMatchObject({ linked: true, connected: true });
});

test("a pending approval prevents provisioning a replacement session after expiry", async () => {
  const { peer, service } = fake();
  peer.accounts = [];
  const normal = peer.request.bind(peer);
  let approve!: () => void;
  const approval = new Promise<void>((resolve) => {
    approve = resolve;
  });
  peer.request = async (method, params) => {
    if (method === "finishLink") await approval;
    return normal(method, params);
  };
  const session = await service.startLink();
  const finish = service.finishLink(session.sessionId);
  await Bun.sleep(0);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61_000;
    await expect(service.startLink()).rejects.toThrow("approval is still pending");
  } finally {
    Date.now = originalNow;
    approve();
  }
  await finish;
  expect(peer.calls.filter((call) => call.method === "startLink")).toHaveLength(1);
  expect(peer.calls.filter((call) => call.method === "finishLink")).toHaveLength(1);
});

test("an attachment deleted while its RPC read is pending stays unavailable", async () => {
  const { peer, service } = fake();
  await service.connect();
  service.store.capture({
    account: self.aci,
    envelope: {
      sourceUuid: "sender",
      dataMessage: { timestamp: 1000, message: "ordinary", attachments: [{ id: "attachment" }] },
    },
  });
  const messageId = service.store.list().messages[0]!.id;
  const normal = peer.request.bind(peer);
  let deliver!: (value: unknown) => void;
  let reading = false;
  peer.request = async (method, params) => {
    if (method === "getAttachment") {
      reading = true;
      return new Promise((resolve) => {
        deliver = resolve;
      });
    }
    return normal(method, params);
  };
  const pending = service.attachment(messageId, "attachment");
  while (!reading) await Bun.sleep(0);
  service.store.capture({
    account: self.aci,
    envelope: {
      sourceUuid: "sender",
      dataMessage: { timestamp: 2000, remoteDelete: { timestamp: 1000 } },
    },
  });
  deliver({ data: "c3ludGhldGlj" });
  await expect(pending).rejects.toThrow("Attachment is unavailable");
});
