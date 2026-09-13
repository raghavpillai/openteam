import { GoogleApi, page, segment, servePlugin, string, strings, type Args, type Tool } from '../../_shared/google';
import { compact, referenceTool } from '../../_shared/reference';
import { eventBody, eventTypes, normalizeEvent, notification } from './events';
import { availableSlots, instant, resolveZone } from './time';
import { semanticSearch } from './semantic';

const legacyEvent = {
  type: 'object', minProperties: 1, additionalProperties: false,
  properties: {
    summary: string('Event title'), description: string('Description'), location: string('Location'),
    start: { type: 'object', properties: { date: string('YYYY-MM-DD'), dateTime: string('RFC3339 time'), timeZone: string('IANA timezone') }, oneOf: [{ required: ['date'] }, { required: ['dateTime'] }], additionalProperties: false },
    end: { type: 'object', properties: { date: string('YYYY-MM-DD'), dateTime: string('RFC3339 time'), timeZone: string('IANA timezone') }, oneOf: [{ required: ['date'] }, { required: ['dateTime'] }], additionalProperties: false },
    attendees: { type: 'array', items: { type: 'object', properties: { email: string('Email'), optional: { type: 'boolean' } }, required: ['email'], additionalProperties: false } },
    recurrence: strings('RFC5545 rules'),
  },
};
const sendUpdates = string('Legacy notification setting. Legacy event payloads default to none; reference inputs default to all.', { enum: ['none', 'all', 'externalOnly'] });
const legacySearch = { query: string('Legacy full-text query'), timeMin: string('Legacy start time'), timeMax: string('Legacy end time'), maxResults: page.maxResults };

