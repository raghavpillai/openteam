// Browser network sharing: per-deployment consent and connection recovery.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkInterfaceInfo } from "node:os";
import {
  DesktopBrowserNetwork,
  NetworkConsentStore,
  networkFingerprint,
} from "../src/main/browser-network";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(check: () => boolean, ms = 2500) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw Error("Recovery timed out");
    await Bun.sleep(10);
  }
}
async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-consent-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "consent.json");
  return { path, store: new NetworkConsentStore(path) };
}
async function fixture(identity: (attempt: number) => Response | Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "openteam-network-recovery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("browser-network-identity"))
        return identity(++attempts);
      return new Response(null, { status: 503 });
    },
  });
  cleanup.push(() => server.stop(true));
  const store = new NetworkConsentStore(join(directory, "consent.json"));
  const controller = new DesktopBrowserNetwork("machine", store, "darwin");
  cleanup.push(() => controller.stop());
  const connection = { serverUrl: server.url.origin, credential: "fixture", connectionId: "one" };
  return { controller, connection, store, attempts: () => attempts };
}

test("network permission defaults off, is scoped to deployment and server address, and malformed saves never enable it", async () => {
  const { store, path } = await storeFixture();
  expect(await store.allowed("https://host.test", "deployment-a")).toBe(false);
  await store.set("https://host.test/", "deployment-a", true);
  expect(await store.allowed("https://host.test", "deployment-a")).toBe(true);
  expect(await store.allowed("https://host.test", "deployment-b")).toBe(false);
  expect(await store.allowed("https://other.test", "deployment-a")).toBe(false);
  expect(await store.allowed("https://host.test/other", "deployment-a")).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const data of ["{", "null", "[]", '{"https://host.test#deployment-a":"true"}']) {
    await writeFile(path, data);
    expect(await store.allowed("https://host.test", "deployment-a")).toBe(false);
  }
});
test("serialized grants survive simultaneous edits, reads wait for queued changes, and revoke is durable", async () => {
  const { store, path } = await storeFixture();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.set("https://host.test", `deployment-${i}`, true)));
  const writes = Array.from({ length: 20 }, (_, i) => store.set("https://other.test", `deployment-${i}`, true));
  writes.push(store.set("https://host.test", "deployment-4", false));
  expect(await store.allowed("https://host.test", "deployment-4")).toBe(false);
  await Promise.all(writes);
  const restarted = new NetworkConsentStore(path);
  for (let i = 0; i < 20; i++) expect(await restarted.allowed("https://host.test", `deployment-${i}`)).toBe(i !== 4);
  expect((await readFile(path, "utf8")).includes("Bearer")).toBe(false);
});
test("unsupported platform and disconnected desktop cannot grant permission", async () => {
  const { store } = await storeFixture();
  const controller = new DesktopBrowserNetwork("machine", store, "win32");
  expect(controller.status()).toMatchObject({
    supported: false,
    sharingAllowed: false,
    providing: false,
  });
  await expect(controller.setAllowed(true)).rejects.toThrow("updated");
  controller.stop();
});
test("sign-out closes sharing and deployment identity changes never inherit an old grant", async () => {
  let identity = crypto.randomUUID();
  const { controller, connection, store } = await fixture(() => Response.json({ deploymentId: identity }));
  await controller.configure(connection);
  expect(controller.status().sharingAllowed).toBe(false);
  await controller.setAllowed(true);
  expect(controller.status().sharingAllowed).toBe(true);
  expect(await store.allowed(connection.serverUrl, identity)).toBe(true);
  await controller.configure(null);
  expect(controller.status()).toMatchObject({ connected: false, sharingAllowed: false, providing: false });
  await controller.configure(connection);
  expect(controller.status().sharingAllowed).toBe(true);
  await controller.setAllowed(false);
  expect(await store.allowed(connection.serverUrl, identity)).toBe(false);
  await controller.setAllowed(true);
  identity = crypto.randomUUID();
  await controller.configure(connection);
  expect(controller.status().sharingAllowed).toBe(false);
});

test("chaos: a transient identity outage recovers without re-enrollment or new consent", async () => {
  const deploymentId = crypto.randomUUID();
  const f = await fixture((attempt) =>
    attempt === 1 ? new Response(null, { status: 503 }) : Response.json({ deploymentId })
  );
  await f.store.set(f.connection.serverUrl, deploymentId, true);
  await f.controller.configure(f.connection);
  expect(f.controller.status()).toMatchObject({ connected: false, sharingAllowed: false });
  await until(() => f.controller.status().connected);
  expect(f.attempts()).toBe(2);
  expect(f.controller.status()).toMatchObject({ deploymentId, sharingAllowed: true });
});

