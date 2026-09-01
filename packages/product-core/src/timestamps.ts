export const IDLE_GAP_MS = 30 * 60 * 1_000;

export const formatOfflineDeliveryTimestamp = (
  timestampMs: number,
  locale?: Intl.LocalesArgument
): string => {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toISOString();
  }
};

export const formatOfflineDeliveryLabel = (
  timestampMs: number,
  locale?: Intl.LocalesArgument
): string => `Sent while offline · ${formatOfflineDeliveryTimestamp(timestampMs, locale)}`;

const partsForDay = (value: Date, timeZone?: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day") };
};

const dayOrdinal = (value: Date, timeZone?: string) => {
  const { year, month, day } = partsForDay(value, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
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

export const formatIdleGapTimestamp = (
  createdAt: string,
  now = new Date(),
  timeZone?: string
): string => {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  const formatOptions = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat("en-US", {
    ...formatOptions,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const daysAgo = dayOrdinal(now, timeZone) - dayOrdinal(date, timeZone);
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  if (daysAgo > 1 && daysAgo < 7) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      ...formatOptions,
      weekday: "long",
    }).format(date);
    return `${weekday} ${time}`;
  }
  const calendarDate = new Intl.DateTimeFormat("en-US", {
    ...formatOptions,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  return `${calendarDate}, ${time}`;
};
