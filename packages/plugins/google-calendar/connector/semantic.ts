import { Tokenizer } from '@huggingface/tokenizers';
import { createHash } from 'node:crypto';
import { GoogleApi, type Args } from '../../_shared/google';
import { compact } from '../../_shared/reference';
import { normalizeEvent } from './events';

const modelRoot = new URL('../models/potion-base-2M/', import.meta.url);
let loaded: Promise<{ tokenizer: Tokenizer; embeddings: Float32Array; width: number; rows: number }> | undefined;
async function model() {
  return loaded ??= (async () => {
    const [bytes, tokenizerJson, config] = await Promise.all([
      Bun.file(new URL('model.safetensors', modelRoot)).arrayBuffer(),
      Bun.file(new URL('tokenizer.json', modelRoot)).json(),
      Bun.file(new URL('tokenizer_config.json', modelRoot)).json(),
    ]);
    const file = Buffer.from(bytes);
    if (createHash('sha256').update(file).digest('hex') !== 'f95ffde02ad06f63ae38eb9d400038cd5ccaf8411ec3cb650c6025113f96cbb8') throw new Error('Calendar semantic model checksum does not match the packaged reference');
    const size = Number(file.readBigUInt64LE());
    const { embeddings: header } = JSON.parse(file.subarray(8,8+size).toString());
    const offset = 8 + size + header.data_offsets[0];
    if (header.dtype !== 'F32' || header.shape[1] !== 64) throw new Error('Unsupported semantic model format');
    const data = bytes.slice(offset, 8 + size + header.data_offsets[1]);
    return { tokenizer: new Tokenizer(tokenizerJson, config), embeddings: new Float32Array(data), width: header.shape[1], rows: header.shape[0] };
  })();
}
export async function embed(text: string) {
  const { tokenizer, embeddings, width, rows } = await model();
  const ids = tokenizer.encode(text.slice(0, 32_000), { add_special_tokens: false }).ids;
  const vector = new Float32Array(width);
  for (const id of ids) {
    if (id < 0 || id >= rows) continue;
    for (let j = 0; j < width; j++) vector[j] = vector[j]! + embeddings[id * width + j]!;
  }
  const norm = Math.sqrt(vector.reduce((sum,x) => sum + x*x,0));
  if (norm) for (let j=0; j<width; j++) vector[j] = vector[j]! / norm;
  return vector;
}
export const similarity = (a: Float32Array, b: Float32Array) => a.reduce((sum,x,i) => sum + x*b[i]!, 0);
export function semanticSearch(api: GoogleApi) {
  type Index = { events: Map<string, any>; vectors: Map<string, { revision: string; vector: Float32Array }>; syncToken?: string };
  const indexes = new Map<string, Index>();
  const syncing = new Map<string, Promise<Index>>();
  const synchronize = (calendarId: string): Promise<Index> => {
    const pending = syncing.get(calendarId);
    if (pending) return pending;
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const previous = indexes.get(calendarId);
        const index: Index = { events: new Map(previous?.syncToken ? previous.events : []), vectors: new Map(previous?.vectors), syncToken: previous?.syncToken };
        let cursor: string | undefined;
        try {
          do {
            const page = await api.request(`/calendars/${encodeURIComponent(calendarId)}/events`, { maxResults: 2500, singleEvents: false, showDeleted: true, pageToken: cursor, syncToken: previous?.syncToken });
            for (const event of page.items ?? []) {
              if (event.status === 'cancelled') { index.events.delete(event.id); index.vectors.delete(event.id); }
              else index.events.set(event.id, event);
            }
            cursor = page.nextPageToken;
            if (!cursor) index.syncToken = page.nextSyncToken;
            if (index.events.size > 100_000) throw new Error('Calendar has more than 100,000 indexed events. Use list_events with a date range.');
          } while (cursor);
          indexes.set(calendarId, index);
          return index;
        } catch (error) {
          if (attempt === 0 && previous?.syncToken && String(error).includes('410')) { indexes.delete(calendarId); continue; }
          throw error;
        }
      }
      throw new Error('Calendar search index could not be rebuilt');
    })();
    syncing.set(calendarId, task);
    void task.finally(() => syncing.delete(calendarId)).catch(() => {});
    return task;
  };
  return async (args: Args) => {
    if (!args.query?.trim()) throw new Error('A nonempty search query is required');
    const calendarId = args.calendarId ?? 'primary';
    const index = await synchronize(calendarId);
    const query = await embed(args.query);
    const matches: Array<{ event: any; score: number }> = [];
    for (const event of index.events.values()) {
      if (args.timeMin && Date.parse(event.end?.dateTime ?? event.end?.date) <= Date.parse(args.timeMin)) continue;
      if (args.timeMax && Date.parse(event.start?.dateTime ?? event.start?.date) >= Date.parse(args.timeMax)) continue;
      const text = [event.summary, event.description, event.location, ...(event.attendees ?? []).map((p: any) => `${p.displayName ?? ''} ${p.email ?? ''}`)].filter(Boolean).join('\n');
      if (!text) continue;
      const revision = event.etag ?? text;
      let cached = index.vectors.get(event.id);
      if (!cached || cached.revision !== revision) { cached = { revision, vector: await embed(text) }; index.vectors.set(event.id, cached); }
      const score = similarity(query, cached.vector);
      const exact = text.toLowerCase().includes(args.query.toLowerCase());
      if (score >= 0.25 || exact) matches.push({ event, score: exact ? Math.max(score,0.85) : score });
    }
    matches.sort((a,b) => b.score-a.score || String(a.event.id).localeCompare(String(b.event.id)));
    const fingerprint = createHash('sha256').update(JSON.stringify({ calendarId, query: args.query, timeMin: args.timeMin, timeMax: args.timeMax })).digest('hex').slice(0,16);
    let offset = 0;
    if (args.pageToken) {
      let decoded: any; try { decoded = JSON.parse(Buffer.from(args.pageToken,'base64url').toString()); } catch { throw new Error('Invalid semantic search page token'); }
      if (decoded.query !== fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error('Page token belongs to another query');
      offset = decoded.offset;
    }
    const limit = args.pageSize ?? args.maxResults ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('pageSize must be between 1 and 250');
    const events = matches.slice(offset,offset+limit).map(({event,score}) => ({ ...normalizeEvent(event), relevanceScore: Number(score.toFixed(4)) }));
    return compact({ events, items: events, nextPageToken: offset+events.length < matches.length ? Buffer.from(JSON.stringify({ query: fingerprint, offset: offset+events.length })).toString('base64url') : undefined,
      searchMode: 'localSemantic', indexedEvents: index.events.size, model: 'minishlab/potion-base-2M', indexComplete: true });
  };
}
