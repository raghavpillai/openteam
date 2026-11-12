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
  test("a heartbeat keeps the lease only while the user was active in the last five minutes; then the agent regains input", async () => {
    const { broker } = await fixture();
    const wait = () => broker.actComputerUse("idle", "/workspace", [{ action: "wait", durationMs: 1 }]);
    expect((await broker.takeover("idle", "/workspace", true)).humanTakeover).toBe(true);
    await expect(wait()).rejects.toThrow("input lease");
    const session = (broker as unknown as { sessions: Map<string, ScreenSession> }).sessions.get("idle")!;
    session.humanActiveAt = Date.now() - 4 * 60_000;
    expect((await broker.takeover("idle", "/workspace", true, { renew: true })).humanTakeover).toBe(true);
    session.humanActiveAt = Date.now() - 5 * 60_000 - 1;
    expect((await broker.takeover("idle", "/workspace", true, { renew: true })).humanTakeover).toBe(false);
    // A later heartbeat does not re-acquire control.
    expect((await broker.takeover("idle", "/workspace", true, { renew: true })).humanTakeover).toBe(false);
    await expect(wait()).rejects.not.toThrow("input lease");
    expect((await broker.takeover("idle", "/workspace", true)).humanTakeover).toBe(true);
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
  test("simultaneous cold requests share one desktop per bot, with distinct stable slots", async () => {
    const { broker, home, starts } = await fixture();
    const ids = ["a", "b", "a", "b", "c", "a", "c", "b", ...Array(8).fill("a")];
    const statuses = await Promise.all(ids.map((id) => broker.ensure(id, "/workspace")));
    const slots = new Map<string, number>();
    ids.forEach((id, i) => {
      if (slots.has(id)) expect(statuses[i]!.display).toBe(slots.get(id)!);
      slots.set(id, statuses[i]!.display);
    });
    expect(new Set(slots.values()).size).toBe(3);
    expect(new Set(statuses.filter((_, i) => ids[i] === "a").map((s) => s.viewerPassword)).size).toBe(1);
    expect(starts).toHaveLength(3);
    expect(JSON.parse(await readFile(join(home, ".sand-window-assignments.json"), "utf8"))).toMatchObject({ a: slots.get("a")! - 100 });
  });

  test("actions on one desktop finish in order, and separate desktops run independently", async () => {
    const { broker } = await fixture();
    await Promise.all([broker.ensure("a", "/workspace"), broker.ensure("b", "/workspace")]);
    const finished: string[] = [];
    const act = (id: string, ms: number, actor: "agent" | "human", label: string) =>
      broker.act(id, "/workspace", { action: "wait", ms }, actor).then(() => finished.push(label));
    await Promise.all([act("a", 90, "agent", "a-agent"), act("a", 1, "human", "a-human")]);
    expect(finished).toEqual(["a-agent", "a-human"]);
    finished.length = 0;
    await Promise.all([act("a", 90, "agent", "a"), act("b", 1, "agent", "b")]);
    expect(finished).toEqual(["b", "a"]);
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
});
