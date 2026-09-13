import { describe, expect, test } from "bun:test";
import {
  createVirtualMeasurements,
  setVirtualMeasurement,
  setVirtualMeasurementWidth,
} from "../src/renderer/lib/virtual-measurements";

describe("bounded virtual row measurements", () => {
  test("reuses unchanged geometry and replaces changed message versions", () => {
    const cache = createVirtualMeasurements();
    setVirtualMeasurementWidth(cache, 800);
    expect(setVirtualMeasurement(cache, "message-1", 1, 200)).toBe(true);
    expect(setVirtualMeasurement(cache, "message-1", 1, 200.2)).toBe(false);
    expect(setVirtualMeasurement(cache, "message-1", 2, 200)).toBe(true);
    expect(cache.rows.get("message-1")).toEqual({ version: 2, size: 200 });
    expect(setVirtualMeasurementWidth(cache, 800)).toBe(false);
    expect(cache.rows.size).toBe(1);
    expect(setVirtualMeasurementWidth(cache, 600)).toBe(true);
    expect(cache.rows.size).toBe(0);
  });

  test("bounds retained measurements when scrolling through a long history", () => {
    const cache = createVirtualMeasurements();
    for (let index = 0; index < 10_000; index++)
      setVirtualMeasurement(cache, `message-${index}`, 1, 100);
    expect(cache.rows.size).toBe(512);
    expect(cache.rows.has("message-0")).toBe(false);
    expect(cache.rows.has("message-9999")).toBe(true);
  });
});
