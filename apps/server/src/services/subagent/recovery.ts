export const SUBAGENT_RECOVERY_RUN_STATUSES = ["queued", "running"] as const;

export const subagentRestartError = {
  code: "runtime_restart",
  message:
    "A host restart interrupted this background task. The child is no longer running; dispatch a fresh background task if the work still matters.",
} as const;
