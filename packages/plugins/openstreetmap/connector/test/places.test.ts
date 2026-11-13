import { beforeEach, expect, test } from "bun:test";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { PlaceRouteSchema, PlaceSchema } from "../../../../contracts/src/presentation";
import { httpsUrl, isOpenAt, parseOpeningHours, resetPlaceState, routePlaces, searchNearbyPlaces, searchPlaces, todaysHours, type Fetcher } from "../places";
import { callTool, tools } from "../server";

beforeEach(resetPlaceState);
const json = (value: unknown) => (async () => Response.json(value)) as Fetcher;

test("Bots get three read-only tools with bounded inputs", () => {
  expect(tools.map((tool) => tool.name)).toEqual(["SearchPlaces", "SearchNearbyPlaces", "RoutePlaces"]);
  for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  const valid = (name: string, args: unknown) => createToolValidator(tools.find((tool) => tool.name === name)!.inputSchema)(args).valid;
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75, longitude: -73.99, timeZone: "America/New_York", openNow: true })).toBe(true);
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75 })).toBe(false);
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75, longitude: -73.99, radiusMeters: 50_000 })).toBe(false);
  expect(valid("RoutePlaces", { places: [{ id: "a", latitude: 1, longitude: 1 }], mode: "walking" })).toBe(false);
  expect(valid("SearchPlaces", { query: "Louvre", extra: 1 })).toBe(false);
});

