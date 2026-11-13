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
const mapBlock = z.object({
  type: z.literal("place_map"),
  title: text.optional(),
  placeIds: z.array(z.string()).min(1).max(50),
  carousel: z.enum(["auto", "hidden"]).default("auto"),
  route: PlaceRouteSchema.optional(),
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
export const PresentationSchema = z
  .object({
    version: z.literal(1),
    places: z.array(PlaceSchema).max(50).default([]),
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
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.places.forEach((place, i) => {
      if (ids.has(place.id))
        ctx.addIssue({
          code: "custom",
          path: ["places", i, "id"],
          message: "Place ids must be unique",
        });
      ids.add(place.id);
    });
    value.blocks.forEach((block, i) => {
      const refs =
        block.type === "place_map"
          ? block.placeIds
          : block.type === "ranked_media_list"
            ? block.items.flatMap((item) => (item.placeId ? [item.placeId] : []))
            : [];
      refs.forEach((id) => {
        if (!ids.has(id))
          ctx.addIssue({ code: "custom", path: ["blocks", i], message: `Unknown place id: ${id}` });
      });
      if (block.type === "place_map") {
        if (new Set(block.placeIds).size !== block.placeIds.length)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i],
            message: "Map stops must be unique",
          });
        if (
          block.route &&
          (block.placeIds.length < 2 ||
            block.route.legs.length !== block.placeIds.length - 1 ||
            block.route.legs.some(
              (leg, index) =>
                leg.fromPlaceId !== block.placeIds[index] ||
                leg.toPlaceId !== block.placeIds[index + 1]
            ))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i, "route"],
            message: "Route legs must connect each map stop in order",
          });
      }
    });
  });
export type Presentation = z.infer<typeof PresentationSchema>;
export const PresentationSendSchema = z
  .object({
    type: z.literal("presentation"),
    presentation: PresentationSchema,
    end_turn: z.boolean().optional(),
    reply_to: z.string().optional(),
  })
  .strict();
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
const routeProperties = {
  mode: { type: "string", enum: ["walking", "driving", "cycling"] },
  geometry: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["LineString"] },
      coordinates: {
        type: "array",
        minItems: 2,
        maxItems: 20000,
        items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
      },
    },
    required: ["type", "coordinates"],
  },
  distanceMeters: { type: "number" },
  durationSeconds: { type: "number" },
  legs: {
    type: "array",
    items: {
      type: "object",
      properties: {
        fromPlaceId: { type: "string" },
        toPlaceId: { type: "string" },
        distanceMeters: { type: "number" },
        durationSeconds: { type: "number" },
        instructions: { type: "array", items: { type: "string" } },
      },
      required: ["fromPlaceId", "toPlaceId", "distanceMeters", "durationSeconds"],
    },
  },
  provider: { type: "string" },
  sourceUrl: { type: "string" },
  attribution: { type: "string" },
};
export const presentationInputJsonSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    places: { type: "array", maxItems: 50, items: placeInputJsonSchema },
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
                type: "object",
                properties: routeProperties,
                required: ["mode", "geometry", "distanceMeters", "durationSeconds", "legs"],
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
