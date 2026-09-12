import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenSession } from "../src/screen/types";
import { ScreenBroker } from "../src/screen-broker";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "screen-concurrency-"));
  homes.push(home);
  const broker = new ScreenBroker(home);
  const starts: number[] = [];
  Object.assign(broker, {
    startSession: async (session: ScreenSession) => {
      starts.push(session.display);
      await Bun.sleep(15);
      session.state = "ready";
      session.lastHealthCheckAt = Date.now();
    },
  });
  return { broker, home, starts };
};

describe("concurrent screen requests", () => {
  test("simultaneous cold requests share one desktop and one startup", async () => {
    const { broker, home, starts } = await fixture();
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () => broker.ensure("one-bot", "/workspace"))
    );
    expect(new Set(statuses.map((s) => s.display)).size).toBe(1);
    expect(new Set(statuses.map((s) => s.viewerPassword)).size).toBe(1);
    expect(starts).toHaveLength(1);
    expect(JSON.parse(await readFile(join(home, ".sand-window-assignments.json"), "utf8"))).toEqual(
      { "one-bot": statuses[0]!.display - 100 }
    );
  });

  test("different bots retain distinct stable slots under simultaneous requests", async () => {
    const { broker, starts } = await fixture();
    const ids = ["a", "b", "a", "b", "c", "a", "c", "b"];
    const statuses = await Promise.all(ids.map((id) => broker.ensure(id, "/workspace")));
    const slots = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const previous = slots.get(id);
      if (previous !== undefined) expect(statuses[i]!.display).toBe(previous);
      slots.set(id, statuses[i]!.display);
    }
    expect(new Set(slots.values()).size).toBe(3);
    expect(starts).toHaveLength(3);
  });

  test("exhausting screen slots does not poison later allocation after a slot is freed", async () => {
    const { broker, home } = await fixture();
    await writeFile(
      join(home, ".sand-window-assignments.json"),
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`reserved-${i}`, i]))
      )
    );
    await expect(broker.ensure("overflow", "/workspace")).rejects.toThrow("at most 100");
    await broker.destroy("reserved-7");
    expect((await broker.ensure("recovered", "/workspace")).display).toBe(107);
  });

  test("overlapping human and agent actions finish in order on the same desktop", async () => {
    const { broker } = await fixture();
    await broker.ensure("shared", "/workspace");
    const finished: string[] = [];
    await Promise.all([
      broker
        .act("shared", "/workspace", { action: "wait", ms: 90 }, "agent")
        .then(() => finished.push("agent")),
      broker
        .act("shared", "/workspace", { action: "wait", ms: 1 }, "human")
        .then(() => finished.push("human")),
    ]);
    expect(finished).toEqual(["agent", "human"]);
  });

  test("a waiting agent action is rejected after takeover begins", async () => {
    const { broker } = await fixture();
    await broker.ensure("shared", "/workspace");
    const first = broker.act("shared", "/workspace", { action: "wait", ms: 90 }, "human");
    const queued = broker.act("shared", "/workspace", { action: "wait", ms: 1 }, "agent").then(
      () => "ran",
      () => "rejected"
    );
    await Bun.sleep(15);
    await broker.takeover("shared", "/workspace", true);
    await first;
    expect(await queued).toBe("rejected");
    await broker.takeover("shared", "/workspace", false);
    await expect(
      broker.act("shared", "/workspace", { action: "wait", ms: 1 }, "agent")
    ).resolves.toHaveProperty("state", "ready");
  });
  test("brief takeover invalidates old queued input even after release", async () => {
    const { broker } = await fixture();
    await broker.ensure("shared", "/workspace");
    const first = broker.act("shared", "/workspace", { action: "wait", ms: 90 }, "human");
    const queued = broker.act("shared", "/workspace", { action: "wait", ms: 1 }, "agent").then(
      () => "ran",
      () => "rejected"
    );
    await Bun.sleep(15);
    await broker.takeover("shared", "/workspace", true);
    await broker.takeover("shared", "/workspace", false);
    await first;
    expect(await queued).toBe("rejected");
  });

  test("takeover interrupts an active wait before acknowledging control", async () => {
    const { broker } = await fixture();
    await broker.ensure("shared", "/workspace");
    const active = broker.act("shared", "/workspace", { action: "wait", ms: 10_000 }, "agent").then(
      () => "ran",
      () => "interrupted"
    );
    await Bun.sleep(15);
    const start = performance.now();
    await broker.takeover("shared", "/workspace", true);
    expect(await active).toBe("interrupted");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("input on separate desktops runs independently", async () => {
    const { broker } = await fixture();
    await Promise.all([broker.ensure("a", "/workspace"), broker.ensure("b", "/workspace")]);
    const finished: string[] = [];
    await Promise.all([
      broker
        .act("a", "/workspace", { action: "wait", ms: 90 }, "agent")
        .then(() => finished.push("a")),
      broker
        .act("b", "/workspace", { action: "wait", ms: 1 }, "agent")
        .then(() => finished.push("b")),
    ]);
    expect(finished).toEqual(["b", "a"]);
  });
});
