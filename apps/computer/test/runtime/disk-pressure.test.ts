import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDiskPressure, DISK_PRESSURE_REMINDER, DiskPressureMonitor, diskPressureReminderStepPersisted } from "../../src/runtime/disk-pressure";

const GIB = 1024 ** 3;

test("low disk uses the reference thresholds with recovery hysteresis", () => {
  expect(classifyDiskPressure({ availableBytes: 50 * GIB, totalBytes: 100 * GIB })).toBe("healthy");
  expect(classifyDiskPressure({ availableBytes: 14 * GIB, totalBytes: 100 * GIB })).toBe("soft");
  expect(classifyDiskPressure({ availableBytes: 7 * GIB, totalBytes: 100 * GIB })).toBe("soft");
  expect(classifyDiskPressure({ availableBytes: 2 * GIB, totalBytes: 1000 * GIB })).toBe("hard");
  expect(classifyDiskPressure({ availableBytes: 18 * GIB, totalBytes: 100 * GIB }, "soft")).toBe("soft");
  expect(classifyDiskPressure({ availableBytes: 21 * GIB, totalBytes: 100 * GIB }, "soft")).toBe("healthy");
});

test("each bot hears about a low-disk episode once, and again after the disk recovers and fills", async () => {
  let available = 50 * GIB;
  let now = 0;
  const monitor = new DiskPressureMonitor(["/workspace"], undefined, async () => ({ device: "1", availableBytes: available, totalBytes: 100 * GIB }), () => now);
  expect(await monitor.claim("a")).toBeNull();
  available = 5 * GIB;
  now += 5 * 60_000;
  const episode = await monitor.claim("a");
  expect(episode).toBeString();
  await monitor.commit("a", episode!);
  expect(await monitor.claim("a")).toBeNull();
  expect(await monitor.claim("b")).toBe(episode);
  available = 60 * GIB;
  now += 5 * 60_000;
  expect(await monitor.claim("b")).toBeNull();
  available = 5 * GIB;
  now += 5 * 60_000;
  const next = await monitor.claim("a");
  expect(next).toBeString();
  expect(next).not.toBe(episode);
  expect(DISK_PRESSURE_REMINDER).toContain("Never delete anything without their explicit yes.");
});

test("like the reference, the worst of the workspace, agent data and temp volumes counts, once per device", async () => {
  const volumes: Record<string, { device: string; availableBytes: number; totalBytes: number }> = {
    "/workspace": { device: "1", availableBytes: 50 * GIB, totalBytes: 100 * GIB },
    "/data": { device: "1", availableBytes: 50 * GIB, totalBytes: 100 * GIB },
    "/tmp": { device: "2", availableBytes: 1 * GIB, totalBytes: 10 * GIB },
  };
  const monitor = new DiskPressureMonitor(Object.keys(volumes), undefined, async (path) => volumes[path]!);
  expect(await monitor.claim("a")).toBeString();
});

test("a restarted computer keeps the episode and who already heard about it, as the reference's ledger does", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-disk-ledger-"));
  try {
    const ledger = join(root, "disk-pressure-reminders.json");
    let available = 5 * GIB;
    const read = async () => ({ device: "1", availableBytes: available, totalBytes: 100 * GIB });
    const before = new DiskPressureMonitor(["/workspace"], ledger, read);
    const episode = await before.claim("a");
    await before.commit("a", episode!);
    const after = new DiskPressureMonitor(["/workspace"], ledger, read);
    expect(await after.claim("a")).toBeNull();
    expect(await after.claim("b")).toBe(episode);
    available = 60 * GIB;
    const recovered = new DiskPressureMonitor(["/workspace"], ledger, read);
    expect(await recovered.claim("b")).toBeNull();
    available = 5 * GIB;
    const refilled = new DiskPressureMonitor(["/workspace"], ledger, read);
    expect(await refilled.claim("a")).not.toBe(episode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the reminder is spent once a model step after it was saved, even if the turn is then interrupted", () => {
  const reminder = { role: "custom", customType: "openteam-disk-pressure" };
  expect(diskPressureReminderStepPersisted([reminder])).toBe(false);
  expect(diskPressureReminderStepPersisted([reminder, { role: "assistant", stopReason: "aborted" }])).toBe(false);
  expect(diskPressureReminderStepPersisted([{ role: "assistant", stopReason: "toolUse" }, reminder])).toBe(false);
  expect(diskPressureReminderStepPersisted([reminder, { role: "assistant", stopReason: "toolUse" }, { role: "assistant", stopReason: "aborted" }])).toBe(true);
});

test("a main-agent turn on a low disk gets the reminder before its first request", async () => {
  const { compactionExtension } = await import("../../src/runtime/compaction");
  const sent: any[] = [];
  const messages: any[] = [{ role: "user", content: "Install the SDK" }];
  const active: any = {
    contextSessionId: crypto.randomUUID(), instructions: "System", modelRef: { providerId: "openai", modelId: "m" }, reasoning: "off",
    userInfoMessage: null, cwd: "/tmp", requestSource: "turn", subagentType: null, diskPressureEpisode: 3, queue: { push() {} },
    session: {
      messages, model: { contextWindow: 100_000 }, getContextUsage: () => undefined, getAllTools: () => [], getActiveToolNames: () => [],
      sendCustomMessage: async (message: any) => { sent.push(message); messages.push({ role: "custom", ...message }); },
    },
  };
  const coordinator: any = {
    latestEvent: async () => null, observe: async () => {}, waitForModelCapacity: async () => {},
    modelContextMessages: async (input: any) => input.piMessages, takeProjectedEvent: () => null,
  };
  const handlers: Record<string, (event: any, ctx?: any) => Promise<any>> = {};
  compactionExtension(coordinator, async () => ({ text: "" }), { buildSessionContext: () => ({ messages }), getEntries: () => [] } as any, active)
    .factory({ on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
  await handlers.context!({ messages: [...messages] });
  await handlers.context!({ messages: [...messages] });
  expect(sent.map((message) => message.customType)).toEqual(["openteam-disk-pressure"]);
  expect(sent[0].content).toBe(DISK_PRESSURE_REMINDER);
  expect(active.diskPressureReminded).toBe(true);
});
