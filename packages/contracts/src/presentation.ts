import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const url = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  }, "A public HTTPS URL without credentials is required");
export const PlaceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: text,
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  address: text.optional(),
  category: text.optional(),
  icon: z.string().max(80).optional(),
  description: text.optional(),
  notes: text.optional(),
  imageUrl: url.optional(),
  websiteUrl: url.optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  isOpen: z.boolean().optional(),
  hours: text.optional(),
  // A blank provider is treated as absent rather than shown as an empty label.
  provider: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().trim().max(200).optional()
  ),
  sourceUrl: url.optional(),
  attribution: text.optional(),
});
export type Place = z.infer<typeof PlaceSchema>;
const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export const PlaceRouteSchema = z.object({
  /** Set by routing tools so the agent can pass the route back by reference. */
  id: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(["walking", "driving", "cycling"]),
  geometry: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(coordinate).min(2).max(20000),
  }),
  distanceMeters: z.number().finite().nonnegative(),
  durationSeconds: z.number().finite().nonnegative(),
  legs: z
    .array(
      z.object({
        fromPlaceId: z.string(),
        toPlaceId: z.string(),
        distanceMeters: z.number().finite().nonnegative(),
        durationSeconds: z.number().finite().nonnegative(),
        instructions: z.array(text).max(200).optional(),
      })
    )
    .max(49),
  provider: text.optional(),
  sourceUrl: url.optional(),
  attribution: text.optional(),
});
export type PlaceRoute = z.infer<typeof PlaceRouteSchema>;
// Not trimmed: a reference must match the place ids blocks name, exactly.
const id = z.string().min(1).max(200);
/** An agent may name a place a tool returned instead of copying it, optionally adding its own words. */
const PlaceReferenceSchema = z.union([
  id,
  z.object({ id, notes: text.optional(), description: text.optional(), icon: z.string().max(80).optional() }).strict(),
]);
export type PlaceReference = z.infer<typeof PlaceReferenceSchema>;
const placeIdOf = (place: Place | PlaceReference) => (typeof place === "string" ? place : place.id);

function presentationSchema<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(placeItem: P, route: R) {
  const mapBlock = z.object({
    type: z.literal("place_map"),
    title: text.optional(),
    placeIds: z.array(z.string()).min(1).max(50),
    carousel: z.enum(["auto", "hidden"]).default("auto"),
    route: route.optional(),
  });
  const listBlock = z.object({
    type: z.literal("ranked_media_list"),
    title: text.optional(),
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          title: text,
          description: text.optional(),
          imageUrl: url.optional(),
          href: url.optional(),
          placeId: z.string().optional(),
          sourceLabel: text.optional(),
          sourceUrl: url.optional(),
        })
      )
      .min(1)
      .max(50),
  });
  return z
    .object({
      version: z.literal(1),
      places: z.array(placeItem).max(50).default([]),
      blocks: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("markdown"), text: z.string().trim().min(1).max(20000) }),
            mapBlock,
            listBlock,
          ])
        )
        .min(1)
        .max(20),
    })
    .superRefine((value: any, ctx) => {
      const ids = new Set<string>();
      value.places.forEach((place: Place | PlaceReference, i: number) => {
        const placeId = placeIdOf(place);
        if (ids.has(placeId))
          ctx.addIssue({ code: "custom", path: ["places", i, "id"], message: "Place ids must be unique" });
        ids.add(placeId);
      });
      value.blocks.forEach((block: any, i: number) => {
        const refs: string[] =
          block.type === "place_map"
            ? block.placeIds
            : block.type === "ranked_media_list"
              ? block.items.flatMap((item: any) => (item.placeId ? [item.placeId] : []))
              : [];
        refs.forEach((placeId) => {
          if (!ids.has(placeId))
            ctx.addIssue({ code: "custom", path: ["blocks", i], message: `Unknown place id: ${placeId}` });
        });
        if (block.type !== "place_map") return;
        if (new Set(block.placeIds).size !== block.placeIds.length)
          ctx.addIssue({ code: "custom", path: ["blocks", i], message: "Map stops must be unique" });
        const legs = block.route && typeof block.route === "object" ? block.route.legs : null;
        if (
          block.route &&
          (block.placeIds.length < 2 ||
            (legs &&
              (legs.length !== block.placeIds.length - 1 ||
                legs.some(
                  (leg: any, index: number) =>
                    leg.fromPlaceId !== block.placeIds[index] || leg.toPlaceId !== block.placeIds[index + 1]
                ))))
        )
          ctx.addIssue({ code: "custom", path: ["blocks", i, "route"], message: "Route legs must connect each map stop in order" });
      });
    });
}
/** A delivered presentation: every place and route is complete. */
export const PresentationSchema = presentationSchema(PlaceSchema, PlaceRouteSchema);
export type Presentation = z.infer<typeof PresentationSchema>;
/** What an agent may send: places and routes by reference, resolved before delivery. */
export const PresentationInputSchema = presentationSchema(z.union([PlaceSchema, PlaceReferenceSchema]), z.union([id, PlaceRouteSchema]));
export type PresentationInput = z.infer<typeof PresentationInputSchema>;
export const PresentationSendSchema = z
  .object({
    type: z.literal("presentation"),
    presentation: PresentationInputSchema,
    end_turn: z.boolean().optional(),
    reply_to: z.string().optional(),
  })
  .strict();

