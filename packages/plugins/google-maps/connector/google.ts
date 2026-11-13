/** Google Maps Platform: Places API (New) for search, ratings, reviews, photos and hours, and the
 * Routes API for directions. Results use the field names of SendToUser presentation places, so a
 * Bot can pass them to a map unchanged. One API key (GOOGLE_MAPS_API_KEY) authorizes both. */

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address?: string;
  category?: string;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  rating?: number;
  reviewCount?: number;
  isOpen?: boolean;
  hours?: string;
  provider: string;
  sourceUrl?: string;
  attribution: string;
};
type Coordinates = { latitude: number; longitude: number };
type Stop = Coordinates & { id: string; name?: string };

const PLACES = "https://places.googleapis.com/v1";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ATTRIBUTION = "Google Maps";
const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};
const SEARCH_FIELDS = [
  "id", "displayName", "formattedAddress", "location", "primaryTypeDisplayName", "googleMapsUri", "websiteUri",
  "rating", "userRatingCount", "priceLevel", "currentOpeningHours.openNow", "currentOpeningHours.weekdayDescriptions",
  "regularOpeningHours.weekdayDescriptions", "utcOffsetMinutes", "internationalPhoneNumber", "businessStatus",
  "editorialSummary", "photos",
];
const DETAIL_FIELDS = [...SEARCH_FIELDS, "reviews", "reviewSummary", "generativeSummary"];

export function apiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key)
    throw new Error("No Google Maps API key is set. Add one in this plugin's account settings; never ask the user to paste it in chat.");
  return key;
}

const cache = new Map<string, { expires: number; value: unknown }>();
export function resetGoogleState() {
  cache.clear();
}
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 5 * 60_000, value });
  return value;
}

