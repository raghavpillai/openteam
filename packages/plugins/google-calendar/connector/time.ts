import { Temporal } from '@js-temporal/polyfill';
import type { Args, GoogleApi } from '../../_shared/google';

export async function resolveZone(api: GoogleApi, args: Args, preferOffset = false): Promise<string> {
  if (args.timeZone) { Temporal.Now.zonedDateTimeISO(args.timeZone); return args.timeZone; }
  const input = args.startTime ?? args.timeMin;
  const offset = typeof input === 'string' ? input.match(/(Z|[+-]\d{2}:\d{2})$/i)?.[1] : undefined;
  if (preferOffset && offset) return offset.toUpperCase() === 'Z' ? 'UTC' : offset;
  const calendar = await api.request(`/calendars/${encodeURIComponent(args.calendarId ?? 'primary')}`);
  if (!calendar.timeZone) throw new Error('Calendar timezone is unavailable; specify timeZone explicitly');
  return calendar.timeZone;
}

export function instant(value: string, zone: string, overrideOffset = false): number {
  try {
    if (!overrideOffset && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return Number(Temporal.Instant.from(value).epochMilliseconds);
    const plain = value.replace(/(?:Z|[+-]\d{2}:\d{2})$/i, '');
    return Number(Temporal.PlainDateTime.from(plain.length === 10 ? `${plain}T00:00` : plain).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds);
  } catch { throw new Error(`Invalid or ambiguous date/time: ${value}. Supply an explicit UTC offset for a repeated daylight-saving time.`); }
}

export function eventDate(value: string, zone: string, allDay: boolean, overrideOffset: boolean) {
  if (allDay) return { date: Temporal.PlainDate.from(value.slice(0, 10)).toString() };
  const ms = instant(value, zone, overrideOffset);
  return { dateTime: Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toString({ timeZoneName: 'never', calendarName: 'never' }), timeZone: zone };
}

export function availableSlots(start: number, end: number, busy: Array<{ start: number; end: number }>, durationMinutes: number, zone: string, preferences: Args = {}) {
  const duration = durationMinutes * 60_000;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('durationMinutes must be positive');
  const limit = preferences.pageSize ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('Request between 1 and 250 suggested slots');
  const startHour = preferences.startHour ?? '00:00', endHour = preferences.endHour ?? '24:00';
  const minutes = (value: string, allow24 = false) => {
    if (allow24 && value === '24:00') return 1440;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Working hours must use HH:mm (24-hour time)');
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  };
  const first = minutes(startHour), last = minutes(endHour, true);
  if (last <= first) throw new Error('Preferred endHour must be after startHour');
  const sorted = busy.slice().sort((a, b) => a.start - b.start);
  const slots: Array<{ start: string; end: string }> = [];
  let day = Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(zone).toPlainDate();
  const finalDay = Temporal.Instant.fromEpochMilliseconds(end).toZonedDateTimeISO(zone).toPlainDate();
  while (Temporal.PlainDate.compare(day, finalDay) <= 0 && slots.length < limit) {
    if (!preferences.excludeWeekends || day.dayOfWeek <= 5) {
      const dayStart = Number(day.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(startHour) }).epochMilliseconds);
      const dayEnd = last === 1440 ? Number(day.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds) : Number(day.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(endHour) }).epochMilliseconds);
      let cursor = Math.max(start, dayStart);
      const boundary = Math.min(end, dayEnd);
      for (const interval of [...sorted.filter(b => b.end > cursor && b.start < boundary), { start: boundary, end: boundary }]) {
        const gapEnd = Math.min(boundary, interval.start);
        while (cursor + duration <= gapEnd && slots.length < limit) {
          slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString() });
          cursor += duration;
        }
        cursor = Math.max(cursor, interval.end);
        if (cursor >= boundary || slots.length >= limit) break;
      }
    }
    day = day.add({ days: 1 });
  }
  return slots;
}
