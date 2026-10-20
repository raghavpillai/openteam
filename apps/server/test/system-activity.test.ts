import { expect, test } from "bun:test";
import {
  cpuPercent,
  createSystemActivityReader,
  linuxMemoryPercent,
  usagePercent,
} from "../src/system-activity";

test("system usage is normalized across cores, excludes reclaimable RAM, and handles missing counters", () => {
  expect(cpuPercent({ idle: 100, total: 400 }, { idle: 200, total: 800 })).toBe(75);
  expect(cpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 400 })).toBe(100);
  expect(cpuPercent({ idle: 0, total: 0 }, { idle: 400, total: 400 })).toBe(0);
  expect(cpuPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBeNull();
  expect(cpuPercent({ idle: 100, total: 400 }, { idle: 0, total: 100 })).toBeNull();
  expect(
    linuxMemoryPercent(
      "MemTotal:       1000 kB\nMemFree: 10 kB\nMemAvailable:    400 kB\nCached: 390 kB\n"
    )
  ).toBe(60);
  expect(linuxMemoryPercent("MemTotal: 1000 kB\nMemFree: 10 kB\n")).toBeNull();
  expect(usagePercent(1, 0)).toBeNull();
  expect(usagePercent(NaN, 100)).toBeNull();
  expect(usagePercent(200, 100)).toBe(100);
});

test("concurrent viewers share an on-demand sample; expired samples refresh and failures can retry", async () => {
  let clock = 0;
  let calls = 0;
  const value = {
    sampledAt: "2026-10-20T12:00:00Z",
    cpuPercent: 25,
    memoryPercent: 70,
    diskPercent: null,
  };
  const reader = createSystemActivityReader(
    async () => {
      calls++;
      if (calls === 2) throw new Error("temporary failure");
      return value;
    },
    () => clock
  );
  expect(calls).toBe(0);
  expect(await Promise.all([reader(), reader(), reader()])).toEqual([value, value, value]);
  expect(calls).toBe(1);
  await reader();
  expect(calls).toBe(1);
  clock = 1_001;
  await expect(reader()).rejects.toThrow("temporary failure");
  expect(await reader()).toEqual(value);
  expect(calls).toBe(3);
});
