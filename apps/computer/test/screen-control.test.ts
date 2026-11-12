import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenBroker } from "../src/screen-broker";
import type { ScreenSession } from "../src/screen/types";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const brokerAt = (home: string) => {
  const broker = new ScreenBroker(home);
  Object.assign(broker, {
    startSession: async (s: ScreenSession) => {
      s.state = "ready";
      s.lastHealthCheckAt = Date.now();
    },
  });
  return broker;
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "computer-control-"));
  homes.push(home);
  return { home, broker: brokerAt(home) };
}
test("explicit control survives days without renewals and a computer process restart", async () => {
  const { home, broker } = await fixture();
  const owned = await broker.takeover("bot", "/workspace", true, { controlId: "desktop" });
  expect(owned.controlSession?.id).toBe("desktop");
  expect(
    broker.viewerMayInput("bot", {
      controlId: "desktop",
      generation: owned.controlSession!.generation,
    })
  ).toBe(true);
  expect(
    broker.viewerMayInput("bot", { controlId: "ios", generation: owned.controlSession!.generation })
  ).toBe(false);
  const s = (broker as unknown as { sessions: Map<string, ScreenSession> }).sessions.get("bot")!;
  s.humanTakeoverUntil = 0;
  s.humanActiveAt = Date.now() - 86400000;
  expect((await broker.status("bot", "/workspace")).humanTakeover).toBe(true);
  const restarted = brokerAt(home);
  expect((await restarted.status("bot", "/workspace")).controlSession).toEqual(
    owned.controlSession
  );
  await expect(
    restarted.actComputerUse("bot", "/workspace", [{ action: "wait", durationMs: 1 }])
  ).rejects.toThrow("input lease");
});
test("another viewer and legacy heartbeats cannot use or release owned control", async () => {
  const { broker } = await fixture();
  const owned = (await broker.takeover("bot", "/workspace", true, { controlId: "desktop" }))
    .controlSession!;
  await expect(broker.takeover("bot", "/workspace", true, { controlId: "ios" })).rejects.toThrow(
    "another device"
  );
  expect(
    (
      await broker.takeover("bot", "/workspace", false, {
        controlId: "ios",
        generation: owned.generation,
      })
    ).controlSession
  ).toEqual(owned);
  expect((await broker.takeover("bot", "/workspace", false)).controlSession).toEqual(owned);
  expect(
    (await broker.takeover("bot", "/workspace", true, { renew: true })).controlSession
  ).toEqual(owned);
  await expect(
    broker.clipboard("bot", "/workspace", { action: "copy" }, undefined, {
      id: "ios",
      generation: owned.generation,
    })
  ).rejects.toThrow("this device");
});
test("explicit transfer fences old releases and input; give back lets the agent work", async () => {
  const { broker } = await fixture();
  const first = (await broker.takeover("bot", "/workspace", true, { controlId: "desktop" }))
    .controlSession!;
  const second = (
    await broker.takeover("bot", "/workspace", true, { controlId: "ios", force: true })
  ).controlSession!;
  expect(second.generation).toBeGreaterThan(first.generation);
  const third = (
    await broker.takeover("bot", "/workspace", true, { controlId: "desktop", force: true })
  ).controlSession!;
  expect(
    (
      await broker.takeover("bot", "/workspace", false, {
        controlId: "desktop",
        generation: first.generation,
      })
    ).controlSession
  ).toEqual(third);
  await expect(
    broker.clipboard("bot", "/workspace", { action: "copy" }, undefined, {
      id: "desktop",
      generation: first.generation,
    })
  ).rejects.toThrow("this device");
  const released = await broker.takeover("bot", "/workspace", false, {
    controlId: "desktop",
    generation: third.generation,
  });
  expect(released.humanTakeover).toBe(false);
  await expect(
    broker.actComputerUse("bot", "/workspace", [{ action: "wait", durationMs: 1 }])
  ).rejects.not.toThrow("input lease");
});
test("corrupt saved ownership fails closed rather than returning input to the agent", async () => {
  const { home } = await fixture();
  await writeFile(join(home, ".sand-window-assignments.json"), "{}");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, ".openteam"), { recursive: true });
  await writeFile(join(home, ".openteam/computer-control.json"), "invalid");
  await expect(brokerAt(home).status("bot", "/workspace")).rejects.toThrow();
});

test("input remains blocked while a grant is being prepared and persisted", async () => {
  const { broker } = await fixture();
  let continueGrant!: () => void;
  let preparing!: () => void;
  const started = new Promise<void>((resolve) => {
    preparing = resolve;
  });
  Object.assign(broker, {
    interruptAgentInput: async () => {
      preparing();
      await new Promise<void>((resolve) => {
        continueGrant = resolve;
      });
    },
  });
  const request = broker.takeover("bot", "/workspace", true, { controlId: "desktop" });
  await started;
  const pending = await broker.status("bot", "/workspace");
  expect(pending.controlPending).toBe(true);
  expect(broker.viewerMayInput("bot", { controlId: "desktop", generation: 1 })).toBe(false);
  expect(pending.controlSession).toBeNull();
  expect(pending.humanTakeover).toBe(true);
  await expect(
    broker.clipboard("bot", "/workspace", { action: "copy" }, undefined, {
      id: "desktop",
      generation: 1,
    })
  ).rejects.toThrow("changing");
  continueGrant();
  const granted = await request;
  expect(granted.controlPending).toBe(false);
  expect(granted.controlSession?.id).toBe("desktop");
});

test("a failed durable release never enables agent input", async () => {
  const { home } = await fixture();
  const { ComputerControlStore } = await import("../src/screen/control-store");
  const { mkdir } = await import("node:fs/promises");
  const path = join(home, "control.json");
  const store = new ComputerControlStore(path);
  await store.change("bot", true, "desktop", undefined, false, async () => {});
  const owned = await store.get("bot");
  await rm(path);
  await mkdir(path);
  let released = false;
  await expect(
    store.change("bot", false, "desktop", owned!.generation, false, async (control) => {
      if (!control) released = true;
    })
  ).rejects.toThrow();
  expect(released).toBe(false);
  expect(await store.get("bot")).toEqual(owned);
});
