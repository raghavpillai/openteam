import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenSession } from "../src/screen/types";
import { ScreenBroker } from "../src/screen-broker";
import { assignAgentOwnership } from "../src/agent-process";

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

describe("human control idle release", () => {
  const sessionOf = (broker: ScreenBroker, id: string) =>
    (broker as unknown as { sessions: Map<string, ScreenSession> }).sessions.get(id)!;

  test("a heartbeat keeps the lease only while the user was active in the last five minutes", async () => {
    const { broker } = await fixture();
    expect((await broker.takeover("idle", "/workspace", true)).humanTakeover).toBe(true);
    const session = sessionOf(broker, "idle");
    session.humanActiveAt = Date.now() - 4 * 60_000;
    expect((await broker.takeover("idle", "/workspace", true, { renew: true })).humanTakeover).toBe(true);
    session.humanActiveAt = Date.now() - 5 * 60_000 - 1;
    expect((await broker.takeover("idle", "/workspace", true, { renew: true })).humanTakeover).toBe(false);
  });

  test("a heartbeat after idle release does not re-acquire control, but an explicit take does", async () => {
    const { broker } = await fixture();
    await broker.takeover("idle-renew", "/workspace", true);
    const session = sessionOf(broker, "idle-renew");
    session.humanActiveAt = Date.now() - 6 * 60_000;
    const renewed = await broker.takeover("idle-renew", "/workspace", true, { renew: true });
    expect(renewed.humanTakeover).toBe(false);
    expect(session.humanTakeoverUntil).toBeGreaterThan(0);
    expect((await broker.takeover("idle-renew", "/workspace", true)).humanTakeover).toBe(true);
  });

  test("the agent regains input after the lease goes idle", async () => {
    const { broker } = await fixture();
    await broker.takeover("idle-agent", "/workspace", true);
    await expect(broker.actComputerUse("idle-agent", "/workspace", [{ action: "wait", durationMs: 1 }]))
      .rejects.toThrow("input lease");
    sessionOf(broker, "idle-agent").humanActiveAt = Date.now() - 5 * 60_000 - 1;
    await expect(broker.actComputerUse("idle-agent", "/workspace", [{ action: "wait", durationMs: 1 }]))
      .rejects.not.toThrow("input lease");
  });
});

describe("concurrent screen requests", () => {
  test("clipboard input requires human control and canceled requests do not start a desktop", async () => {
    const { broker, starts } = await fixture();
    const canceled = new AbortController(); canceled.abort();
    await expect(broker.clipboard("never-start", "/workspace", { action: "copy" }, canceled.signal)).rejects.toThrow();
    expect(starts).toHaveLength(0);
    await expect(broker.clipboard("no-lease", "/workspace", { action: "paste", text: "must not arrive" })).rejects.toThrow("Take control");
    expect(starts).toHaveLength(1);
  });
  test("failed post-action capture preserves the action receipt without repeating input", async () => {
    const {broker, home} = await fixture();
    await broker.ensure("capture-failure", "/workspace");
    const previousPath = process.env.PATH;
    try {
      await writeFile(join(home,"xdotool"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${home}/input.log'\n`, {mode:0o755});
      await writeFile(join(home,"import"), "#!/bin/sh\necho 'capture unavailable' >&2\nexit 9\n", {mode:0o755});
      await assignAgentOwnership([home], true);
      process.env.PATH = home;
      await expect(broker.actComputerUse("capture-failure", "/workspace", [{action:"type",text:"once"}]))
        .rejects.toThrow("All 1 requested desktop action(s) completed");
      const input = await readFile(join(home,"input.log"),"utf8");
      expect(input.trim().split("\n")).toHaveLength(1);
      expect(input).toContain("once");
    } finally { process.env.PATH = previousPath; }
  });
  test("native review is invalidated even when human takeover has already ended", async () => {
    const { broker } = await fixture();
    const validate = await broker.guardAgentReview("shared", "/workspace");
    expect(() => validate()).not.toThrow();
    await broker.takeover("shared", "/workspace", true);
    expect(() => validate()).toThrow();
    await expect(broker.guardAgentReview("shared", "/workspace")).rejects.toThrow();
    await broker.takeover("shared", "/workspace", false);
    expect(() => validate()).toThrow("Graphical control changed during review");
    const fresh = await broker.guardAgentReview("shared", "/workspace");
    expect(() => fresh()).not.toThrow();
    await broker.act("shared", "/workspace", { action: "wait", ms: 1 }, "human");
    expect(() => fresh()).toThrow("Graphical control changed during review");
    const beforeDestroy = await broker.guardAgentReview("shared", "/workspace");
    await broker.destroy("shared");
    expect(() => beforeDestroy()).toThrow();
  });
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
