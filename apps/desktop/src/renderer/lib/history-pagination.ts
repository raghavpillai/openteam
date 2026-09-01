const HISTORY_LOAD_COOLDOWN_MS = 750;

/**
 * Prevents one UI interaction from cascading into adjacent history pages.
 * The state layer applies this per channel so the guard survives timeline
 * remounts and protects every caller, not only the scroll listener.
 */
export const nextHistoryPageLoadStartedAt = ({
  now,
  lastStartedAt,
  cooldownMs = HISTORY_LOAD_COOLDOWN_MS,
}: {
  now: number;
  lastStartedAt: number | null;
  cooldownMs?: number;
}): number | null => (lastStartedAt !== null && now - lastStartedAt < cooldownMs ? null : now);