test("Photon results keep provenance and leave unknown business details absent", async () => {
  let request: URL | undefined;
  const fetcher = (async (url: URL) => {
    request = url;
    return Response.json({
      features: [
        { geometry: { type: "Point", coordinates: [-73.985, 40.748] }, properties: { osm_type: "W", osm_id: 42, name: "A", osm_key: "building", osm_value: "yes", street: "5th Avenue", housenumber: "350", city: "New York" } },
        { geometry: { type: "Point", coordinates: [-73, 140] }, properties: { osm_type: "N", osm_id: 1, name: "Invalid" } },
      ],
    });
  }) as Fetcher;
  const result = (await searchPlaces({ query: "fixture library", latitude: 40.75, longitude: -73.98 }, fetcher)) as any;
  expect(request!.searchParams.get("lon")).toBe("-73.98");
  expect(result.places).toEqual([
    { id: "osm:way:42", name: "A", latitude: 40.748, longitude: -73.985, address: "350 5th Avenue, New York", category: "building", provider: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org/way/42", attribution: "© OpenStreetMap contributors" },
  ]);
});

test("opening_hours: common rules parse, later rules replace days, unsupported syntax is never guessed", () => {
  const week = parseOpeningHours("Mo-Fr 11:30-16:00, 17:00-22:00; Sa, Su 12:00-02:00; PH off")!;
  expect(week[0]).toEqual([[690, 960], [1020, 1320]]);
  expect(week[5]).toEqual([[720, 1560]]);
  expect(parseOpeningHours("Mo-Fr 09:00-17:00, Sa 10:00-14:00")![5]).toEqual([[600, 840]]);
  expect(parseOpeningHours("Mo-Su 10:00-20:00; We off")![2]).toEqual([]);
  expect(parseOpeningHours("Fr-Mo 18:00-23:00")!.map((day) => day.length)).toEqual([1, 0, 0, 0, 1, 1, 1]);
  for (const unsupported of ["Jan-Mar Mo 10:00-12:00", "Mo-Fr sunrise-sunset", "Mo 10:00+", "\"by appointment\"", "Mo-Fr"])
    expect(parseOpeningHours(unsupported)).toBeNull();
  const zone = "America/New_York";
  // Thursday 2026-11-12 at 15:00 and 16:30 local; Sunday 01:00 is inside Saturday's late span.
  expect(isOpenAt(week, new Date("2026-11-12T20:00:00Z"), zone)).toBe(true);
  expect(isOpenAt(week, new Date("2026-11-12T21:30:00Z"), zone)).toBe(false);
  expect(isOpenAt(week, new Date("2026-11-15T06:00:00Z"), zone)).toBe(true);
  expect(isOpenAt(parseOpeningHours("24/7")!, new Date(), "Asia/Tokyo")).toBe(true);
  // Cards show today's hours in the place's zone.
  expect(todaysHours(week, new Date("2026-11-12T20:00:00Z"), zone)).toBe("Today 11:30–16:00, 17:00–22:00");
  expect(todaysHours(week, new Date("2026-11-14T20:00:00Z"), zone)).toBe("Today 12:00–02:00");
  expect(todaysHours(parseOpeningHours("Mo-Sa 10:00-20:00; Su off")!, new Date("2026-11-15T20:00:00Z"), zone)).toBe("Closed today");
  expect(todaysHours(parseOpeningHours("24/7")!, new Date(), zone)).toBe("Open 24 hours today");
});

test("websites become public HTTPS links or are dropped", () => {
  expect(httpsUrl("nearthai.example")).toBe("https://nearthai.example/");
  expect(httpsUrl("http://a.example/menu")).toBe("https://a.example/menu");
  expect(httpsUrl("ftp://a.example")).toBeUndefined();
  expect(httpsUrl("https://user:pw@a.example")).toBeUndefined();
  expect(httpsUrl("not a url")).toBeUndefined();
});

test("nearby places stay within the radius, sorted by distance, with OSM details and computed open-now", async () => {
  let request: URL | undefined;
  const row = (id: number, name: string, lat: number, extratags: Record<string, string> = {}) => ({
    osm_type: "node", osm_id: id, name, lat: String(lat), lon: "-73.9935", type: "restaurant",
    address: { house_number: "1", road: "8th Avenue", city: "New York", state: "New York", postcode: "10001" }, extratags,
  });
  const fetcher = (async (url: URL) => {
    request = url;
    return Response.json([
      row(2, "Far Thai", 40.7606, { cuisine: "thai", opening_hours: "Mo-Su 11:00-22:00" }),
      row(1, "Near Thai", 40.751, { cuisine: "thai;noodle", opening_hours: "Mo-Fr 17:00-22:00", website: "nearthai.example", phone: "+1 212 555 0100" }),
      row(3, "Outside", 40.8),
      row(1, "Near Thai duplicate", 40.751),
      { osm_type: "node", osm_id: 9, name: "Bad", lat: "x", lon: "y" },
    ]);
  }) as Fetcher;
  const now = new Date("2026-11-12T20:00:00Z"); // Thursday 15:00 in New York
  const input = { query: "thai restaurant", latitude: 40.7506, longitude: -73.9935, timeZone: "America/New_York" };
  const result = await searchNearbyPlaces(input, fetcher, undefined, now);
  expect(request!.searchParams.get("bounded")).toBe("1");
  expect(request!.searchParams.get("extratags")).toBe("1");
  expect(result.results.map((entry) => entry.place.name)).toEqual(["Near Thai", "Far Thai"]);
  expect(result.results[0]).toEqual({
    distanceMeters: 44,
    phone: "+1 212 555 0100",
    openingHours: "Mo-Fr 17:00-22:00",
    openNow: false,
    place: {
      id: "osm:node:1", name: "Near Thai", latitude: 40.751, longitude: -73.9935,
      address: "1 8th Avenue, New York, New York, 10001", category: "thai, noodle restaurant",
      websiteUrl: "https://nearthai.example/", hours: "Today 17:00–22:00", isOpen: false,
      provider: "OpenStreetMap", sourceUrl: "https://www.openstreetmap.org/node/1", attribution: "© OpenStreetMap contributors",
    },
  });
  for (const entry of result.results) expect(PlaceSchema.safeParse(entry.place).success).toBe(true);
  const open = await searchNearbyPlaces({ ...input, openNow: true }, fetcher, undefined, now);
  expect(open.results.map((entry) => entry.place.name)).toEqual(["Far Thai"]);
  await expect(searchNearbyPlaces({ ...input, timeZone: "Mars/Olympus" }, fetcher)).rejects.toThrow("IANA");
  // Nominatim's viewbox can't wrap ±180°, so it is kept inside valid coordinates.
  resetPlaceState();
  await searchNearbyPlaces({ query: "resort", latitude: -16.8, longitude: 179.99, radiusMeters: 5000 }, fetcher, undefined, now);
  expect(request!.searchParams.get("viewbox")!.split(",").map(Number)[2]).toBe(180);
  await expect(searchNearbyPlaces({ query: "thai", latitude: 0, longitude: 0, openNow: true }, fetcher)).rejects.toThrow("timeZone");
});

test("routes keep measured geometry and legs, and refuse partial routes", async () => {
  const stops = [
    { id: "a", latitude: 40.748, longitude: -73.985 },
    { id: "b", latitude: 40.753, longitude: -73.982 },
  ];
  let body: any;
  const fetcher = (async (_url: URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ routes: [{ distance: 700, duration: 540, geometry: { type: "LineString", coordinates: [[-73.985, 40.748], [-73.983, 40.75], [-73.982, 40.753]] }, legs: [{ distance: 700, duration: 540, steps: [{ maneuver: { instruction: "Walk north." } }, { maneuver: { instruction: "  " } }] }] }] });
  }) as Fetcher;
  const { route } = await routePlaces({ places: stops, mode: "walking" }, fetcher);
  expect(body.costing).toBe("pedestrian");
  expect(PlaceRouteSchema.safeParse(route).success).toBe(true);
  expect(route.id).toMatch(/^route:[0-9a-f-]{13}$/); // passed back by reference instead of copying the geometry
  expect(route.geometry.coordinates).toHaveLength(3);
  expect(route.legs).toEqual([{ fromPlaceId: "a", toPlaceId: "b", distanceMeters: 700, durationSeconds: 540, instructions: ["Walk north."] }]);
  await expect(routePlaces({ places: stops, mode: "walking" }, json({ routes: [{ legs: [] }] }))).rejects.toThrow("every stop");
  await expect(routePlaces({ places: [stops[0]!, stops[0]!], mode: "walking" }, fetcher)).rejects.toThrow("distinct");
});

test("tool calls validate arguments and report service failures as tool errors", async () => {
  const bad = await callTool("SearchNearbyPlaces", { query: "thai" }, json([]));
  expect(bad.isError).toBe(true);
  expect(bad.content[0]!.text).toContain("Invalid tool arguments");
  const busy = await callTool("SearchPlaces", { query: "Louvre" }, (async () => new Response("busy", { status: 502 })) as Fetcher);
  expect(busy).toEqual({ isError: true, content: [{ type: "text", text: "Photon returned HTTP 502. No places or routes were made up; retry shortly." }] });
  const ok = await callTool("SearchPlaces", { query: "Louvre" }, json({ features: [] }));
  expect(JSON.parse(ok.content[0]!.text).places).toEqual([]);
});
