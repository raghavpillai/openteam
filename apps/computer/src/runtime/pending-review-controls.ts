/** A pending action must not prevent reporting a blocker or stopping work.
 * This does not approve the pending action or allow another external effect.
 * Server-side ownership and automation communication checks still apply.
 */
export function isPendingReviewControl(tool: string, value: unknown): boolean {
  const args =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (tool === "StopSubagent" || tool === "WakeParent") return true;
  if (tool === "update_state") return args.target === "routine" && args.action === "pause";
  return (
    tool === "SendToUser" &&
    args.type === "text" &&
    !args.channel &&
    !args.images &&
    !args.voice_memo
  );
}
