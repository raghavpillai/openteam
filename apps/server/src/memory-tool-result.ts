// The reference's UpdateMemory outcomes. Memory is kept off the bot's computer,
// so lookups point to RecallMemory. Structured results stay internal.
export function formatMemoryToolResult(result: Record<string, unknown>): string | Record<string, unknown> {
  if (result.target !== "memory" || !["write", "forget"].includes(String(result.action))) return result;
  if (typeof result.refused === "string") return `Not saved: ${result.refused}`;
  const label = result.type === "shared_profile" || result.type === "shared_journal" ? "shared user memory" : "your memory";
  if (result.action === "write") {
    return result.saved
      ? `Remembered in ${label} (${result.type}): ${result.fact}`
      : `Not saved: nothing was saved to ${label}. The fact was empty or already recorded. Call RecallMemory to see what is already there.`;
  }
  return result.forgotten
    ? `Forgot from ${label}: ${result.fact}`
    : `Not saved: no fact with exactly that text is recorded in ${label}. Call RecallMemory for the exact wording first.`;
}
