import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeTools } from "../../src/runtime/tools";
import { ScreenBroker } from "../../src/screen-broker";
import type { ScreenSession } from "../../src/screen/types";
import type { BrowserUseSession } from "../../src/browser/use";
import type { ActiveTurn } from "../../src/runtime/types";
import { observeGraphicalToolResult } from "../../src/runtime/graphical-completion";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(
  execute: (tool: string, args: unknown, signal?: AbortSignal) => Promise<any>
) {
  const home = await mkdtemp(join(tmpdir(), "human-control-runtime-"));
  roots.push(home);
  const broker = new ScreenBroker(home);
  Object.assign(broker, {
    startSession: async (s: ScreenSession) => {
      s.state = "ready";
      s.lastHealthCheckAt = Date.now();
    },
  });
  const tools = new RuntimeTools(broker, "http://unused.invalid", "fixture", home, home);
  const internals = tools as unknown as {
    browserSession: () => Promise<BrowserUseSession>;
    callBrowserUse: (
      turn: ActiveTurn,
      name: string,
      args: unknown,
      signal?: AbortSignal
    ) => Promise<unknown>;
  };
  let connections = 0;
  internals.browserSession = async () => {
    connections++;
    return {
      configureUploads() {},
      registerPrivateValues() {},
      execute,
    } as unknown as BrowserUseSession;
  };
  const turn = {
    botId: "worker",
    screenBotId: "bot",
    cwd: "/workspace",
    lastGraphicalSurface: "browser",
  } as ActiveTurn;
  const call = (signal?: AbortSignal) =>
    internals.callBrowserUse(turn, "browser_click", {}, signal);
  return { broker, turn, call, connections: () => connections };
}
test("taking control cancels active browser input, drains cleanup and rejects queued actions", async () => {
  const started = deferred(),
    aborted = deferred(),
    finish = deferred();
  let calls = 0;
  const f = await fixture(async (_tool, _args, signal) => {
    calls++;
    started.resolve();
    await new Promise<void>((resolve) =>
      signal!.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          resolve();
        },
        { once: true }
      )
    );
    await finish.promise;
    throw signal!.reason;
  });
  const active = f.call();
  void active.catch(() => {});
  await started.promise;
  const queued = f.call();
  void queued.catch(() => {});
  let granted = false;
  const take = f.broker
    .takeover("bot", "/workspace", true, { controlId: "desktop" })
    .then((status) => {
      granted = true;
      return status;
    });
  await aborted.promise;
  expect(granted).toBe(false);
  expect((await f.broker.status("bot", "/workspace")).controlPending).toBe(true);
  finish.resolve();
  await expect(active).rejects.toThrow("control change");
  await expect(queued).rejects.toThrow("input lease");
  expect((await take).controlSession?.id).toBe("desktop");
  expect(calls).toBe(1);
  expect(f.turn.endTurnRequested).toBeUndefined();
  expect(f.turn.lastGraphicalSurface).toBeUndefined();
  await expect(f.call()).rejects.toThrow("input lease");
  expect(calls).toBe(1);
});
test("a browser command that cannot cancel must finish before human input is granted", async () => {
  const started = deferred(),
    aborted = deferred(),
    finish = deferred();
  const f = await fixture(async (_tool, _args, signal) => {
    signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    return { content: [], details: {} };
  });
  const action = f.call();
  void action.catch(() => {});
  await started.promise;
  let granted = false;
  const take = f.broker.takeover("bot", "/workspace", true, { controlId: "ios" }).then((status) => {
    granted = true;
    return status;
  });
  await aborted.promise;
  expect(granted).toBe(false);
  finish.resolve();
  await expect(action).rejects.toThrow("control change");
  const owned = (await take).controlSession!;
  expect(granted).toBe(true);
  await f.broker.takeover("bot", "/workspace", false, {
    controlId: "ios",
    generation: owned.generation,
  });
  await expect(f.call()).resolves.toEqual({ content: [], details: {} });
});
test("caller cancellation still reaches browser execution without ending ownership state", async () => {
  const started = deferred();
  const controller = new AbortController();
  const f = await fixture(async (_tool, _args, signal) => {
    started.resolve();
    await new Promise<void>((_, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
    );
  });
  const action = f.call(controller.signal);
  void action.catch(() => {});
  await started.promise;
  controller.abort(new Error("caller cancelled"));
  await expect(action).rejects.toThrow("caller cancelled");
  expect((await f.broker.status("bot", "/workspace")).humanTakeover).toBe(false);
});
test("human control interruptions do not misreport a working computer as unreachable", () => {
  const active = { subagentType: "computerUse" } as ActiveTurn;
  for (let i = 0; i < 30; i++)
    for (const message of [
      "The user currently holds the graphical input lease",
      "Agent graphical input interrupted by a control change",
      "Graphical control changed; inspect the screen before retrying input",
    ])
      observeGraphicalToolResult(active, true, message);
  expect(active.toolFailureBreakerTripped).toBeUndefined();
  expect(active.endTurnRequested).toBeUndefined();
});

test("a browser readiness probe cannot launch Chrome after the user takes control", async () => {
  const f = await fixture(async () => ({ content: [], details: {} }));
  const started = deferred(),
    ready = deferred<boolean>();
  let launches = 0;
  Object.assign(f.broker, {
    browserIsReady: async () => {
      started.resolve();
      return ready.promise;
    },
    openApp: () => {
      launches++;
    },
  });
  const endpoint = f.broker.browserEndpointForAgent("bot", "/workspace");
  void endpoint.catch(() => {});
  await started.promise;
  await f.broker.takeover("bot", "/workspace", true, { controlId: "desktop" });
  ready.resolve(false);
  await expect(endpoint).rejects.toThrow("input lease");
  expect(launches).toBe(0);
});
