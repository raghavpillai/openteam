import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBroker } from "../../src/browser/broker";

const origin = "https://example.com";
type OriginState = { origin: string; capturedAt: string; localStorage: Array<[string, string]> };
const stateWith = (value: string): OriginState => ({
  origin,
  capturedAt: new Date().toISOString(),
  localStorage: [["preference", value]],
});

// A browser with one tab and that tab's site data. `tabs` is false after the
// tab left the site, so the broker cannot read or write its storage.
const fakeBrowser = (initial: string) => {
  let state = stateWith(initial);
  let tabOpen = true;
  const imports: string[] = [];
  const server: Bun.Server<undefined> = Bun.serve<undefined>({
    port: 0,
    fetch(request, bunServer): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") {
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` });
      }
      if (url.pathname === "/cdp" && bunServer.upgrade(request, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: { expression?: string };
          sessionId?: string;
        };
        let result: unknown = {};
        if (message.method === "Storage.getCookies") result = { cookies: [] };
        if (message.method === "Target.getTargets") {
          result = { targetInfos: tabOpen ? [{ targetId: "page", type: "page", url: `${origin}/prefs` }] : [] };
        }
        if (message.method === "Target.attachToTarget") result = { sessionId: "session" };
        if (message.method === "Runtime.evaluate") {
          const expression = message.params?.expression ?? "";
          const payload = expression.startsWith("(async (state)")
            ? expression.match(/\}\)\((\{[\s\S]*\})\)$/)?.[1]
            : undefined;
          if (payload) {
            state = JSON.parse(payload) as OriginState;
            imports.push(state.localStorage[0]?.[1] ?? "");
            result = { result: { value: true } };
          } else {
            result = { result: { value: { ...state, capturedAt: new Date().toISOString() } } };
          }
        }
        socket.send(JSON.stringify({ id: message.id, result, sessionId: message.sessionId }));
      },
    },
  });
  return {
    port: server.port as number,
    imports,
    value: () => state.localStorage[0]?.[1],
    set: (value: string) => {
      state = stateWith(value);
    },
    leaveSite: () => {
      tabOpen = false;
    },
    stop: () => server.stop(true),
  };
};

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const setup = async () => {
  const home = await mkdtemp(join(tmpdir(), "openteam-broker-relaunch-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const launch = async (botId: string, browser: ReturnType<typeof fakeBrowser>) => {
    cleanup.push(() => browser.stop());
    // Each launch after a restart starts a fresh broker on the same home folder.
    const broker: any = new BrowserBroker(home);
    cleanup.push(() => broker.detach(botId));
    await broker.attach(botId, browser.port);
    return broker;
  };
  return { launch };
};

test("a site change the broker never saw survives the browser relaunching", async () => {
  const { launch } = await setup();
  const first = fakeBrowser("ls-s3");
  const before = await launch("orion", first);
  await before.reconcile();
  // The site saves a newer value and the tab leaves within one sync pass.
  first.set("ls-q2");
  first.leaveSite();
  await before.reconcile();
  await before.detach("orion");

  // Chromium kept the newer value in its own profile.
  const relaunched = fakeBrowser("ls-q2");
  const after = await launch("orion", relaunched);
  await after.reconcile();
  expect(relaunched.imports).toEqual([]);
  expect(relaunched.value()).toBe("ls-q2");
  expect(after.origins.get(origin).localStorage).toEqual([["preference", "ls-q2"]]);

  // Another bot's browser now gets the newer value, not the older copy.
  const other = fakeBrowser("");
  await after.attach("nova", other.port);
  cleanup.push(() => other.stop(), () => after.detach("nova"));
  await after.reconcile();
  expect(other.value()).toBe("ls-q2");
});

test("a sign-in from another bot still reaches a browser that relaunches with an older copy", async () => {
  const { launch } = await setup();
  const orion = fakeBrowser("signed-out");
  const nova = fakeBrowser("signed-out");
  const broker = await launch("orion", orion);
  await broker.attach("nova", nova.port);
  cleanup.push(() => nova.stop());
  await broker.reconcile();
  await broker.detach("orion");

  nova.set("signed-in");
  await broker.reconcile();
  await broker.detach("nova");

  const relaunched = fakeBrowser("signed-out");
  const after = await launch("orion", relaunched);
  await after.reconcile();
  expect(relaunched.value()).toBe("signed-in");
});

test("when both copies changed, the shared sign-in still wins as before", async () => {
  const { launch } = await setup();
  const orion = fakeBrowser("first");
  const nova = fakeBrowser("first");
  const broker = await launch("orion", orion);
  await broker.attach("nova", nova.port);
  cleanup.push(() => nova.stop());
  await broker.reconcile();
  orion.set("orion-unseen");
  orion.leaveSite();
  await broker.detach("orion");

  nova.set("nova-signed-in");
  await broker.reconcile();
  await broker.detach("nova");

  const relaunched = fakeBrowser("orion-unseen");
  const after = await launch("orion", relaunched);
  await after.reconcile();
  expect(relaunched.value()).toBe("nova-signed-in");
});
