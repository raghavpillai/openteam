import { z } from "zod";
import {
  PlaceSchema,
  PlaceRouteSchema,
  type Place,
  type PlaceRoute,
} from "@openteam/contracts/presentation";

export type PlaceFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Fetcher = PlaceFetcher;
const searchInput = z
  .object({
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(10).default(5),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();
const routeInput = z
  .object({
    places: z.array(PlaceSchema).min(2).max(10),
    mode: z.enum(["walking", "driving", "cycling"]),
  })
  .strict();
const cache = new Map<string, { expires: number; value: unknown }>();
async function providerJson(url: URL, options: RequestInit, fetcher: Fetcher): Promise<any> {
  const response = await fetcher(url, {
    ...options,
    headers: {
      "user-agent": "OpenTeam/0.0.16 (places and routing)",
      accept: "application/json",
      ...options.headers,
    },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Place provider returned ${response.status}; no coordinates or route were fabricated`
    );
  const body = await response.text();
  if (body.length > 4_000_000) throw new Error("Place provider response is too large");
  return JSON.parse(body);
}
function endpoint(value: string | undefined, fallback: string): URL {
  if (value === "off") throw new Error("Place data provider is turned off");
  const url = new URL(value ?? fallback);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid place provider endpoint");
  return url;
}
/** OSM-backed search: no autocomplete traffic, and no synthetic business metadata. */
export async function searchPlaces(raw: unknown, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  const input = searchInput.parse(raw),
    url = endpoint(process.env.OPENTEAM_GEOCODER_URL, "https://photon.komoot.io/api/");
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(input.limit));
  if (input.latitude !== undefined && input.longitude !== undefined) {
    url.searchParams.set("lat", String(input.latitude));
    url.searchParams.set("lon", String(input.longitude));
  }
  const key = url.href,
    hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const result = await providerJson(url, { signal }, fetcher);
  const places: Place[] = (Array.isArray(result.features) ? result.features : [])
    .slice(0, input.limit)
    .flatMap((feature: any) => {
      const p = feature.properties ?? {},
        coords = feature.geometry?.coordinates;
      if (feature.geometry?.type !== "Point" || !Array.isArray(coords)) return [];
      const kind =
        ({ N: "node", W: "way", R: "relation" } as Record<string, string>)[p.osm_type] ?? "node";
      const address = [
        p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street,
        p.city ?? p.town ?? p.village,
        p.state,
        p.postcode,
        p.country,
      ]
        .filter(Boolean)
        .join(", ");
      if (!p.osm_id || !["N", "W", "R"].includes(p.osm_type)) return [];
      const category = p.osm_value === "yes" ? p.osm_key : p.osm_value;
      const parsed = PlaceSchema.safeParse({
        id: `osm:${kind}:${p.osm_id}`,
        name: p.name ?? p.street ?? address,
        longitude: coords[0],
        latitude: coords[1],
        address: address || undefined,
        category: typeof category === "string" ? category.replaceAll("_", " ") : undefined,
        provider: "OpenStreetMap",
        sourceUrl: `https://www.openstreetmap.org/${kind}/${p.osm_id}`,
        attribution: "© OpenStreetMap contributors",
      });
      return parsed.success ? [parsed.data] : [];
    });
  const value = {
    places,
    provider: "Photon / OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    fetchedAt: new Date().toISOString(),
    instruction:
      "Verify the name, city and address before choosing a result, including when only one result is returned. Retry with a more specific address or location bias if it is a different branch.",
  };
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 10 * 60_000, value });
  return value;
}

export async function routePlaces(
  raw: unknown,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<{ route: PlaceRoute }> {
  const input = routeInput.parse(raw);
  if (new Set(input.places.map((place) => place.id)).size !== input.places.length)
    throw new Error("Route places must have distinct ids");
  const url = endpoint(process.env.OPENTEAM_ROUTER_URL, "https://valhalla1.openstreetmap.de/route");
  const costing = { walking: "pedestrian", cycling: "bicycle", driving: "auto" }[input.mode];
  const payload = {
    locations: input.places.map((p) => ({ lat: p.latitude, lon: p.longitude, type: "break" })),
    costing,
    format: "osrm",
    shape_format: "geojson",
    units: "kilometers",
  };
  const result = await providerJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    fetcher
  );
  const candidate = result.routes?.[0];
  if (!candidate || candidate.legs?.length !== input.places.length - 1)
    throw new Error("The routing provider could not resolve every stop");
  const route = PlaceRouteSchema.parse({
    mode: input.mode,
    geometry: candidate.geometry,
    distanceMeters: candidate.distance,
    durationSeconds: candidate.duration,
    legs: candidate.legs.map((leg: any, i: number) => ({
      fromPlaceId: input.places[i]!.id,
      toPlaceId: input.places[i + 1]!.id,
      distanceMeters: leg.distance,
      durationSeconds: leg.duration,
      instructions: (leg.steps ?? []).flatMap((step: any) =>
        typeof step.maneuver?.instruction === "string" ? [step.maneuver.instruction] : []
      ),
    })),
    provider: "Valhalla / OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
  });
  return { route };
}
