import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrialBudget, readInferenceBudget } from "./budget";

test("a depleted balance, spend allowance or changed account cannot launch a fresh paid trial", () => {
  const policy = { startingUsageUsd: 100, holdAtAdditionalUsd: 20, minimumAvailableUsd: 5 };
  const snapshot = { observedAt: new Date().toISOString(), totalUsageUsd: 110, availableUsd: 15 };
  expect(checkTrialBudget(snapshot, policy)).toMatchObject({ accepted: true, additionalUsageUsd: 10 });
  expect(() => checkTrialBudget({ ...snapshot, availableUsd: .02 }, policy)).toThrow("hold new paid trials");
  expect(() => checkTrialBudget({ ...snapshot, totalUsageUsd: 120 }, policy)).toThrow("allowance reached");
  expect(() => checkTrialBudget({ ...snapshot, totalUsageUsd: 99 }, policy)).toThrow("usage was reset");
  expect(() => checkTrialBudget(snapshot, { ...policy, startingUsageUsd: NaN })).toThrow("Invalid");
});

test("quota lookup is read-only, validates its data and never returns credentials or a provider error body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "budget-gate-")), file = join(dir, "fixture-key");
  await writeFile(file, "private-fixture-token", { mode: 0o600 });
  try {
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/credits");
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.headers).toEqual({ authorization: "Bearer private-fixture-token" });
      return Response.json({ data: { total_credits: 125, total_usage: 100 } });
    }) as typeof fetch;
    const observed = await readInferenceBudget(file, request);
    expect(observed.availableUsd).toBe(25);
    expect(JSON.stringify(observed)).not.toContain("private-fixture-token");
    await expect(readInferenceBudget(file, (async () => Response.json({ error: "private-fixture-token" }, { status: 402 })) as typeof fetch)).rejects.toThrow("HTTP 402");
    await expect(readInferenceBudget(file, (async () => Response.json({ data: { total_credits: "25", total_usage: 0 } })) as typeof fetch)).rejects.toThrow("invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