test("chaos: reconnect during a queued revoke cannot resurrect sharing", async () => {
  const deploymentId = crypto.randomUUID();
  const f = await fixture(() => Response.json({ deploymentId }));
  await f.store.set(f.connection.serverUrl, deploymentId, true);
  await f.controller.configure(f.connection);
  expect(f.controller.status().sharingAllowed).toBe(true);
  const writes = Array.from({ length: 30 }, (_, i) =>
    f.store.set("https://other.test", `deployment-${i}`, true)
  );
  const revoked = f.controller.setAllowed(false);
  const reconnect = f.controller.configure({ ...f.connection, connectionId: "two" });
  await Promise.all([...writes, revoked, reconnect]);
  expect(f.controller.status()).toMatchObject({
    connected: true,
    sharingAllowed: false,
    providing: false,
  });
  expect(await f.store.allowed(f.connection.serverUrl, deploymentId)).toBe(false);
});

test("chaos: sign-out cancels identity recovery and cannot revive a provider", async () => {
  const f = await fixture(() => new Response(null, { status: 503 }));
  await f.controller.configure(f.connection);
  f.controller.stop();
  const attempts = f.attempts();
  await Bun.sleep(1400);
  expect(f.attempts()).toBe(attempts);
  expect(f.controller.status()).toMatchObject({
    connected: false,
    sharingAllowed: false,
    providing: false,
  });
});

test("chaos: a late identity from the previous enrollment cannot replace the current deployment", async () => {
  const oldId = crypto.randomUUID(),
    newId = crypto.randomUUID();
  let release!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const f = await fixture((attempt) =>
    attempt === 1 ? first : Response.json({ deploymentId: newId })
  );
  await f.store.set(f.connection.serverUrl, oldId, true);
  const old = f.controller.configure(f.connection);
  await until(() => f.attempts() === 1);
  await f.controller.configure({ ...f.connection, connectionId: "replacement" });
  release(Response.json({ deploymentId: oldId }));
  await old;
  expect(f.controller.status()).toMatchObject({
    connected: true,
    deploymentId: newId,
    sharingAllowed: false,
  });
});

for (const response of [
  () => new Response(null, { status: 403 }),
  () => Response.json({ deploymentId: "invalid" }),
  () => new Response("{", { headers: { "content-type": "application/json" } }),
])
  test("chaos: unsuccessful identity recovery never enables a saved grant", async () => {
    const deploymentId = crypto.randomUUID();
    const f = await fixture(response);
    await f.store.set(f.connection.serverUrl, deploymentId, true);
    await f.controller.configure(f.connection);
    await until(() => f.attempts() === 2);
    expect(f.controller.status()).toMatchObject({
      connected: false,
      deploymentId: null,
      sharingAllowed: false,
      providing: false,
    });
  });

test("chaos: sleep cancels retries until wake, and waking during recovery retries at once, still opted out", async () => {
  const deploymentId = crypto.randomUUID();
  const f = await fixture((attempt) => (attempt === 1 ? new Response(null, { status: 503 }) : Response.json({ deploymentId })));
  f.controller.setSuspended(true);
  await f.controller.configure(f.connection);
  await Bun.sleep(1400);
  expect(f.attempts()).toBe(0);
  f.controller.setSuspended(false);
  await until(() => f.attempts() === 1, 500);
  // The first attempt failed; waking again retries immediately instead of waiting out the backoff.
  f.controller.setSuspended(true);
  f.controller.setSuspended(false);
  await until(() => f.controller.status().connected, 500);
  expect(f.attempts()).toBe(2);
  expect(f.controller.status().sharingAllowed).toBe(false);
  f.controller.setSuspended(false);
  await Bun.sleep(20);
  expect(f.attempts()).toBe(2);
});

test("network enumeration order and hardware metadata do not reset a healthy tunnel", () => {
  const address: NetworkInterfaceInfo = {
    address: "192.0.2.10",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:11:22:33:44:55",
    internal: false,
    cidr: "192.0.2.10/24",
  };
  const other: NetworkInterfaceInfo = { ...address, address: "198.51.100.20" };
  expect(networkFingerprint({ en0: [address, other], lo0: [{ ...address, internal: true }] })).toBe(
    networkFingerprint({ lo0: [], en0: [{ ...other, mac: "aa:bb:cc:dd:ee:ff" }, address] })
  );
  expect(networkFingerprint({ en0: [address] })).not.toBe(networkFingerprint({ en0: [other] }));
  expect(networkFingerprint({ en0: [address] })).not.toBe(networkFingerprint({ en1: [address] }));
  expect(networkFingerprint({ en0: [address] })).not.toBe(networkFingerprint({}));
});
