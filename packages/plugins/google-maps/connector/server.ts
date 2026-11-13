import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { checkKey, getPlaceDetails, routePlaces, searchNearbyPlaces, searchPlaces, type Fetcher } from "./google";

type Schema = { type: "object"; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean };
export type Tool = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: true };
  run: (args: any, fetcher: Fetcher, signal?: AbortSignal) => Promise<unknown>;
};

const latitude = { type: "number", minimum: -90, maximum: 90 };
const longitude = { type: "number", minimum: -180, maximum: 180 };
const minRating = { type: "number", minimum: 0, maximum: 5, description: "Only places rated at least this (0.5 steps)." };
const photos = { type: "boolean", description: "Include one photo per place for map cards (default true). Turn off only for shortlists you won't show." };
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export const tools: Tool[] = [
  {
    name: "SearchPlaces",
    description:
      "Search Google Maps for places by name, address or description, such as \"Penn Station\", \"Zuni Café San Francisco\" or \"best ramen in Shibuya\". Pass latitude and longitude to prefer results near a point. Returns places ready for a SendToUser presentation, with Google rating, review count, price level, today's hours, open-now, website, phone and a photo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500 },
        latitude,
        longitude,
        radiusMeters: { type: "integer", minimum: 100, maximum: 50000, description: "Bias radius around the point. Default 5000." },
        openNow: { type: "boolean", description: "Only places open right now." },
        minRating,
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 8." },
        photos,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: read,
    run: (args, fetcher, signal) => searchPlaces(args, fetcher, signal),
  },
  {
    name: "SearchNearbyPlaces",
    description:
      "Find places of a kind within a radius of a point on Google Maps, such as \"thai restaurant\", \"coffee\" or \"pharmacy\". Pass the center's latitude and longitude; find a named area or landmark with SearchPlaces first. Returns places inside the radius with distance, Google rating, review count, price level, today's hours, open-now, website, phone and a photo. rankBy: \"relevance\" (default, Google's ranking) or \"distance\".",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "What to find: a kind of place, a cuisine or a dish." },
        latitude,
        longitude,
        radiusMeters: { type: "integer", minimum: 100, maximum: 50000, description: "Default 1500." },
        openNow: { type: "boolean", description: "Only places open right now." },
        minRating,
        rankBy: { type: "string", enum: ["relevance", "distance"] },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 10." },
        photos,
      },
      required: ["query", "latitude", "longitude"],
      additionalProperties: false,
    },
    annotations: read,
    run: (args, fetcher, signal) => searchNearbyPlaces(args, fetcher, signal),
  },
  {
    name: "GetPlaceDetails",
    description:
      "Read one Google Maps place in depth: up to five recent reviews with their ratings and authors, Google's review summary and overview, the week's opening hours, rating, price level, website, phone and a photo. Pass the place id from SearchPlaces or SearchNearbyPlaces (with or without its google: prefix).",
    inputSchema: {
      type: "object",
      properties: { placeId: { type: "string", minLength: 10, maxLength: 320 }, photos },
      required: ["placeId"],
      additionalProperties: false,
    },
    annotations: read,
    run: (args, fetcher, signal) => getPlaceDetails(args, fetcher, signal),
  },
  {
    name: "CheckGoogleMapsKey",
    description:
      "Check whether this account's Google Maps API key works for both Places API (New) and Routes API. Returns each API's status and, when one fails, exactly what to fix in Google Cloud (key invalid, API not enabled, key restrictions, billing). Use it when a Google Maps tool fails with a key or permission error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: read,
    run: (_args, fetcher, signal) => checkKey(fetcher, signal),
  },
  {
    name: "RoutePlaces",
    description:
      "Compute a real walking, cycling or driving route through 2–25 places in visit order with Google Maps. Driving uses live traffic. Returns the route for a SendToUser place_map unchanged: GeoJSON [longitude, latitude] geometry, total and per-leg distance and duration, and turn instructions.",
    inputSchema: {
      type: "object",
      properties: {
        places: {
          type: "array",
          minItems: 2,
          maxItems: 25,
          description: "Stops in visit order, e.g. places from SearchPlaces or SearchNearbyPlaces.",
          items: {
            type: "object",
            properties: { id: { type: "string", minLength: 1, maxLength: 320 }, name: { type: "string" }, latitude, longitude },
            required: ["id", "latitude", "longitude"],
          },
        },
        mode: { type: "string", enum: ["walking", "driving", "cycling"] },
      },
      required: ["places", "mode"],
      additionalProperties: false,
    },
    annotations: read,
    run: (args, fetcher, signal) => routePlaces(args, fetcher, signal),
  },
];

const validators = new Map(tools.map((tool) => [tool.name, createToolValidator(tool.inputSchema)]));

/** Runs one tool call; errors come back as text so the Bot can retry or explain. */
export async function callTool(name: string, args: unknown, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  try {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error("Unknown tool");
    const result = validators.get(name)!(args ?? {});
    if (!result.valid) throw new Error(`Invalid tool arguments: ${result.errorMessage}`);
    const value = await tool.run(args ?? {}, fetcher, signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Google Maps tool failed" }],
    };
  }
}

let verifiedAt = 0;
/** Connecting lists tools: prove the key works for both APIs first, so a bad key, a disabled API
 * or a restriction shows up on the account with its fix instead of failing later in chat. Only
 * definitive configuration errors block; an unreachable Google does not. */
export async function listTools(fetcher: Fetcher = fetch, now = Date.now()) {
  if (now - verifiedAt > 30 * 60_000) {
    const check = await checkKey(fetcher);
    const blocking = [check.places, check.routes].filter((entry) => !entry.ok && entry.definitive);
    // An invalid key fails both APIs with the same fix; say it once.
    if (blocking.length) throw new Error([...new Set(blocking.map((entry) => entry.message))].join(" "));
    if (check.ok) verifiedAt = now;
  }
  return tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}
export const resetKeyVerification = () => {
  verifiedAt = 0;
};

export async function serveGoogleMaps() {
  const server = new Server({ name: "openteam-google-maps", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callTool(request.params.name, request.params.arguments, fetch, extra.signal)
  );
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await serveGoogleMaps();
