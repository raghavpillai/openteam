import { readFile } from "node:fs/promises";

export type InferenceBudget = {
  observedAt: string;
  totalUsageUsd: number;
  availableUsd: number;
};
export type BudgetPolicy = { startingUsageUsd: number; holdAtAdditionalUsd: number; minimumAvailableUsd: number };

/** Read-only and bench-only. Neither credentials nor a provider error body is
 * returned, logged or persisted; no billing or key settings are changed. */
export async function readInferenceBudget(keyFile: string, request: typeof fetch = fetch): Promise<InferenceBudget> {
  const key = (await readFile(keyFile, "utf8")).trim();
  if (!key) throw new Error("Benchmark inference key file is empty");
  const response = await request("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Inference budget unavailable (HTTP ${response.status}); hold new paid trials`);
  const body = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
  const credits = body.data?.total_credits, usage = body.data?.total_usage;
  if (typeof credits !== "number" || !Number.isFinite(credits) || typeof usage !== "number" || !Number.isFinite(usage) || credits < 0 || usage < 0)
    throw new Error("Inference budget response is invalid; hold new paid trials");
  return { observedAt: new Date().toISOString(), totalUsageUsd: usage, availableUsd: credits - usage };
}

export function checkTrialBudget(observed: InferenceBudget, policy: BudgetPolicy) {
  if (![observed.totalUsageUsd, observed.availableUsd, policy.startingUsageUsd, policy.holdAtAdditionalUsd, policy.minimumAvailableUsd].every(Number.isFinite) ||
    policy.startingUsageUsd < 0 || policy.holdAtAdditionalUsd <= 0 || policy.minimumAvailableUsd <= 0)
    throw new Error("Invalid benchmark budget policy");
  const additionalUsageUsd = observed.totalUsageUsd - policy.startingUsageUsd;
  if (additionalUsageUsd < 0) throw new Error("Account usage was reset; review budget before starting new trials");
  if (observed.availableUsd < policy.minimumAvailableUsd)
    throw new Error("Insufficient available inference credit; hold new paid trials without sending a task");
  if (additionalUsageUsd >= policy.holdAtAdditionalUsd)
    throw new Error("Benchmark account-usage allowance reached; hold new paid trials without sending a task");
  return { ...observed, additionalUsageUsd, accepted: true as const,
    limits: "Conservative shared-account delta, including unrelated use. In-flight calls may settle later; native cloud usage is unavailable." };
}

/** New trial launchers call this before creating either actor or provider case.
 * The starting usage must come from the frozen cohort, never reset per trial. */
export async function requireTrialBudgetFromEnvironment() {
  const keyFile = process.env.BENCH_BUDGET_KEY_FILE;
  if (!keyFile) throw new Error("Set BENCH_BUDGET_KEY_FILE before launching paid benchmark trials");
  const observed = await readInferenceBudget(keyFile);
  return checkTrialBudget(observed, {
    startingUsageUsd: Number(process.env.BENCH_BUDGET_START_USAGE_USD),
    holdAtAdditionalUsd: Number(process.env.BENCH_BUDGET_HOLD_USD ?? "20"),
    minimumAvailableUsd: Number(process.env.BENCH_BUDGET_MIN_AVAILABLE_USD ?? "5"),
  });
}
