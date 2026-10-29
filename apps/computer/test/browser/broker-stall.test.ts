import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBroker } from "../../src/browser/broker";

type Cookie = { name: string; value: string; domain: string; path: string; expires: number };

// A browser-level CDP endpoint with a cookie jar. While stalled it holds every
// message, like a SIGSTOPped Chromium whose socket stays open, and answers them
// late on resume.
const fakeBrowser = () => {
  const jar = new Map<string, Cookie>();
  const held: Array<() => void> = [];
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  let stalled = false;
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
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: { cookies?: Cookie[] };
        };
        const answer = () => {
          let result: unknown = {};
          if (message.method === "Storage.getCookies") result = { cookies: [...jar.values()] };
          if (message.method === "Storage.setCookies") {
            for (const cookie of message.params?.cookies ?? []) {
              if (cookie.expires === 1) jar.delete(cookie.name);
              else jar.set(cookie.name, cookie);
            }
          }
          if (message.method === "Target.getTargets") result = { targetInfos: [] };
          socket.send(JSON.stringify({ id: message.id, result }));
        };
        if (stalled) held.push(answer);
        else answer();
      },
    },
  });
  return {
    port: server.port as number,
    jar,
    connections: () => sockets.size,
    stall: () => {
      stalled = true;
    },
    resume: () => {
      stalled = false;
      for (const answer of held.splice(0)) answer();
    },
    closeSockets: () => {
      for (const socket of sockets) socket.close();
    },
    stop: () => server.stop(true),
  };
};

const cookie = (name: string, value: string): Cookie => ({
  name,
  value,
  domain: "example.com",
  path: "/",
  expires: 2_000_000_000,
});

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const setup = async () => {
  const home = await mkdtemp(join(tmpdir(), "openteam-broker-stall-"));
  const first = fakeBrowser();
  const second = fakeBrowser();
  const broker: any = new BrowserBroker(home);
  cleanup.push(
    () => rm(home, { recursive: true, force: true }),
    () => first.stop(),
    () => second.stop(),
    async () => {
      await broker.detach("first");
      await broker.detach("second");
    }
  );
  await broker.attach("first", first.port);
  await broker.attach("second", second.port);
  return { broker, first, second };
};

test("a browser that stalls past the CDP timeout keeps sharing sign-ins afterwards", async () => {
  const { broker, first, second } = await setup();
  first.stall();
  // Another bot signs in while the first browser is not answering.
  second.jar.set("sid", cookie("sid", "signed-in"));
  await broker.reconcile();
  first.resume();

  expect(broker.peers.has("first")).toBe(true);
  expect(first.connections()).toBe(1);

  // The stalled browser catches up on what it missed, and its own sign-ins
  // still reach the other browser.
  await broker.reconcile();
  expect(first.jar.get("sid")?.value).toBe("signed-in");
  first.jar.set("token", cookie("token", "from-first"));
  await broker.reconcile();
  expect(second.jar.get("token")?.value).toBe("from-first");
}, 15_000);

test("a sign-out missed during a stall reaches the browser once it answers again", async () => {
  const { broker, first, second } = await setup();
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
  const { broker, first } = await setup();
  first.closeSockets();
  await until(() => first.connections() === 0);
  await broker.reconcile();
  expect(broker.peers.has("first")).toBe(false);
  expect(broker.peers.has("second")).toBe(true);
});
