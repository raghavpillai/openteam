import { ApiError } from "@openteam/contracts";
import {
  PlaceRouteSchema,
  PlaceSchema,
  presentationReferences,
  resolvePresentationReferences,
  type Place,
  type PlaceRoute,
} from "@openteam/contracts/presentation";
import type { PrismaClient } from "@openteam/db";

type Client = Pick<PrismaClient, "$queryRaw">;
type Found = { places: Map<string, Place>; routes: Map<string, PlaceRoute> };

/** Adds one stored index (the Bot computer's `presentationReferences` for a plugin result) to
 * `found`, keeping the first, newest, object per id. */
export function addIndexed(index: unknown, wanted: ReadonlySet<string>, found: Found): void {
  const record = (index ?? {}) as { places?: unknown; routes?: unknown };
  for (const value of Array.isArray(record.places) ? record.places : []) {
    const id = (value as { id?: unknown })?.id;
    if (typeof id !== "string" || !wanted.has(id) || found.places.has(id)) continue;
    const place = PlaceSchema.safeParse(value);
    if (place.success) found.places.set(id, place.data);
  }
  for (const value of Array.isArray(record.routes) ? record.routes : []) {
    const id = (value as { id?: unknown })?.id;
    if (typeof id !== "string" || !wanted.has(id) || found.routes.has(id)) continue;
    const route = PlaceRouteSchema.safeParse(value);
    if (route.success) found.routes.set(id, route.data);
  }
}

const like = (id: string) => `%${JSON.stringify(id).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Places and routes the Bot computer indexed from plugin results in the last day, for the sending
 * bot and its subagents (at any depth), newest first. Only plugin results are indexed, and only their
 * own JSON structure, so a referenced place is always what a places tool returned. */
async function lookup(prisma: Client, botId: string, ids: string[]): Promise<Found> {
  const rows = await prisma.$queryRaw<Array<{ index: unknown }>>`
    WITH RECURSIVE bots("id", "depth") AS (
      SELECT ${botId}::uuid, 0
      UNION
      SELECT s."childBotId", bots."depth" + 1 FROM "Subagent" s JOIN bots ON s."parentBotId" = bots."id" WHERE bots."depth" < 4
    )
    SELECT ri."content"->'result'->'details'->'presentationReferences' AS "index"
    FROM "RunItem" ri
    JOIN "Run" r ON r."id" = ri."runId"
    WHERE r."botId" IN (SELECT "id" FROM bots)
      AND r."createdAt" > CURRENT_TIMESTAMP - INTERVAL '1 day'
      AND ri."kind" = 'tool'
      AND ri."content"->'result'->'details' ? 'presentationReferences'
      AND (ri."content"->'result'->'details'->'presentationReferences')::text LIKE ANY (${ids.map(like)}::text[])
    ORDER BY ri."createdAt" DESC
    LIMIT 200`;
  const found: Found = { places: new Map(), routes: new Map() };
  const wanted = new Set(ids);
  for (const row of rows) {
    addIndexed(row.index, wanted, found);
    if (found.places.size + found.routes.size === wanted.size) break;
  }
  return found;
}

/** Fills in places and routes an agent passed by id. Tool results reach the database a moment after
 * the tool returns, so a missing id is retried briefly before the send is refused. */
export async function resolvePlaceReferences(
  prisma: Client,
  botId: string,
  presentation: unknown,
  { waitMs = 3_000, pollMs = 250, signal }: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<unknown> {
  const references = presentationReferences(presentation);
  const ids = [...references.places, ...references.routes];
  if (!ids.length) return presentation;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await lookup(prisma, botId, ids);
    const missingPlaces = references.places.filter((id) => !found.places.has(id));
    const missingRoutes = references.routes.filter((id) => !found.routes.has(id));
    if (!missingPlaces.length && !missingRoutes.length) return resolvePresentationReferences(presentation, found.places, found.routes);
    if (Date.now() >= deadline || signal?.aborted) {
      const parts = [
        missingPlaces.length ? `places ${missingPlaces.join(", ")}` : "",
        missingRoutes.length ? `routes ${missingRoutes.join(", ")}` : "",
      ].filter(Boolean);
      throw new ApiError(
        400,
        "unknown_presentation_reference",
        `Nothing was sent: no places or routing tool result from the last day has ${parts.join(" or ")}. Use ids exactly as such a tool returned them, call it again, or give the full place object.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
