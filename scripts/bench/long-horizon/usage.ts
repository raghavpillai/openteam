import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Session files can repeat messages after a restart. Count provider responses
// once and label absent usage rather than pretending a failed call was free.
export function summarizeUsage(entries: any[]) {
  const seen = new Set<string>();
  const totals = { modelResponses: 0, responsesWithoutUsage: 0, inputTokens: 0,
    outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    estimatedUsd: 0, toolCalls: 0, browserCalls: 0 };
  for (const entry of entries) {
    const m = entry.type === "message" ? entry.message : null;
    if (m?.role !== "assistant") continue;
    const key = m.responseId || entry.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    totals.modelResponses++;
    const u = m.usage;
    if (!u) totals.responsesWithoutUsage++;
    else {
      totals.inputTokens += u.input ?? 0;
      totals.outputTokens += u.output ?? 0;
      totals.cacheReadTokens += u.cacheRead ?? 0;
      totals.cacheWriteTokens += u.cacheWrite ?? 0;
      totals.reasoningTokens += u.reasoning ?? 0;
      totals.estimatedUsd += u.cost?.total ?? 0;
    }
    for (const item of m.content ?? []) {
      if (item.type !== "toolCall") continue;
      totals.toolCalls++;
      if (item.name === "browser" || /^browser[._]/.test(item.name ?? "")) totals.browserCalls++;
      if (item.name === "CallDynamicTool" && item.arguments?.namespace === "browser") totals.browserCalls++;
    }
  }
  return { ...totals, costLimit: "Provider-reported estimate, not an invoice; missing/cancelled responses can have unreported cost. Token categories follow provider semantics and need not be disjoint." };
}

if (import.meta.main) {
  for (const folder of process.argv.slice(2)) {
    const pi = join(folder, "pi");
    const entries = readdirSync(pi).filter(f => f.endsWith(".jsonl")).flatMap(file =>
      readFileSync(join(pi, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const usage = summarizeUsage(entries);
    writeFileSync(join(folder, "usage.json"), JSON.stringify(usage, null, 2) + "\n");
    console.log(JSON.stringify({ folder, ...usage }));
  }
}
