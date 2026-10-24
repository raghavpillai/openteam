/** Host status evidence, never inferred from a worker's prose. */
export function onlyPendingBackgroundWork(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (Array.isArray(value.subagents)) {
    return value.subagents.length > 0 && value.subagents.every(onlyPendingBackgroundWork);
  }
  if (typeof value.subagent_id !== "string") return false;
  if (!["provisioning", "queued", "running"].includes(String(value.status))) return false;
  return ["queued", "running"].includes(String(value.run_status)) ||
    (value.run_status === null && value.status !== "running");
}