/** The place and route ids an agent input names instead of including. */
export function presentationReferences(input: unknown): { places: string[]; routes: string[] } {
  const value = (input ?? {}) as Record<string, any>;
  const places = (Array.isArray(value.places) ? value.places : []).flatMap((place: any) =>
    typeof place === "string" ? [place] : place && typeof place === "object" && place.latitude === undefined && typeof place.id === "string" ? [place.id] : []
  );
  const routes = (Array.isArray(value.blocks) ? value.blocks : []).flatMap((block: any) =>
    block?.type === "place_map" && typeof block.route === "string" ? [block.route] : []
  );
  return { places: [...new Set<string>(places)], routes: [...new Set<string>(routes)] };
}

/** Replaces references with the tool results they name; the agent's own notes win over the tool's. */
export function resolvePresentationReferences(
  input: unknown,
  places: ReadonlyMap<string, Place>,
  routes: ReadonlyMap<string, PlaceRoute>
): Record<string, unknown> {
  const value = (input ?? {}) as Record<string, any>;
  const resolved = (Array.isArray(value.places) ? value.places : []).map((place: any) => {
    const reference = typeof place === "string" ? { id: place } : place;
    if (!reference || typeof reference !== "object" || reference.latitude !== undefined) return place;
    const found = places.get(reference.id);
    if (!found) return place;
    const { id: _id, ...own } = reference;
    return { ...found, ...own };
  });
  return {
    ...value,
    places: resolved,
    blocks: (Array.isArray(value.blocks) ? value.blocks : []).map((block: any) =>
      block?.type === "place_map" && typeof block.route === "string" && routes.has(block.route)
        ? { ...block, route: routes.get(block.route) }
        : block
    ),
  };
}
export type PlaceMapBlock = Extract<Presentation["blocks"][number], { type: "place_map" }>;
export type RankedMediaBlock = Extract<
  Presentation["blocks"][number],
  { type: "ranked_media_list" }
>;

/** Accept the coordinate/POI envelope used by ChatGPT and common provider tools.
 * Coordinates stay latitude/longitude on places and [longitude,latitude] in GeoJSON.
 * Unknown ratings, hours and imagery remain absent, never synthesized.
 */
export function normalizePlace(value: unknown, index = 0): Place {
  const point = (value ?? {}) as Record<string, any>;
  const entity = point.entity && typeof point.entity === "object" ? point.entity : {};
  const optional = (...values: unknown[]) =>
    values.find((v) => v !== null && v !== undefined && v !== "");
  return PlaceSchema.parse({
    id: optional(point.id, entity.entity_lookup_id, entity.id) ?? `place-${index + 1}`,
    name: optional(point.name, entity.name),
    latitude: optional(point.latitude, entity.latitude),
    longitude: optional(point.longitude, entity.longitude),
    address: optional(point.address, entity.address),
    category: optional(point.category, entity.categories?.[0]),
    icon: point.icon,
    description: optional(point.description, entity.description),
    notes: point.notes,
    imageUrl: optional(point.imageUrl, point.image_url, entity.image_url),
    websiteUrl: optional(point.websiteUrl, entity.website_url),
    rating: optional(point.rating, entity.rating),
    reviewCount: optional(point.reviewCount, entity.review_count),
    isOpen: optional(point.isOpen, point.is_open, entity.is_open),
    hours: optional(point.hours, typeof entity.hours === "string" ? entity.hours : undefined),
    provider: optional(point.provider, entity.provider),
    sourceUrl: optional(point.sourceUrl, entity.provider_url),
    attribution: point.attribution,
  });
}
export const parsePresentation = (value: unknown): Presentation => {
  const input = (value ?? {}) as Record<string, unknown>;
  const unresolved = presentationReferences(input);
  if (unresolved.places.length || unresolved.routes.length)
    throw new Error(`Unresolved references: ${[...unresolved.places, ...unresolved.routes].join(", ")}`);
  return PresentationSchema.parse({
    ...input,
    places: Array.isArray(input.places) ? input.places.map(normalizePlace) : [],
  });
};
export function presentationFallback(presentation: Presentation): string {
  const places = new Map(presentation.places.map((place) => [place.id, place]));
  return presentation.blocks
    .map((block) => {
      if (block.type === "markdown") return block.text;
      if (block.type === "ranked_media_list")
        return [
          block.title,
          ...block.items.map(
            (item, i) =>
              `${i + 1}. ${item.title}${item.description ? ` — ${item.description}` : ""}`
          ),
        ]
          .filter(Boolean)
          .join("\n");
      return [
        block.title ?? "Map",
        ...block.placeIds.map((id) => {
          const place = places.get(id)!;
          return `- ${place.name}${place.address ? ` — ${place.address}` : ""} (${place.latitude}, ${place.longitude})`;
        }),
      ].join("\n");
    })
    .join("\n\n");
}

