/** Free, keyless OpenStreetMap services: Photon for place search, Nominatim for nearby places
 * and Valhalla for routes. Results use the field names of SendToUser presentation places, so a
 * Bot can pass them to a map unchanged. Nothing is invented: OSM has no ratings or photos. */

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address?: string;
  category?: string;
  websiteUrl?: string;
  isOpen?: boolean;
  hours?: string;
  provider: string;
  sourceUrl: string;
  attribution: string;
};
type Coordinates = { latitude: number; longitude: number };
type RouteStop = Coordinates & { id: string; name?: string };

const ATTRIBUTION = "© OpenStreetMap contributors";
const USER_AGENT = "OpenTeam OpenStreetMap plugin (https://openteam.so)";
const cache = new Map<string, { expires: number; value: unknown }>();

function remember<T>(key: string, value: T): T {
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 10 * 60_000, value });
  return value;
}
const cached = <T>(key: string) => {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? (hit.value as T) : undefined;
};

/** Testing hook: forget cached answers and Nominatim pacing. */
export function resetPlaceState() {
  cache.clear();
  nominatimTurn = Promise.resolve();
}

function endpoint(value: string | undefined, fallback: string): URL {
  const url = new URL(value || fallback);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid OpenStreetMap service URL");
  return url;
}

async function providerJson(url: URL, options: RequestInit, fetcher: Fetcher, service: string): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...options,
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...options.headers },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${service} could not be reached${error instanceof Error && error.name === "TimeoutError" ? " (timed out)" : ""}. No places or routes were made up; retry shortly.`);
  }
  if (!response.ok)
    throw new Error(`${service} returned HTTP ${response.status}. No places or routes were made up; retry shortly.`);
  const body = await response.text();
  if (body.length > 4_000_000) throw new Error(`${service} response is too large`);
  return JSON.parse(body);
}

const clean = (value: unknown, max = 2000) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** Presentation links must be public HTTPS; OSM often stores bare or http:// sites. */
export function httpsUrl(value: unknown): string | undefined {
  const text = clean(value, 4096);
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const finite = (value: unknown, limit: number) => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= limit ? number : undefined;
};
const osmKind = (value: unknown) =>
  ({ N: "node", W: "way", R: "relation", node: "node", way: "way", relation: "relation" } as Record<string, string>)[String(value)];
const label = (value: unknown) => {
  const text = clean(value, 200);
  return text && text !== "yes" ? text.replaceAll("_", " ") : undefined;
};

/** Photon geocoding: names, addresses, coordinates and OSM provenance. */
export async function searchPlaces(
  input: { query: string; limit?: number; latitude?: number; longitude?: number },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
) {
  const limit = input.limit ?? 5;
  const url = endpoint(process.env.OPENSTREETMAP_GEOCODER_URL, "https://photon.komoot.io/api/");
  url.searchParams.set("q", input.query.trim());
  url.searchParams.set("limit", String(limit));
  if (input.latitude !== undefined && input.longitude !== undefined) {
    url.searchParams.set("lat", String(input.latitude));
    url.searchParams.set("lon", String(input.longitude));
  }
  const hit = cached<unknown>(url.href);
  if (hit) return hit;
  const result = await providerJson(url, { signal }, fetcher, "Photon");
  const shape = () => {
    const places: Place[] = (Array.isArray(result.features) ? result.features : []).slice(0, limit).flatMap((feature: any) => {
      const p = feature?.properties ?? {},
        coordinates = feature?.geometry?.coordinates;
      const kind = osmKind(p.osm_type),
        longitude = finite(coordinates?.[0], 180),
        latitude = finite(coordinates?.[1], 90);
      if (feature?.geometry?.type !== "Point" || !kind || !p.osm_id || latitude === undefined || longitude === undefined) return [];
      const address = [
        p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street,
        p.city ?? p.town ?? p.village,
        p.state,
        p.postcode,
        p.country,
      ]
        .filter((part) => typeof part === "string" && part.trim())
        .join(", ");
      const name = clean(p.name) ?? clean(p.street) ?? clean(address);
      if (!name) return [];
      return [
        {
          id: `osm:${kind}:${p.osm_id}`,
          name,
          latitude,
          longitude,
          ...(address ? { address } : {}),
          ...(label(p.osm_value === "yes" ? p.osm_key : p.osm_value) ? { category: label(p.osm_value === "yes" ? p.osm_key : p.osm_value) } : {}),
          provider: "OpenStreetMap",
          sourceUrl: `https://www.openstreetmap.org/${kind}/${p.osm_id}`,
          attribution: ATTRIBUTION,
        },
      ];
    });
    return {
      places,
      provider: "Photon / OpenStreetMap",
      attribution: ATTRIBUTION,
      fetchedAt: new Date().toISOString(),
      instruction:
        "Check the name, city and address before using a result, even when only one comes back; retry with a more specific address or bias coordinates if it is a different branch. To find places of a kind near one of these, pass its coordinates to SearchNearbyPlaces.",
    };
  };
  return remember(url.href, shape());
}

