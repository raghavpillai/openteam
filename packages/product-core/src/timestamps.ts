const IDLE_GAP_MS = 30 * 60 * 1_000;

const rosterTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Recent conversations use calendar-day labels in every roster. */
export const formatRosterTimestamp = (
  value: string | undefined,
  _variant: "compact" | "expanded" = "compact",
  now = new Date()
): string => {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  // Compare local calendar dates, so Yesterday also works across DST changes.
  const calendarDay = (value: Date) =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
  const dayDifference = calendarDay(now) - calendarDay(date);
  if (dayDifference === 0) return rosterTimeFormatter.format(date);
  if (dayDifference === 1) return "Yesterday";
  if (dayDifference > 1 && dayDifference < 7)
    return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
};

export const shouldShowIdleGapTimestamp = (
  previousCreatedAt: string | undefined,
  createdAt: string,
  idleGapMs = IDLE_GAP_MS
): boolean => {
  if (!previousCreatedAt) return true;
  const previous = Date.parse(previousCreatedAt);
  const current = Date.parse(createdAt);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  return current - previous >= idleGapMs;
};