// The JSON schema describes the agent input; runtime validation above enforces
// cross-references and coordinate ranges as well as these structural limits.
const placeProperties: Record<string, unknown> = {
  id: { type: "string" },
  name: { type: "string" },
  latitude: { type: "number", minimum: -90, maximum: 90 },
  longitude: { type: "number", minimum: -180, maximum: 180 },
};
for (const key of [
  "address",
  "category",
  "icon",
  "description",
  "notes",
  "imageUrl",
  "websiteUrl",
  "hours",
  "provider",
  "sourceUrl",
  "attribution",
])
  placeProperties[key] = { type: "string" };
placeProperties.rating = { type: "number", minimum: 0, maximum: 5 };
placeProperties.reviewCount = { type: "integer", minimum: 0 };
placeProperties.isOpen = { type: "boolean" };
export const placeInputJsonSchema = {
  type: "object",
  properties: placeProperties,
  required: ["id", "name", "latitude", "longitude"],
  additionalProperties: false,
};
export const presentationInputJsonSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    places: {
      type: "array",
      maxItems: 50,
      items: {
        anyOf: [
          { type: "string", description: "Id of a place a tool returned in this conversation" },
          {
            type: "object",
            properties: { id: { type: "string" }, notes: { type: "string" }, description: { type: "string" }, icon: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          placeInputJsonSchema,
        ],
      },
    },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        oneOf: [
          {
            type: "object",
            properties: { type: { type: "string", enum: ["markdown"] }, text: { type: "string" } },
            required: ["type", "text"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["place_map"] },
              title: { type: "string" },
              placeIds: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
              carousel: { type: "string", enum: ["auto", "hidden"] },
              route: {
                anyOf: [
                  { type: "string", description: "Route id a routing tool returned" },
                  { type: "object", description: "A routing tool's route object, unchanged" },
                ],
              },
            },
            required: ["type", "placeIds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { type: "string", enum: ["ranked_media_list"] },
              title: { type: "string" },
              items: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: {
                  type: "object",
                  properties: Object.fromEntries(
                    [
                      "id",
                      "title",
                      "description",
                      "imageUrl",
                      "href",
                      "placeId",
                      "sourceLabel",
                      "sourceUrl",
                    ].map((k) => [k, { type: "string" }])
                  ),
                  required: ["id", "title"],
                  additionalProperties: false,
                },
              },
            },
            required: ["type", "items"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["version", "blocks"],
  additionalProperties: false,
};

/** What a plugin tool returned that a presentation may name by id. */
export type PresentationReferenceIndex = { places: Place[]; routes: PlaceRoute[] };
/** Collects the places and routes in a plugin tool's JSON text result, so an agent can name them by
 * id instead of copying them. Only the tool's own JSON structure counts: text inside it (a page, an
 * email body) is never parsed, so content a tool merely relays can't pose as a verified place. */
export function presentationReferencesInResult(texts: readonly string[]): PresentationReferenceIndex | undefined {
  const places = new Map<string, Place>(),
    routes = new Map<string, PlaceRoute>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") {
      if (typeof record.latitude === "number" && !places.has(record.id) && places.size < 100) {
        const place = PlaceSchema.safeParse(record);
        if (place.success) places.set(record.id, place.data);
      } else if (record.geometry && !routes.has(record.id) && routes.size < 10) {
        const route = PlaceRouteSchema.safeParse(record);
        if (route.success) routes.set(record.id, route.data);
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  for (const text of texts) {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed) || trimmed.length > 8_000_000) continue;
    try {
      visit(JSON.parse(trimmed), 0);
    } catch {}
  }
  return places.size || routes.size ? { places: [...places.values()], routes: [...routes.values()] } : undefined;
}
