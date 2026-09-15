// Server-backed wording captured from GrokBot's native update_state tool on
// 2026-09-14. File-backed GrokBot uses read/grep hints instead of RecallMemory.
// Keep structured state/event/idempotency records internal to the application.
export function formatMemoryToolResult(result: Record<string, unknown>): string | Record<string, unknown> {
  if (result.target !== "memory" || !["write", "forget"].includes(String(result.action))) return result;
  const label = result.scope === "user" ? "shared user memory"
    : result.scope === "project" ? `project "${result.project}" memory`
    : result.scope === "conversation" ? "this conversation's memory" : "your memory";
  if (result.action === "write") {
    return result.saved
      ? `Remembered in ${label} (${result.tier}): ${result.fact}`
      : `Not saved — nothing was saved to ${label} — the fact was empty or already recorded. Call RecallMemory to see what is already there.`;
  }
  return result.forgotten
    ? `Forgot from ${label}: ${result.fact}`
    : `Not saved — no fact with exactly that text is recorded in ${label}. Call RecallMemory for the exact wording first.`;
}
