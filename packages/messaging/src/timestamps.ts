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
  const candidates = value
    ? [value, FALLBACK_TIME_ZONE]
    : [process.env.OPENBOT_TIME_ZONE, FALLBACK_TIME_ZONE];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && validTimeZone(candidate))
  )!;
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

export function timestampUserTurn(
  content: string,
  options: { occurredAt?: Date | string; timeZone?: string | null } = {}
): string {
  const timestamp = formatTurnTimestamp(options.occurredAt ?? new Date(), options.timeZone);
  return `<timestamp>${timestamp}</timestamp>\n<user_query>\n${content}\n</user_query>`;
}