const EARTH_RADIUS = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
export function distanceMeters(a: Coordinates, b: Coordinates) {
  const dLat = radians(b.latitude - a.latitude),
    dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
/** Per weekday (Mo = 0): open spans in minutes since midnight; an end past 1440 runs overnight. */
export type Week = Array<Array<[number, number]>>;

/** The common subset of OSM opening_hours ("Mo-Fr 11:00-22:00; Sa,Su 12:00-02:00; PH off", "24/7").
 * Anything else (months, weeks, sunrise, comments) returns null, so open-now is never guessed. */
export function parseOpeningHours(value: string): Week | null {
  const text = value.trim();
  if (text === "24/7") return DAYS.map(() => [[0, 1440]]);
  const week: Week = DAYS.map(() => []);
  // A comma between rules follows a time ("Mo-Fr 09:00-17:00, Sa 10:00-14:00"); elsewhere it lists days or spans.
  const rules = text.split(";").flatMap((rule) => rule.split(/(?<=\d)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/));
  for (const raw of rules) {
    const rule = raw.trim();
    if (!rule) continue;
    const match = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)?\s*(.*)$/.exec(rule);
    if (!match) return null;
    const selectors = (match[1] ?? "").trim().replace(/,$/, "");
    const times = match[2]!.trim();
    const parts = selectors ? selectors.split(/\s*,\s*/) : ["Mo-Su"];
    // Public holidays can't be known here; skip holiday-only rules rather than misapply them.
    if (parts.every((part) => part === "PH")) continue;
    const days = new Set<number>();
    for (const part of parts) {
      if (part === "PH") continue;
      const [from, to] = part.split(/\s*-\s*/) as [string, string | undefined];
      const start = DAYS.indexOf(from as (typeof DAYS)[number]),
        end = to === undefined ? start : DAYS.indexOf(to as (typeof DAYS)[number]);
      if (start < 0 || end < 0) return null;
      for (let day = start; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === end) break;
      }
    }
    const spans: Array<[number, number]> = [];
    if (!/^(off|closed)$/i.test(times)) {
      if (!times) return null;
      for (const span of times.split(/\s*,\s*/)) {
        const time = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(span);
        if (!time || Number(time[2]) > 59 || Number(time[4]) > 59) return null;
        const open = Number(time[1]) * 60 + Number(time[2]);
        let close = Number(time[3]) * 60 + Number(time[4]);
        if (open > 1440 || close > 2880) return null;
        if (close <= open) close += 1440;
        spans.push([open, close]);
      }
    }
    // A later rule replaces earlier ones for the days it names.
    for (const day of days) week[day] = spans;
  }
  return week;
}

/** Whether a week is open at a moment in a time zone, including spans that run past midnight. */
export function isOpenAt(week: Week, now: Date, timeZone: string): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (week[day]!.some(([open, close]) => minute >= open && minute < close)) return true;
  return week[(day + 6) % 7]!.some(([, close]) => close > 1440 && minute < close - 1440);
}

