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

/** Collects the places and routes named in `wanted` from one stored tool result. Results often
 * arrive as JSON text (MCP content), so JSON-looking strings are parsed and searched as well. */
export function collectReferences(value: unknown, wanted: ReadonlySet<string>, found: Found, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 4_000_000 || !/^[[{]/.test(text)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    return collectReferences(parsed, wanted, found, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, wanted, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && wanted.has(record.id)) {
    if (!found.places.has(record.id)) {
      const place = PlaceSchema.safeParse(record);
      if (place.success) found.places.set(record.id, place.data);
    }
    if (!found.routes.has(record.id)) {
      const route = PlaceRouteSchema.safeParse(record);
      if (route.success) found.routes.set(record.id, route.data);
    }
  }
  for (const child of Object.values(record)) collectReferences(child, wanted, found, depth + 1);
}

const like = (id: string) => `%${id.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Tool results from the sending bot's and its subagents' runs in the last day, newest first. Only
 * results are searched, never arguments the agent wrote, so referenced data is what a tool returned. */
async function lookup(prisma: Client, botId: string, ids: string[]): Promise<Found> {
  const rows = await prisma.$queryRaw<Array<{ result: unknown }>>`
    SELECT ri."content"->'result' AS "result"
    FROM "RunItem" ri
    JOIN "Run" r ON r."id" = ri."runId"
    WHERE (r."botId" = ${botId}::uuid OR r."botId" IN (SELECT "childBotId" FROM "Subagent" WHERE "parentBotId" = ${botId}::uuid))
      AND r."createdAt" > CURRENT_TIMESTAMP - INTERVAL '1 day'
      AND ri."kind" = 'tool'
      AND (ri."content"->'result')::text LIKE ANY (${ids.map(like)}::text[])
    ORDER BY ri."createdAt" DESC
    LIMIT 40`;
  const found: Found = { places: new Map(), routes: new Map() };
  const wanted = new Set(ids);
  for (const row of rows) collectReferences(row.result, wanted, found);
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
        `Nothing was sent: no tool result in this conversation has ${parts.join(" or ")}. Use ids exactly as a tool returned them, call the tool again, or give the full place object.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
