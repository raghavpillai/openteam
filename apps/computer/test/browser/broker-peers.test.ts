// BrowserBroker against fake browser-level CDP endpoints: sharing sign-ins and site data between bots' browsers.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { BrowserBroker } from "../../src/browser/broker";
import { tempDirs } from "../temp";
const tempDir = tempDirs();

const origin = "https://example.com";
type Cookie = { name: string; value: string; domain: string; path: string; expires: number };
type OriginState = { origin: string; capturedAt: string; localStorage: Array<[string, string]> };
const stateWith = (localStorage: Array<[string, string]>): OriginState => ({ origin, capturedAt: new Date().toISOString(), localStorage });

/**
 * A browser with a cookie jar and, while `tab` is open, one page on `origin` with that page's site data.
 * While stalled it holds every message, like a SIGSTOPped Chromium whose socket stays open, and answers late on resume.
 */
const fakeBrowser = (options: { localStorage?: Array<[string, string]>; tab?: boolean } = {}) => {
  let state = stateWith(options.localStorage ?? []);
  let tabOpen = options.tab ?? true;
  let stalled = false;
  const jar = new Map<string, Cookie>();
  const held: Array<() => void> = [];
  const imports: OriginState[] = [];
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const server: Bun.Server<undefined> = Bun.serve<undefined>({
    port: 0,
    fetch(request, bunServer): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` });
      if (url.pathname === "/cdp" && bunServer.upgrade(request, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open: (socket) => { sockets.add(socket); },
      close: (socket) => { sockets.delete(socket); },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string; params?: { expression?: string; cookies?: Cookie[] }; sessionId?: string };
        const answer = () => {
          let result: unknown = {};
          if (message.method === "Storage.getCookies") result = { cookies: [...jar.values()] };
          if (message.method === "Storage.setCookies")
            for (const cookie of message.params?.cookies ?? []) cookie.expires === 1 ? jar.delete(cookie.name) : jar.set(cookie.name, cookie);
          if (message.method === "Target.getTargets") result = { targetInfos: tabOpen ? [{ targetId: "page", type: "page", url: `${origin}/prefs` }] : [] };
          if (message.method === "Target.attachToTarget") result = { sessionId: "session" };
          if (message.method === "Runtime.evaluate") {
            const expression = message.params?.expression ?? "";
            const payload = expression.startsWith("(async (state)") ? expression.match(/\}\)\((\{[\s\S]*\})\)$/)?.[1] : undefined;
            if (payload) {
              state = JSON.parse(payload) as OriginState;
              imports.push(state);
              result = { result: { value: true } };
            } else result = { result: { value: { ...state, capturedAt: new Date().toISOString() } } };
          }
          socket.send(JSON.stringify({ id: message.id, result, sessionId: message.sessionId }));
        };
        if (stalled) held.push(answer);
        else answer();
      },
    },
  });
  const browser = {
    port: server.port as number,
    jar,
    imports,
    value: () => state.localStorage[0]?.[1],
    set: (value: string, key = "preference") => { state = stateWith([[key, value]]); },
    leaveSite: () => { tabOpen = false; },
    connections: () => sockets.size,
    stall: () => { stalled = true; },
    resume: () => { stalled = false; for (const answer of held.splice(0)) answer(); },
    closeSockets: () => { for (const socket of sockets) socket.close(); },
  };
  cleanup.push(() => server.stop(true));
  return browser;
};
const site = (value: string) => fakeBrowser({ localStorage: [["preference", value]] });
const cookie = (name: string, value: string): Cookie => ({ name, value, domain: "example.com", path: "/", expires: 2_000_000_000 });

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
/** A broker on `home` (a fresh temp folder by default) with `browsers` attached under their bot ids. */
const attach = async (browsers: Record<string, ReturnType<typeof fakeBrowser>>, home?: string, ...rest: [string?, number?]) => {
  const broker: any = new BrowserBroker(home ?? await tempDir("openteam-broker-"));
  for (const [botId, browser] of Object.entries(browsers)) {
    cleanup.push(() => broker.detach(botId));
    await broker.attach(botId, browser.port, ...rest);
  }
  return broker;
};

test("a site change the broker never saw survives the browser relaunching", async () => {
  const home = await tempDir("openteam-broker-relaunch-");
  const first = site("ls-s3");
  // Each launch after a restart starts a fresh broker on the same home folder.
  const before = await attach({ orion: first }, home);
  await before.reconcile();
  // The site saves a newer value and the tab leaves within one sync pass.
  first.set("ls-q2");
  first.leaveSite();
  await before.reconcile();
  await before.detach("orion");
  // Chromium kept the newer value in its own profile.
  const relaunched = site("ls-q2");
  const after = await attach({ orion: relaunched }, home);
  await after.reconcile();
  expect(relaunched.imports).toEqual([]);
  expect(relaunched.value()).toBe("ls-q2");
  expect(after.origins.get(origin).localStorage).toEqual([["preference", "ls-q2"]]);
  // Another bot's browser now gets the newer value, not the older copy.
  const other = site("");
  await after.attach("nova", other.port);
  cleanup.push(() => after.detach("nova"));
  await after.reconcile();
  expect(other.value()).toBe("ls-q2");
});

test("a sign-in from another bot still reaches a browser that relaunches with an older copy", async () => {
  const home = await tempDir("openteam-broker-relaunch-");
  const nova = site("signed-out");
  const broker = await attach({ orion: site("signed-out"), nova }, home);
  await broker.reconcile();
  await broker.detach("orion");
  nova.set("signed-in");
  await broker.reconcile();
  await broker.detach("nova");
  const relaunched = site("signed-out");
  await (await attach({ orion: relaunched }, home)).reconcile();
  expect(relaunched.value()).toBe("signed-in");
});

test("the sync loop routes an origin change from one bot browser into another", async () => {
  const home = await tempDir("openteam-browser-broker-");
  const alpha = fakeBrowser({ localStorage: [["session", "alpha"]] });
  const beta = fakeBrowser();
  const broker = await attach({ alpha }, home, join(home, "chrome-profile"), 3);
  await Bun.sleep(1_650);
  await broker.attach("beta", beta.port, join(home, "chrome-profile-2"), 3);
  cleanup.push(() => broker.detach("beta"));
  expect(beta.imports.at(-1)?.localStorage).toEqual([["session", "alpha"]]);
  alpha.set("updated", "session");
  await Bun.sleep(1_650);
  expect(beta.imports.at(-1)?.localStorage).toEqual([["session", "updated"]]);
});

// Browser-level stalls: no page tabs, cookies only.
const peersOf = async () => {
  const first = fakeBrowser({ tab: false }), second = fakeBrowser({ tab: false });
  return { broker: await attach({ first, second }), first, second };
};

test("a browser that stalls past the CDP timeout keeps sharing sign-ins afterwards", async () => {
  const { broker, first, second } = await peersOf();
  first.stall();
  // Another bot signs in while the first browser is not answering.
  second.jar.set("sid", cookie("sid", "signed-in"));
  await broker.reconcile();
  first.resume();
  expect(broker.peers.has("first")).toBe(true);
  expect(first.connections()).toBe(1);
  // The stalled browser catches up on what it missed, and its own sign-ins still reach the other browser.
  await broker.reconcile();
  expect(first.jar.get("sid")?.value).toBe("signed-in");
  first.jar.set("token", cookie("token", "from-first"));
  await broker.reconcile();
  expect(second.jar.get("token")?.value).toBe("from-first");
}, 15_000);

test("a sign-out missed during a stall reaches the browser once it answers again", async () => {
  const { broker, first, second } = await peersOf();
  second.jar.set("sid", cookie("sid", "signed-in"));
  await broker.reconcile();
  expect(first.jar.has("sid")).toBe(true);
  first.stall();
  second.jar.delete("sid");
  await broker.reconcile();
  first.resume();
  await broker.reconcile();
  expect(first.jar.has("sid")).toBe(false);
}, 15_000);

test("a browser whose DevTools socket closes is dropped", async () => {
  const { broker, first } = await peersOf();
  first.closeSockets();
  for (let attempt = 0; attempt < 100 && first.connections() > 0; attempt += 1) await Bun.sleep(10);
  await broker.reconcile();
  expect(broker.peers.has("first")).toBe(false);
  expect(broker.peers.has("second")).toBe(true);
});