/** Today's hours for a card, in the place's time zone: "Today 11:00–22:30", "Closed today". */
export function todaysHours(week: Week, now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const spans = week[["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday)]!;
  if (!spans.length) return "Closed today";
  if (spans.length === 1 && spans[0]![0] === 0 && spans[0]![1] >= 1440) return "Open 24 hours today";
  const time = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `Today ${spans.map(([open, close]) => `${time(open)}–${time(close)}`).join(", ")}`;
}

export function validTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Nominatim's usage policy: at most one request per second, with an identifying user agent.
let nominatimTurn = Promise.resolve();
function nominatimSlot() {
  const ready = nominatimTurn;
  nominatimTurn = ready.then(() => new Promise<void>((resolve) => setTimeout(resolve, 1_100)));
  return ready;
}

/** Places of a kind around a point, from Nominatim: cuisine, website, phone and opening hours
 * come from OSM tags. Results are sorted by straight-line distance. */
export async function searchNearbyPlaces(
  input: {
    query: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    limit?: number;
    openNow?: boolean;
    timeZone?: string;
  },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  now = new Date()
) {
  const radius = input.radiusMeters ?? 1_500,
    limit = input.limit ?? 10;
  if (input.timeZone !== undefined && !validTimeZone(input.timeZone))
    throw new Error("timeZone must be an IANA time zone such as America/New_York");
  if (input.openNow && !input.timeZone) throw new Error("openNow needs timeZone, the area's IANA time zone");
  const url = endpoint(process.env.OPENSTREETMAP_NEARBY_URL, "https://nominatim.openstreetmap.org/search");
  const dLat = radius / 111_320,
    dLon = radius / (111_320 * Math.max(0.01, Math.cos(radians(input.latitude))));
  url.searchParams.set("q", input.query.trim());
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "40");
  url.searchParams.set("bounded", "1");
  url.searchParams.set(
    "viewbox",
    [input.longitude - dLon, input.latitude + dLat, input.longitude + dLon, input.latitude - dLat].map((n) => n.toFixed(6)).join(",")
  );
  let rows = cached<any[]>(url.href);
  if (!rows) {
    await nominatimSlot();
    const result = await providerJson(url, { signal }, fetcher, "Nominatim");
    rows = remember(url.href, Array.isArray(result) ? result : []);
  }
  const center = { latitude: input.latitude, longitude: input.longitude };
  const seen = new Set<string>();
  const results = rows.flatMap((row: any) => {
    const kind = osmKind(row?.osm_type),
      latitude = finite(row?.lat, 90),
      longitude = finite(row?.lon, 180);
    if (!kind || !row.osm_id || latitude === undefined || longitude === undefined) return [];
    const id = `osm:${kind}:${row.osm_id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const distance = Math.round(distanceMeters(center, { latitude, longitude }));
    if (distance > radius) return [];
    const tags = (row.extratags ?? {}) as Record<string, string>,
      address = (row.address ?? {}) as Record<string, string>;
    const street = address.road ? [address.house_number, address.road].filter(Boolean).join(" ") : undefined;
    const line = [street, address.city ?? address.town ?? address.village ?? address.suburb, address.state, address.postcode]
      .filter(Boolean)
      .join(", ");
    const name = clean(row.name) ?? clean(tags.brand) ?? clean(line);
    if (!name) return [];
    const cuisine = clean(tags.cuisine)
      ?.split(";")
      .map((part) => part.trim().replaceAll("_", " "))
      .filter(Boolean)
      .join(", ");
    const type = label(row.type);
    const hours = clean(tags.opening_hours, 500);
    const week = hours ? parseOpeningHours(hours) : null;
    const openNow = week && input.timeZone ? isOpenAt(week, now, input.timeZone) : undefined;
    const website = httpsUrl(tags.website ?? tags["contact:website"]);
    const category = cuisine && type ? `${cuisine} ${type}` : (type ?? cuisine);
    const place: Place = {
      id,
      name,
      latitude,
      longitude,
      ...(line ? { address: line } : {}),
      ...(category ? { category } : {}),
      ...(website ? { websiteUrl: website } : {}),
      // Today's hours when they can be read; otherwise OSM's own opening_hours text.
      ...(hours ? { hours: week && input.timeZone ? todaysHours(week, now, input.timeZone) : hours } : {}),
      ...(openNow !== undefined ? { isOpen: openNow } : {}),
      provider: "OpenStreetMap",
      sourceUrl: `https://www.openstreetmap.org/${kind}/${row.osm_id}`,
      attribution: ATTRIBUTION,
    };
    const phone = clean(tags.phone ?? tags["contact:phone"], 100);
    return [{
      place,
      distanceMeters: distance,
      ...(phone ? { phone } : {}),
      ...(hours ? { openingHours: hours } : {}), // the whole week, in OSM's syntax
      ...(openNow !== undefined ? { openNow } : {}),
    }];
  });
  results.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return {
    results: (input.openNow ? results.filter((result) => result.openNow === true) : results).slice(0, limit),
    provider: "Nominatim / OpenStreetMap",
    attribution: ATTRIBUTION,
    fetchedAt: now.toISOString(),
    instruction: [
      "Sorted by straight-line distance. OpenStreetMap has no ratings, reviews or photos: for \"best\", check reviews with web search and cite them, and never invent ratings.",
      "Matching uses names and place types, so places whose name lacks the cuisine can be missing; when results are few, try other wording (\"thai\", \"thai restaurant\", \"noodles\") or a wider radius.",
      input.timeZone
        ? "openNow comes from OSM opening_hours in the given time zone. It is absent when hours are unknown or too complex, and holidays are not considered."
        : "Pass timeZone (the area's IANA zone) to get openNow from opening_hours.",
    ].join(" "),
  };
}

