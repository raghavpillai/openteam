import { expect, test } from "bun:test";
import { classifyDiskPressure, DISK_PRESSURE_REMINDER, DiskPressureMonitor } from "../../src/runtime/disk-pressure";

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
  const monitor = new DiskPressureMonitor("/workspace", async () => ({ availableBytes: available, totalBytes: 100 * GIB }), () => now);
  expect(await monitor.claim("a")).toBeNull();
  available = 5 * GIB;
  now += 5 * 60_000;
  const episode = await monitor.claim("a");
  expect(episode).toBe(1);
  monitor.commit("a", episode!);
  expect(await monitor.claim("a")).toBeNull();
  expect(await monitor.claim("b")).toBe(1);
  available = 60 * GIB;
  now += 5 * 60_000;
  expect(await monitor.claim("b")).toBeNull();
  available = 5 * GIB;
  now += 5 * 60_000;
  expect(await monitor.claim("a")).toBe(2);
  expect(DISK_PRESSURE_REMINDER).toContain("Never delete anything without their explicit yes.");
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