/** One Google request; errors carry Google's own message, never the key. */
async function google(
  url: string,
  init: { method?: string; body?: unknown; fields?: string },
  fetcher: Fetcher,
  signal?: AbortSignal
): Promise<any> {
  const key = apiKey();
  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        "X-Goog-Api-Key": key,
        ...(init.fields ? { "X-Goog-FieldMask": init.fields } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Google Maps could not be reached${error instanceof Error && error.name === "TimeoutError" ? " (timed out)" : ""}. Nothing was made up; retry shortly.`);
  }
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    const message = String(body?.error?.message ?? `HTTP ${response.status}`).replaceAll(key, "[key]").slice(0, 600);
    throw new Error(`Google Maps returned ${response.status}: ${message}`);
  }
  return body;
}

const clean = (value: unknown, max = 2000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const https = (value: unknown) => {
  const text = clean(value, 4096);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};
export const placeId = (id: string) => id.replace(/^google:/, "").replace(/^places\//, "");

/** Today's line of Google's weekday hours, in the place's own time zone. */
export function todaysHours(lines: unknown, utcOffsetMinutes: unknown, now = new Date()): string | undefined {
  if (!Array.isArray(lines) || lines.length !== 7 || typeof utcOffsetMinutes !== "number") return undefined;
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const index = (local.getUTCDay() + 6) % 7; // Google lists Monday first.
  return clean(lines[index], 300);
}

/** The first photo as a keyless image link, with its required author credit. */
async function photo(place: any, fetcher: Fetcher, signal?: AbortSignal) {
  const first = Array.isArray(place?.photos) ? place.photos[0] : undefined;
  if (!first?.name) return {};
  try {
    const url = `${PLACES}/${first.name}/media?maxWidthPx=1200&skipHttpRedirect=true`;
    const media = await google(url, {}, fetcher, signal);
    const imageUrl = https(media?.photoUri);
    const credit = (first.authorAttributions ?? []).map((a: any) => clean(a?.displayName, 120)).filter(Boolean).join(", ");
    return imageUrl ? { imageUrl, credit } : {};
  } catch {
    return {};
  }
}

function toPlace(raw: any, extras: { imageUrl?: string; credit?: string }, now: Date): Place | null {
  const id = clean(raw?.id, 300),
    latitude = raw?.location?.latitude,
    longitude = raw?.location?.longitude,
    name = clean(raw?.displayName?.text);
  if (!id || !name || typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const price = PRICE[raw.priceLevel as string];
  const type = clean(raw.primaryTypeDisplayName?.text, 200);
  const category = [type, price].filter(Boolean).join(" · ") || undefined;
  const hours =
    todaysHours(raw.currentOpeningHours?.weekdayDescriptions, raw.utcOffsetMinutes, now) ??
    todaysHours(raw.regularOpeningHours?.weekdayDescriptions, raw.utcOffsetMinutes, now);
  const closedForGood = raw.businessStatus === "CLOSED_PERMANENTLY" || raw.businessStatus === "CLOSED_TEMPORARILY";
  const open = closedForGood ? false : typeof raw.currentOpeningHours?.openNow === "boolean" ? raw.currentOpeningHours.openNow : undefined;
  return {
    id: `google:${id}`,
    name,
    latitude,
    longitude,
    ...(clean(raw.formattedAddress) ? { address: clean(raw.formattedAddress) } : {}),
    ...(category ? { category } : {}),
    ...(clean(raw.editorialSummary?.text) ? { description: clean(raw.editorialSummary?.text) } : {}),
    ...(extras.imageUrl ? { imageUrl: extras.imageUrl } : {}),
    ...(https(raw.websiteUri) ? { websiteUrl: https(raw.websiteUri) } : {}),
    ...(typeof raw.rating === "number" && raw.rating >= 0 && raw.rating <= 5 ? { rating: raw.rating } : {}),
    ...(Number.isInteger(raw.userRatingCount) && raw.userRatingCount >= 0 ? { reviewCount: raw.userRatingCount } : {}),
    ...(open !== undefined ? { isOpen: open } : {}),
    ...(closedForGood ? { hours: raw.businessStatus === "CLOSED_PERMANENTLY" ? "Permanently closed" : "Temporarily closed" } : hours ? { hours } : {}),
    provider: "Google Maps",
    ...(https(raw.googleMapsUri) ? { sourceUrl: https(raw.googleMapsUri) } : {}),
    attribution: extras.credit ? `${ATTRIBUTION} · Photo: ${extras.credit}` : ATTRIBUTION,
  };
}

const EARTH_RADIUS = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
export function distanceMeters(a: Coordinates, b: Coordinates) {
  const dLat = radians(b.latitude - a.latitude),
    dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function shape(places: any[], limit: number, photos: boolean, fetcher: Fetcher, signal: AbortSignal | undefined, now: Date) {
  const chosen = places.slice(0, limit);
  const media = await Promise.all(chosen.map((place) => (photos ? photo(place, fetcher, signal) : Promise.resolve({}))));
  return chosen.flatMap((raw, index) => {
    const place = toPlace(raw, media[index]!, now);
    if (!place) return [];
    const phone = clean(raw.internationalPhoneNumber, 100);
    return [{ place, ...(phone ? { phone } : {}), ...(PRICE[raw.priceLevel] ? { priceLevel: PRICE[raw.priceLevel] } : {}) }];
  });
}

/** Text Search: places matching a query, optionally biased toward a point. */
export async function searchPlaces(
  input: { query: string; latitude?: number; longitude?: number; radiusMeters?: number; openNow?: boolean; minRating?: number; limit?: number; photos?: boolean },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  now = new Date()
) {
  const limit = input.limit ?? 8;
  const body: Record<string, unknown> = { textQuery: input.query.trim(), pageSize: limit };
  if (input.latitude !== undefined && input.longitude !== undefined)
    body.locationBias = { circle: { center: { latitude: input.latitude, longitude: input.longitude }, radius: input.radiusMeters ?? 5_000 } };
  if (input.openNow) body.openNow = true;
  if (input.minRating !== undefined) body.minRating = input.minRating;
  const fields = SEARCH_FIELDS.map((field) => `places.${field}`).join(",");
  const result = await cached(`search:${JSON.stringify(body)}`, () =>
    google(`${PLACES}/places:searchText`, { body, fields }, fetcher, signal)
  );
  const results = await shape(result?.places ?? [], limit, input.photos !== false, fetcher, signal, now);
  return {
    results,
    provider: "Google Maps",
    attribution: ATTRIBUTION,
    fetchedAt: now.toISOString(),
    instruction:
      "Ratings, review counts, hours, open-now and photos come from Google Maps; keep provider and attribution on each place. Check the address before using a result. For reviews and summaries of finalists, call GetPlaceDetails with the place id.",
  };
}

/** Places matching a query within a radius of a point, sorted by relevance or distance. */
export async function searchNearbyPlaces(
  input: { query: string; latitude: number; longitude: number; radiusMeters?: number; openNow?: boolean; minRating?: number; rankBy?: "relevance" | "distance"; limit?: number; photos?: boolean },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  now = new Date()
) {
  const radius = input.radiusMeters ?? 1_500,
    limit = input.limit ?? 10;
  const dLat = radius / 111_320,
    dLon = radius / (111_320 * Math.max(0.01, Math.cos(radians(input.latitude))));
  const body: Record<string, unknown> = {
    textQuery: input.query.trim(),
    pageSize: 20,
    locationRestriction: {
      rectangle: {
        low: { latitude: input.latitude - dLat, longitude: input.longitude - dLon },
        high: { latitude: input.latitude + dLat, longitude: input.longitude + dLon },
      },
    },
    ...(input.rankBy === "distance" ? { rankPreference: "DISTANCE" } : {}),
    ...(input.openNow ? { openNow: true } : {}),
    ...(input.minRating !== undefined ? { minRating: input.minRating } : {}),
  };
  const fields = SEARCH_FIELDS.map((field) => `places.${field}`).join(",");
  const result = await cached(`nearby:${JSON.stringify(body)}`, () =>
    google(`${PLACES}/places:searchText`, { body, fields }, fetcher, signal)
  );
  const center = { latitude: input.latitude, longitude: input.longitude };
  const inside = (result?.places ?? [])
    .map((raw: any) => ({ raw, distance: raw?.location ? Math.round(distanceMeters(center, raw.location)) : Infinity }))
    .filter((entry: any) => entry.distance <= radius);
  if (input.rankBy === "distance") inside.sort((a: any, b: any) => a.distance - b.distance);
  const shaped = await shape(inside.map((entry: any) => entry.raw), limit, input.photos !== false, fetcher, signal, now);
  const byId = new Map(inside.map((entry: any) => [`google:${entry.raw.id}`, entry.distance]));
  return {
    results: shaped.map((entry) => ({ ...entry, distanceMeters: byId.get(entry.place.id) })),
    provider: "Google Maps",
    attribution: ATTRIBUTION,
    fetchedAt: now.toISOString(),
    instruction:
      "Results are inside the radius, in Google's relevance order unless rankBy is distance. Rank 'best' with rating and review count together (a 4.7 from 2,000 reviews beats a 5.0 from 6), then read reviews of finalists with GetPlaceDetails. Keep provider and attribution on each place.",
  };
}

/** One place in depth: up to five reviews, Google's summaries, hours for the week and a photo. */
export async function getPlaceDetails(input: { placeId: string; photos?: boolean }, fetcher: Fetcher = fetch, signal?: AbortSignal, now = new Date()) {
  const id = placeId(input.placeId);
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) throw new Error("placeId must be a Google place id (from SearchPlaces or SearchNearbyPlaces)");
  const raw = await cached(`details:${id}`, () =>
    google(`${PLACES}/places/${id}`, { fields: DETAIL_FIELDS.join(",") }, fetcher, signal)
  );
  const [shaped] = await shape([raw], 1, input.photos !== false, fetcher, signal, now);
  if (!shaped) throw new Error("Google Maps returned no usable place for that id");
  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : []).slice(0, 5).map((review: any) => ({
    rating: typeof review.rating === "number" ? review.rating : undefined,
    text: clean(review.text?.text ?? review.originalText?.text, 1500),
    author: clean(review.authorAttribution?.displayName, 120),
    when: clean(review.relativePublishTimeDescription, 60),
    publishedAt: clean(review.publishTime, 40),
    url: https(review.googleMapsUri),
  }));
  return {
    ...shaped,
    weekHours: raw.currentOpeningHours?.weekdayDescriptions ?? raw.regularOpeningHours?.weekdayDescriptions,
    reviewSummary: clean(raw.reviewSummary?.text?.text),
    overview: clean(raw.generativeSummary?.overview?.text),
    reviews,
    provider: "Google Maps",
    attribution: ATTRIBUTION,
    fetchedAt: now.toISOString(),
    instruction:
      "Quote or paraphrase reviews with their author and Google Maps as the source. Google returns at most five reviews, chosen by relevance, so treat them as a sample, not the whole picture.",
  };
}

const seconds = (value: unknown) => {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match ? Number(match[1]) : 0;
};

/** A real walking, cycling or driving route through ordered stops, from the Routes API. */
export async function routePlaces(
  input: { places: Stop[]; mode: "walking" | "driving" | "cycling" },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
) {
  if (new Set(input.places.map((place) => place.id)).size !== input.places.length)
    throw new Error("Route places must have distinct ids");
  const waypoint = (place: Stop) => ({ location: { latLng: { latitude: place.latitude, longitude: place.longitude } } });
  const travelMode = { walking: "WALK", cycling: "BICYCLE", driving: "DRIVE" }[input.mode];
  const body = {
    origin: waypoint(input.places[0]!),
    destination: waypoint(input.places.at(-1)!),
    intermediates: input.places.slice(1, -1).map(waypoint),
    travelMode,
    ...(travelMode === "DRIVE" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
    polylineEncoding: "GEO_JSON_LINESTRING",
    units: "METRIC",
  };
  const fields = "routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring,routes.legs.distanceMeters,routes.legs.duration,routes.legs.steps.navigationInstruction.instructions";
  const result = await google(ROUTES, { body, fields }, fetcher, signal);
  const route = result?.routes?.[0];
  const coordinates = route?.polyline?.geoJsonLinestring?.coordinates;
  if (
    !route ||
    route.legs?.length !== input.places.length - 1 ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    coordinates.some((point: unknown) => !Array.isArray(point) || typeof point[0] !== "number" || typeof point[1] !== "number")
  )
    throw new Error("Google Maps could not route through every stop with that travel mode");
  return {
    route: {
      mode: input.mode,
      geometry: { type: "LineString", coordinates: coordinates.slice(0, 20_000).map((point: number[]) => [point[0], point[1]]) },
      distanceMeters: Math.max(0, Number(route.distanceMeters) || 0),
      durationSeconds: seconds(route.duration),
      legs: route.legs.map((leg: any, index: number) => ({
        fromPlaceId: input.places[index]!.id,
        toPlaceId: input.places[index + 1]!.id,
        distanceMeters: Math.max(0, Number(leg.distanceMeters) || 0),
        durationSeconds: seconds(leg.duration),
        instructions: (leg.steps ?? []).flatMap((step: any) =>
          typeof step?.navigationInstruction?.instructions === "string" ? [step.navigationInstruction.instructions] : []
        ),
      })),
      provider: "Google Maps",
      attribution: ATTRIBUTION,
    },
  };
}
