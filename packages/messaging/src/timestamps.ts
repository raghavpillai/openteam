const FALLBACK_TIME_ZONE = "UTC";

const validTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
};

export function resolveTimeZone(value?: string | null): string {
  return value && validTimeZone(value) ? value : FALLBACK_TIME_ZONE;
}

const offsetLabel = (date: Date, timeZone: string): string => {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!zoneName || zoneName === "GMT" || zoneName === "UTC") return "UTC";
  const match = zoneName.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return zoneName.replace(/^GMT/, "UTC");
  const [, sign, rawHours, minutes = "00"] = match;
  const hours = String(Number(rawHours));
  return `UTC${sign}${hours}${minutes === "00" ? "" : `:${minutes}`}`;
};

/** "Europe/Paris (currently UTC+2)": the reference's zone label in the Time section. */
export function formatTimeZoneWithOffset(timeZone: string, now = new Date()): string {
  try {
    const raw = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    if (raw === undefined) return timeZone;
    const offset = raw.replace(/^GMT/, "");
    return `${timeZone} (currently UTC${offset || "+0"})`;
  } catch {
    return timeZone;
  }
}

/** "Wednesday Oct 21, 2026": the reference's user_info date line. */
export function formatFriendlyDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric", year: "numeric" })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.year}`;
}

export function formatTurnTimestamp(
  value: Date | string,
  requestedTimeZone?: string | null
): string {
  const date = value instanceof Date ? value : new Date(value);
  const timeZone = resolveTimeZone(requestedTimeZone);
  const calendarDate = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${calendarDate}, ${time} (${offsetLabel(date, timeZone)})`;
}

/** New content for a wake that keeps the turn's original timestamp; unwrapped content stays unwrapped. */
export function retimestampUserTurn(previous: string, content: string): string {
  const timestamp = /^<timestamp>([^<]*)<\/timestamp>\n<user_query>\n/.exec(previous)?.[1];
  return timestamp === undefined ? content : `<timestamp>${timestamp}</timestamp>\n<user_query>\n${content}\n</user_query>`;
}

export function timestampUserTurn(
  content: string,
  options: { occurredAt?: Date | string; timeZone?: string | null } = {}
): string {
  const timestamp = formatTurnTimestamp(options.occurredAt ?? new Date(), options.timeZone);
  return `<timestamp>${timestamp}</timestamp>\n<user_query>\n${content}\n</user_query>`;
}
