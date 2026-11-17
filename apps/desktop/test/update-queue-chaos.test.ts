import { describe, test } from "bun:test";
import { CHAOS_FAULTS, runChaosSeed } from "./fixtures/update-queue-chaos-model";

describe("update queue deterministic chaos", () => {
  for (const [seed, fault] of CHAOS_FAULTS.entries())
    test(fault, async () => {
      await runChaosSeed(seed, 256, fault);
    });
  test("10,000 concurrent actions share one queue owner", async () => {
    await runChaosSeed(201, 10_000, "healthy");
  });
  test("256 seeded fault and interleaving traces", async () => {
    for (let seed = 0; seed < 256; seed++) await runChaosSeed(seed);
  });
});
