import { describe, expect, test } from "bun:test";
import { createKeyedRequestCoordinator } from "../src";

describe("keyed request coordinator", () => {
  test("invalidates leases so stale results cannot commit", async () => {
    const coordinator = createKeyedRequestCoordinator();
    let captured: Parameters<typeof coordinator.isCurrent>[0] | null = null;
    const request = coordinator.run("channel-1", async (lease) => {
      captured = lease;
      return "done";
    });
    expect(coordinator.isCurrent(captured!)).toBe(true);
    coordinator.invalidate("channel-1");
    expect(coordinator.isCurrent(captured!)).toBe(false);
    expect(await request).toBe("done");
  });
});
