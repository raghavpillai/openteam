export {
  formatOfflineDeliveryLabel,
  formatOfflineDeliveryTimestamp,
} from "@openteam/product-core/timestamps";

// Desktop transcript separators follow the reference's fifteen-minute/day break.
export const IDLE_GAP_MS = 15 * 60 * 1_000;

const formatters = new Map<string, ReturnType<typeof createFormatters>>();
function createFormatters(timeZone?: string) {
  const zone = timeZone ? { timeZone } : {};
  return {
    calendar: new Intl.DateTimeFormat("en-US", { ...zone, year: "numeric", month: "numeric", day: "numeric" }),
    time: new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" }),
    sameYear: new Intl.DateTimeFormat("en-US", { ...zone, weekday: "short", month: "short", day: "numeric" }),
    otherYear: new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric", year: "numeric" }),
  };
}
function getFormatters(timeZone?: string) {
  const key = timeZone ?? "local";
  let result = formatters.get(key);
  if (!result) {
    result = createFormatters(timeZone);
    formatters.set(key, result);
  }
  return result;
}
function calendarDate(date: Date, timeZone?: string) {
  let year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
  if (timeZone) {
    const parts = getFormatters(timeZone).calendar.formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)?.value);
    year = part("year"); month = part("month"); day = part("day");
  }
  return { year, ordinal: Date.UTC(year, month - 1, day) / 86_400_000 };
}

export function shouldShowIdleGapTimestamp(
  previousCreatedAt: string | undefined,
  createdAt: string,
  idleGapMs = IDLE_GAP_MS,
  timeZone?: string
) {
  const current = new Date(createdAt);
  if (!Number.isFinite(current.getTime())) return false;
  if (!previousCreatedAt) return true;
  const previous = new Date(previousCreatedAt);
  if (!Number.isFinite(previous.getTime())) return false;
  return Math.abs(current.getTime() - previous.getTime()) >= idleGapMs ||
    calendarDate(current, timeZone).ordinal !== calendarDate(previous, timeZone).ordinal;
}

export function formatIdleGapTimestamp(createdAt: string, now = new Date(), timeZone?: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  const currentDay = calendarDate(now, timeZone);
  const messageDay = calendarDate(date, timeZone);
  const daysAgo = currentDay.ordinal - messageDay.ordinal;
  const format = getFormatters(timeZone);
  const time = format.time.format(date);
  if (daysAgo === 0) return `Today ${time}`;
  if (daysAgo === 1) return `Yesterday ${time}`;
  const calendar = (currentDay.year === messageDay.year ? format.sameYear : format.otherYear).format(date);
  return `${calendar} ${time}`;
}
