import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserBroker } from "../../src/browser/broker";

type OriginState = {
  origin: string;
  capturedAt: string;
  localStorage: Array<[string, string]>;
};

const fakeBrowser = (initial: OriginState) => {
  let state = initial;
  const imports: OriginState[] = [];
  let server: Bun.Server<{ kind: "cdp" }>;
  server = Bun.serve<{ kind: "cdp" }>({
    port: 0,
    fetch(request, bunServer): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") {
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` });
      }
      if (url.pathname === "/cdp" && bunServer.upgrade(request, { data: { kind: "cdp" } })) {
        return;
      }
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
          result = {
            targetInfos: [
              { targetId: "page", type: "page", url: "https://example.com/browser-test" },
            ],
          };
        }
        if (message.method === "Target.attachToTarget") result = { sessionId: "session" };
        if (message.method === "Runtime.evaluate") {
          const expression = message.params?.expression ?? "";
          const payload = expression.startsWith("(async (state)")
            ? expression.match(/\}\)\((\{[\s\S]*\})\)$/)?.[1]
            : undefined;
          if (payload) {
            state = JSON.parse(payload) as OriginState;
            imports.push(state);
            result = { result: { value: true } };
          } else {
            result = { result: { value: { ...state, capturedAt: new Date().toISOString() } } };
          }
        }
        socket.send(JSON.stringify({ id: message.id, result, sessionId: message.sessionId }));
      },
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("Fake browser did not bind a port");
  return {
    port,
    imports,
    setLocalStorage(value: string) {
      state = {
        origin: "https://example.com",
        capturedAt: new Date().toISOString(),
        localStorage: [["session", value]],
      };
    },
    stop: () => server.stop(true),
  };
};

describe("live browser origin-state reconciliation", () => {
  const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
  let home: string | undefined;

  afterEach(async () => {
    for (const browser of browsers.splice(0)) browser.stop();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  test("routes an origin change from one bot browser into another", async () => {
    home = await mkdtemp(join(tmpdir(), "openteam-browser-broker-"));
    const alpha = fakeBrowser({
      origin: "https://example.com",
      capturedAt: new Date().toISOString(),
      localStorage: [["session", "alpha"]],
    });
    const beta = fakeBrowser({
      origin: "https://example.com",
      capturedAt: new Date().toISOString(),
      localStorage: [],
    });
    browsers.push(alpha, beta);
    const broker = new BrowserBroker(home);
    try {
      await broker.attach("alpha", alpha.port, join(home, "chrome-profile"), 3);
      await new Promise((resolve) => setTimeout(resolve, 1_650));
      await broker.attach("beta", beta.port, join(home, "chrome-profile-2"), 3);
      expect(beta.imports.at(-1)?.localStorage).toEqual([["session", "alpha"]]);

      alpha.setLocalStorage("updated");
      await new Promise((resolve) => setTimeout(resolve, 1_650));
      expect(beta.imports.at(-1)?.localStorage).toEqual([["session", "updated"]]);
    } finally {
      await broker.detach("alpha");
      await broker.detach("beta");
    }
  });
});