export function calendarTools(api = new GoogleApi('https://www.googleapis.com/calendar/v3')): Tool[] {
  const ref = (name: string, run: Tool['run'], options: Parameters<typeof referenceTool>[3] = {}) => referenceTool('calendar', name, run, options);
  const searchSemantic = semanticSearch(api);
  const events = (id?: string) => `/calendars/${segment(id ?? 'primary')}/events`;
  const list = async (a: Args) => {
    const zone = a.timeZone ?? ((a.startTime || a.endTime) && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(a.startTime ?? a.endTime) ? await resolveZone(api, a) : 'UTC');
    const query = { q: a.fullText ?? a.query, timeMin: a.startTime ? new Date(instant(a.startTime, zone)).toISOString() : a.timeMin,
      timeMax: a.endTime ? new Date(instant(a.endTime, zone)).toISOString() : a.timeMax, timeZone: a.timeZone,
      singleEvents: true, orderBy: a.orderBy === 'lastModified' ? 'updated' : a.orderBy === 'default' || !a.orderBy ? undefined : 'startTime',
      maxResults: a.pageSize ?? a.maxResults ?? 100, pageToken: a.pageToken,
      eventTypes: (a.eventType?.length ? a.eventType : a.eventTypeFilter?.length ? a.eventTypeFilter : ['DEFAULT','OUT_OF_OFFICE','FOCUS_TIME','FROM_GMAIL']).map((t: string) => eventTypes[t] ?? t),
    };
    if (a.orderBy === 'startTimeDesc') {
      // Google REST has no descending start-time order. Materialize a finite range before sorting.
      if (!query.timeMax) throw new Error('startTimeDesc requires endTime to bound recurring events');
      let cursor: string | undefined;
      const all: any[] = [];
      do {
        const value = await api.request(events(a.calendarId), { ...query, pageToken: cursor, maxResults: 2500, orderBy: 'startTime' });
        all.push(...(value.items ?? [])); cursor = value.nextPageToken;
        if (all.length > 100_000) throw new Error('Too many events for descending order; narrow the time range');
      } while (cursor);
      all.reverse();
      const offset = a.pageToken ? Number(Buffer.from(a.pageToken, 'base64url').toString()) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid pagination token');
      const selected = all.slice(offset, offset + query.maxResults).map(normalizeEvent);
      return compact({ events: selected, items: selected, nextPageToken: offset + selected.length < all.length ? Buffer.from(String(offset + selected.length)).toString('base64url') : undefined });
    }
    const value = await api.request(events(a.calendarId), query);
    const normalized = (value.items ?? []).map(normalizeEvent);
    return compact({ ...value, items: normalized, events: normalized });
  };
  return [
    ref('list_calendars', async a => {
      const value = await api.request('/users/me/calendarList', { maxResults: a.pageSize ?? a.maxResults ?? 100, pageToken: a.pageToken });
      return { ...value, calendars: value.items ?? [] };
    }, { properties: { maxResults: page.maxResults } }),
    ref('list_events', a => list(a), { properties: legacySearch }),
    ref('search_events', a => searchSemantic(a), { properties: { ...legacySearch, calendarId: string('Calendar ID; defaults to primary') }, description: 'Search calendar events by meaning using a bundled local English embedding model. Searches the primary calendar by default and ranks the account’s complete accessible event inventory. No model API key is needed. Use list_events for exact keyword/date filters.' }),
    ref('get_event', async a => normalizeEvent(await api.request(`${events(a.calendarId)}/${segment(a.eventId)}`))),
    ref('create_event', async a => {
      if (a.event && (!a.event.summary || !a.event.start || !a.event.end)) throw new Error('Legacy event requires summary, start and end');
      const body = await eventBody(api, a);
      const result = await api.request(events(a.calendarId), { sendUpdates: notification(a), supportsAttachments: true, conferenceDataVersion: 1 }, 'POST', body);
      return normalizeEvent(result);
    }, { risk: 'write', properties: { sendUpdates, event: legacyEvent }, required: [], anyOf: [{ required: ['summary', 'startTime', 'endTime'] }, { required: ['event'] }] }),
    ref('update_event', async a => {
      const path = `${events(a.calendarId)}/${segment(a.eventId)}`;
      const existing = await api.request(path);
      const body = await eventBody(api, a, existing);
      if (!Object.keys(body).length) throw new Error('Specify at least one event field to update');
      return normalizeEvent(await api.request(path, { sendUpdates: notification(a), supportsAttachments: true, conferenceDataVersion: 1 }, 'PATCH', body, { headers: existing.etag ? { 'If-Match': existing.etag } : {} }));
    }, { risk: 'write', properties: { sendUpdates, event: legacyEvent } }),
    ref('delete_event', a => api.request(`${events(a.calendarId)}/${segment(a.eventId)}`, { sendUpdates: notification(a) }, 'DELETE'), { risk: 'destructive', properties: { sendUpdates } }),
    ref('respond_to_event', async a => {
      const path = `${events(a.calendarId)}/${segment(a.eventId)}`;
      const event = await api.request(path);
      if (!event.attendees?.some((p: any) => p.self)) throw new Error('This account is not an attendee on the event');
      const response = a.responseStatus ?? a.response;
      if (!['accepted', 'declined', 'tentative', 'needsAction'].includes(response)) throw new Error('Invalid RSVP response');
      return normalizeEvent(await api.request(path, { sendUpdates: notification(a) }, 'PATCH', { attendees: event.attendees.map((p: any) => p.self ? compact({ ...p, responseStatus: response, comment: a.responseComment ?? p.comment }) : p) }, { headers: event.etag ? { 'If-Match': event.etag } : {} }));
    }, { risk: 'write', properties: { sendUpdates, response: string('Legacy RSVP', { enum: ['accepted', 'declined', 'tentative', 'needsAction'] }) }, required: ['eventId'], anyOf: [{ required: ['responseStatus'] }, { required: ['response'] }] }),
    ref('suggest_time', async a => {
      const zone = await resolveZone(api, a, true);
      const start = instant(a.startTime ?? a.timeMin, zone), end = instant(a.endTime ?? a.timeMax, zone);
      if (end <= start || end - start > 366 * 86400_000) throw new Error('Use a valid time window of at most one year');
      const ids: string[] = [...new Set<string>(a.attendeeEmails ?? (a.calendarIds?.length ? a.calendarIds : ['primary']))];
      if (!ids.length || ids.length > 50) throw new Error('Check between 1 and 50 calendars');
      const result = await api.request('/freeBusy', {}, 'POST', { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone: zone, items: ids.map(id => ({ id })) });
      const busy: Array<{ start: number; end: number }> = [];
      for (const id of ids) {
        const calendar = result.calendars?.[id];
        if (!calendar || calendar.errors?.length) throw new Error(`Free/busy unavailable for ${id}. No availability was inferred.`);
        for (const b of calendar.busy ?? []) {
          const interval = { start: Date.parse(b.start), end: Date.parse(b.end) };
          if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) throw new Error('Provider returned an invalid busy interval');
          busy.push(interval);
        }
      }
      const suggestions = availableSlots(start, end, busy, a.durationMinutes ?? 30, zone, { ...a.preferences, pageSize: a.preferences?.pageSize ?? a.maxResults ?? 5 });
      return { suggestions, calendarIds: ids, timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeSlots: suggestions.map(s => ({ start: { dateTime: s.start, timeZone: zone }, end: { dateTime: s.end, timeZone: zone }, startTime: s.start, endTime: s.end, durationMinutes: a.durationMinutes ?? 30 })) };
    }, { properties: { calendarIds: strings('Legacy calendar IDs'), timeMin: string('Legacy start time'), timeMax: string('Legacy end time'), maxResults: page.maxResults }, required: [], anyOf: [{ required: ['attendeeEmails', 'startTime', 'endTime'] }, { required: ['timeMin', 'timeMax'] }] }),
  ];
}
if (import.meta.main) await servePlugin('openteam-google-calendar', calendarTools());