/** A real walking, cycling or driving route through ordered stops, from Valhalla. */
export async function routePlaces(
  input: { places: RouteStop[]; mode: "walking" | "driving" | "cycling" },
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
) {
  if (new Set(input.places.map((place) => place.id)).size !== input.places.length)
    throw new Error("Route places must have distinct ids");
  const url = endpoint(process.env.OPENSTREETMAP_ROUTER_URL, "https://valhalla1.openstreetmap.de/route");
  const costing = { walking: "pedestrian", cycling: "bicycle", driving: "auto" }[input.mode];
  const result = await providerJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        locations: input.places.map((place) => ({ lat: place.latitude, lon: place.longitude, type: "break" })),
        costing,
        format: "osrm",
        shape_format: "geojson",
        units: "kilometers",
      }),
      signal,
    },
    fetcher,
    "Valhalla"
  );
  const candidate = result.routes?.[0];
  const coordinates = candidate?.geometry?.coordinates;
  if (
    !candidate ||
    candidate.legs?.length !== input.places.length - 1 ||
    candidate.geometry?.type !== "LineString" ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    coordinates.some((point: unknown) => !Array.isArray(point) || finite(point[0], 180) === undefined || finite(point[1], 90) === undefined)
  )
    throw new Error("The routing service could not resolve every stop");
  return {
    route: {
      mode: input.mode,
      geometry: { type: "LineString", coordinates: coordinates.slice(0, 20_000).map((point: number[]) => [point[0], point[1]]) },
      distanceMeters: Math.max(0, Number(candidate.distance) || 0),
      durationSeconds: Math.max(0, Number(candidate.duration) || 0),
      legs: candidate.legs.map((leg: any, index: number) => ({
        fromPlaceId: input.places[index]!.id,
        toPlaceId: input.places[index + 1]!.id,
        distanceMeters: Math.max(0, Number(leg.distance) || 0),
        durationSeconds: Math.max(0, Number(leg.duration) || 0),
        instructions: (leg.steps ?? []).flatMap((step: any) =>
          typeof step?.maneuver?.instruction === "string" ? [step.maneuver.instruction] : []
        ),
      })),
      provider: "Valhalla / OpenStreetMap",
      attribution: ATTRIBUTION,
    },
  };
}
