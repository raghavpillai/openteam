import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { routePlaces, searchNearbyPlaces, searchPlaces, type Fetcher } from "./places";

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
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export const tools: Tool[] = [
  {
    name: "SearchPlaces",
    description:
      "Find real places and geocode names or addresses with OpenStreetMap (Photon). Include the city or address to tell branches apart; pass latitude and longitude together to prefer results near a point. Returns places with ids, verified coordinates, addresses and OpenStreetMap links, ready for a SendToUser presentation. No ratings or photos. The query is sent to Photon.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500, description: "A place name, landmark or address." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 5." },
        latitude,
        longitude,
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
      "Find places of a kind near a point with OpenStreetMap (Nominatim), such as \"thai restaurant\", \"coffee\" or \"pharmacy\". Pass the center's latitude and longitude; geocode a named area or landmark with SearchPlaces first. Returns places nearest first, with distance, cuisine, website, phone and opening hours. Pass the area's IANA timeZone to get openNow, and openNow:true to keep only open places. No ratings, reviews or photos. The query and search area are sent to Nominatim.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "What to find: a kind of place, a cuisine or a name." },
        latitude,
        longitude,
        radiusMeters: { type: "integer", minimum: 100, maximum: 20000, description: "Search radius. Default 1500." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 10." },
        openNow: { type: "boolean", description: "Only places whose hours show them open now. Needs timeZone." },
        timeZone: { type: "string", minLength: 1, maxLength: 64, description: "The area's IANA time zone, e.g. America/New_York." },
      },
      required: ["query", "latitude", "longitude"],
      additionalProperties: false,
    },
    annotations: read,
    run: (args, fetcher, signal) => searchNearbyPlaces(args, fetcher, signal),
  },
  {
    name: "RoutePlaces",
    description:
      "Compute a real walking, cycling or driving route through 2–10 places in visit order with Valhalla (OpenStreetMap). Returns the route with an id to pass as a SendToUser place_map route, plus total and per-leg distance and duration and turn instructions. Never draw straight lines and call them directions. Stop coordinates are sent to Valhalla.",
    inputSchema: {
      type: "object",
      properties: {
        places: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          description: "Stops in visit order, e.g. places from SearchPlaces or SearchNearbyPlaces.",
          items: {
            type: "object",
            properties: { id: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string" }, latitude, longitude },
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
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "OpenStreetMap tool failed" }],
    };
  }
}

export async function serveOpenStreetMap() {
  const server = new Server({ name: "openteam-openstreetmap", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callTool(request.params.name, request.params.arguments, fetch, extra.signal)
  );
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await serveOpenStreetMap();
