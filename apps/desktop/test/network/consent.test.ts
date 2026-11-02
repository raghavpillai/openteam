import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NetworkConsentStore, DesktopBrowserNetwork } from "../../src/main/browser-network";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "openteam-network-consent-"));
  directories.push(dir);
  const path = join(dir, "consent.json");
  return { path, store: new NetworkConsentStore(path) };
}
test("network permission defaults off and is scoped to deployment and server address", async () => {
  const { store, path } = await fixture();
  expect(await store.allowed("https://host.test", "deployment-a")).toBe(false);
  await store.set("https://host.test/", "deployment-a", true);
  expect(await store.allowed("https://host.test", "deployment-a")).toBe(true);
  expect(await store.allowed("https://host.test", "deployment-b")).toBe(false);
  expect(await store.allowed("https://other.test", "deployment-a")).toBe(false);
  expect(await store.allowed("https://host.test/other", "deployment-a")).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await store.set("https://host.test", "deployment-a", false);
  expect(await store.allowed("https://host.test", "deployment-a")).toBe(false);
});
test("serialized grants survive simultaneous edits and revoke is durable across restarts", async () => {
  const { store, path } = await fixture();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.set("https://host.test", `deployment-${i}`, true))
  );
  await store.set("https://host.test", "deployment-4", false);
  const restarted = new NetworkConsentStore(path);
  for (let i = 0; i < 20; i++)
    expect(await restarted.allowed("https://host.test", `deployment-${i}`)).toBe(i !== 4);
  expect((await readFile(path, "utf8")).includes("Bearer")).toBe(false);
});
test("malformed or non-boolean saved permission never enables sharing", async () => {
  const { store, path } = await fixture();
  for (const data of ["{", "null", "[]", '{"https://host.test#deployment-a":"true"}']) {
    await writeFile(path, data);
    expect(await store.allowed("https://host.test", "deployment-a")).toBe(false);
  }
});
test("unsupported platform and disconnected desktop cannot grant permission", async () => {
  const { store } = await fixture();
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
  const { store } = await fixture();
  let identity = crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname.endsWith("browser-network-identity")
        ? Response.json({ deploymentId: identity })
        : new Response("not connected", { status: 503 }),
  });
  const controller = new DesktopBrowserNetwork("machine", store, "darwin");
  const connection = { serverUrl: server.url.origin, credential: "fixture", connectionId: "one" };
  try {
    await controller.configure(connection);
    expect(controller.status().sharingAllowed).toBe(false);
    await controller.setAllowed(true);
    expect(controller.status().sharingAllowed).toBe(true);
    expect(await store.allowed(connection.serverUrl, identity)).toBe(true);
    await controller.configure(null);
    expect(controller.status()).toMatchObject({
      connected: false,
      sharingAllowed: false,
      providing: false,
    });
    await controller.configure(connection);
    expect(controller.status().sharingAllowed).toBe(true);
    await controller.setAllowed(false);
    expect(await store.allowed(connection.serverUrl, identity)).toBe(false);
    await controller.setAllowed(true);
    identity = crypto.randomUUID();
    await controller.configure(connection);
    expect(controller.status().sharingAllowed).toBe(false);
  } finally {
    controller.stop();
    server.stop(true);
  }
});
