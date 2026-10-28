export function workIsSettled(subagents: any[], routines: any[]) {
  return subagents.every(s => ["completed", "failed", "stopped"].includes(s.status) && !s.nextCheckAt) &&
    !routines.some(r => r.enabled && !r.deletedAt);
}
