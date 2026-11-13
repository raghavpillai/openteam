import { afterEach, beforeEach, expect, test } from "bun:test";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import { checkKey, explainGoogleError, getPlaceDetails, resetGoogleState, routePlaces, searchNearbyPlaces, searchPlaces, todaysHours, type Fetcher } from "../google";
import { callTool, listTools, resetKeyVerification, tools } from "../server";

const KEY = "AIza-test-key-never-shown";
beforeEach(() => {
  resetGoogleState();
  resetKeyVerification();
  process.env.GOOGLE_MAPS_API_KEY = KEY;
});
afterEach(() => delete process.env.GOOGLE_MAPS_API_KEY);

type Call = { url: string; init: RequestInit };
const recorder = (respond: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const value = respond(call);
    return value instanceof Response ? value : Response.json(value);
  }) as unknown as Fetcher;
  return { calls, fetcher };
};
const week = ["Monday: 11:00 AM – 10:00 PM", "Tuesday: 11:00 AM – 10:00 PM", "Wednesday: 11:00 AM – 10:00 PM", "Thursday: 11:30 AM – 9:30 PM", "Friday: 11:00 AM – 11:00 PM", "Saturday: 12:00 – 11:00 PM", "Sunday: Closed"];
const place = (id: string, name: string, latitude: number, extra: Record<string, unknown> = {}) => ({
  id, displayName: { text: name }, formattedAddress: "460 9th Ave, New York, NY 10018, USA", location: { latitude, longitude: -73.9935 },
  primaryTypeDisplayName: { text: "Thai Restaurant" }, googleMapsUri: `https://maps.google.com/?cid=${id}`, websiteUri: "http://zoobzib.example/",
  rating: 4.5, userRatingCount: 1234, priceLevel: "PRICE_LEVEL_MODERATE", utcOffsetMinutes: -300,
  currentOpeningHours: { openNow: true, weekdayDescriptions: week }, internationalPhoneNumber: "+1 212-555-0100",
  photos: [{ name: `places/${id}/photos/AbC`, authorAttributions: [{ displayName: "Dana" }] }], ...extra,
});
const NOW = new Date("2026-11-12T20:00:00Z"); // Thursday 15:00 in New York

test("Bots get five read-only tools with bounded inputs", () => {
  expect(tools.map((tool) => tool.name)).toEqual(["SearchPlaces", "SearchNearbyPlaces", "GetPlaceDetails", "CheckGoogleMapsKey", "RoutePlaces"]);
  for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  const valid = (name: string, args: unknown) => createToolValidator(tools.find((tool) => tool.name === name)!.inputSchema)(args).valid;
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75, longitude: -73.99, rankBy: "distance", minRating: 4.5 })).toBe(true);
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75 })).toBe(false);
  expect(valid("SearchNearbyPlaces", { query: "thai", latitude: 40.75, longitude: -73.99, rankBy: "rating" })).toBe(false);
  expect(valid("RoutePlaces", { places: [{ id: "a", latitude: 1, longitude: 1 }], mode: "walking" })).toBe(false);
  expect(valid("GetPlaceDetails", { placeId: "short" })).toBe(false);
});

test("the key goes in a header, never a URL, and a missing key is explained without a request", async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  const { calls, fetcher } = recorder(() => ({ places: [] }));
  const missing = await callTool("SearchPlaces", { query: "Penn Station" }, fetcher);
  expect(missing.isError).toBe(true);
  expect(missing.content[0]!.text).toContain("account settings");
  expect(calls).toHaveLength(0);
  process.env.GOOGLE_MAPS_API_KEY = KEY;
  await searchPlaces({ query: "Penn Station", photos: true }, recorder(() => ({ places: [place("ChIJpenn000000", "Penn Station", 40.7506)] })).fetcher);
  const { calls: photoCalls, fetcher: f2 } = recorder((call) =>
    call.url.includes("/media") ? { photoUri: "https://lh3.googleusercontent.com/p/abc=s1200" } : { places: [place("ChIJpenn000000", "Penn Station", 40.7506)] }
  );
  resetGoogleState();
  const result = await searchPlaces({ query: "Penn Station" }, f2, undefined, NOW);
  for (const call of photoCalls) {
    expect(call.url).not.toContain(KEY);
    expect((call.init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe(KEY);
  }
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(photoCalls[1]!.url).toBe("https://places.googleapis.com/v1/places/ChIJpenn000000/photos/AbC/media?maxWidthPx=1200&skipHttpRedirect=true");
});

test("search returns presentation places with Google ratings, today's hours, price, photo credit and provenance", async () => {
  const { calls, fetcher } = recorder((call) =>
    call.url.includes("/media") ? { photoUri: "https://lh3.googleusercontent.com/p/abc=s1200" } : { places: [place("ChIJzoob00000", "Zoob Zib", 40.7544)] }
  );
  const result = await searchPlaces({ query: "thai near penn", latitude: 40.75, longitude: -73.99, openNow: true, minRating: 4 }, fetcher, undefined, NOW);
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body).toMatchObject({ textQuery: "thai near penn", openNow: true, minRating: 4, locationBias: { circle: { radius: 5000 } } });
  const mask = (calls[0]!.init.headers as Record<string, string>)["X-Goog-FieldMask"];
  for (const field of ["places.rating", "places.userRatingCount", "places.photos", "places.currentOpeningHours.openNow", "places.utcOffsetMinutes"]) expect(mask).toContain(field);
  expect(mask).not.toContain("places.reviews");
  expect(result.results[0]).toEqual({
    place: {
      id: "google:ChIJzoob00000", name: "Zoob Zib", latitude: 40.7544, longitude: -73.9935,
      address: "460 9th Ave, New York, NY 10018, USA", category: "Thai Restaurant · $$",
      imageUrl: "https://lh3.googleusercontent.com/p/abc=s1200", websiteUrl: "https://zoobzib.example/",
      rating: 4.5, reviewCount: 1234, isOpen: true, hours: "Thursday: 11:30 AM – 9:30 PM",
      provider: "Google Maps", sourceUrl: "https://maps.google.com/?cid=ChIJzoob00000", attribution: "Google Maps · Photo: Dana",
    },
    phone: "+1 212-555-0100",
    priceLevel: "$$",
  });
});

test("today's hours follow the place's offset, including across midnight UTC", () => {
  expect(todaysHours(week, -300, new Date("2026-11-13T03:00:00Z"))).toBe("Thursday: 11:30 AM – 9:30 PM"); // 22:00 Thursday in New York
  expect(todaysHours(week, 540, new Date("2026-11-12T20:00:00Z"))).toBe("Friday: 11:00 AM – 11:00 PM"); // 05:00 Friday in Tokyo
  expect(todaysHours(week.slice(1), 0)).toBeUndefined();
});

test("nearby search restricts to the radius, can sort by distance, and marks closed businesses", async () => {
  const { calls, fetcher } = recorder(() => ({
    places: [
      place("ChIJfar000000", "Far but loved", 40.7606),
      place("ChIJnear00000", "Near", 40.751),
      place("ChIJout000000", "Outside", 40.8),
      place("ChIJshut00000", "Shut", 40.7508, { businessStatus: "CLOSED_PERMANENTLY", currentOpeningHours: undefined }),
    ],
  }));
  const result = await searchNearbyPlaces({ query: "thai restaurant", latitude: 40.7506, longitude: -73.9935, rankBy: "distance", photos: false }, fetcher, undefined, NOW);
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body.rankPreference).toBe("DISTANCE");
  expect(body.locationRestriction.rectangle.low.latitude).toBeCloseTo(40.7371, 3);
  expect(result.results.map((entry) => [entry.place.name, entry.distanceMeters])).toEqual([["Shut", 22], ["Near", 44], ["Far but loved", 1112]]);
  expect(result.results[0]!.place).toMatchObject({ isOpen: false, hours: "Permanently closed" });
  expect(calls).toHaveLength(1);
});

test("details return up to five reviews with authors, Google's summaries and the week", async () => {
  const reviews = Array.from({ length: 6 }, (_, i) => ({
    rating: 5 - (i % 2), text: { text: `Review ${i}` }, authorAttribution: { displayName: `Author ${i}` },
    relativePublishTimeDescription: "a month ago", publishTime: "2026-10-01T00:00:00Z", googleMapsUri: `https://www.google.com/maps/reviews/${i}`,
  }));
  const { calls, fetcher } = recorder(() => place("ChIJzoob00000", "Zoob Zib", 40.7544, {
    reviews, reviewSummary: { text: { text: "People love the duck noodles." } }, generativeSummary: { overview: { text: "Cozy Thai noodle bar." } },
  }));
  const result = await getPlaceDetails({ placeId: "google:ChIJzoob00000", photos: false }, fetcher, undefined, NOW);
  expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places/ChIJzoob00000");
  expect((calls[0]!.init.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("reviews");
  expect(result.reviews).toHaveLength(5);
  expect(result.reviews[0]).toEqual({ rating: 5, text: "Review 0", author: "Author 0", when: "a month ago", publishedAt: "2026-10-01T00:00:00Z", url: "https://www.google.com/maps/reviews/0" });
  expect(result.reviewSummary).toBe("People love the duck noodles.");
  expect(result.overview).toBe("Cozy Thai noodle bar.");
  expect(result.weekHours).toHaveLength(7);
  await expect(getPlaceDetails({ placeId: "../../etc" }, fetcher)).rejects.toThrow("Google place id");
});

test("routes keep Google's geometry and legs, map travel modes, and refuse partial routes", async () => {
  const stops = [
    { id: "a", latitude: 40.748, longitude: -73.985 },
    { id: "b", latitude: 40.75, longitude: -73.983 },
    { id: "c", latitude: 40.753, longitude: -73.982 },
  ];
  const { calls, fetcher } = recorder(() => ({
    routes: [{
      distanceMeters: 900, duration: "720s",
      polyline: { geoJsonLinestring: { type: "LineString", coordinates: [[-73.985, 40.748], [-73.983, 40.75], [-73.982, 40.753]] } },
      legs: [
        { distanceMeters: 400, duration: "320s", steps: [{ navigationInstruction: { instructions: "Head north" } }] },
        { distanceMeters: 500, duration: "400s", steps: [] },
      ],
    }],
  }));
  const { route } = await routePlaces({ places: stops, mode: "walking" }, fetcher);
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body).toMatchObject({ travelMode: "WALK", polylineEncoding: "GEO_JSON_LINESTRING" });
  expect(body.routingPreference).toBeUndefined();
  expect(body.intermediates).toHaveLength(1);
  expect(route).toMatchObject({ distanceMeters: 900, durationSeconds: 720, provider: "Google Maps" });
  expect(route.legs.map((leg: any) => [leg.fromPlaceId, leg.toPlaceId, leg.durationSeconds])).toEqual([["a", "b", 320], ["b", "c", 400]]);
  await routePlaces({ places: stops, mode: "driving" }, fetcher);
  expect(JSON.parse(String(calls[1]!.init.body)).routingPreference).toBe("TRAFFIC_AWARE");
  const partial = recorder(() => ({ routes: [{ legs: [], polyline: { geoJsonLinestring: { coordinates: [] } } }] }));
  await expect(routePlaces({ places: stops, mode: "walking" }, partial.fetcher)).rejects.toThrow("every stop");
});

test("Google errors come back as tool errors with Google's reason and without the key", async () => {
  const { fetcher } = recorder(() => Response.json(
    { error: { code: 403, message: `Places API (New) has not been used in project 123 before or it is disabled. key=${KEY}`, status: "PERMISSION_DENIED" } },
    { status: 403 }
  ));
  const result = await callTool("SearchPlaces", { query: "Louvre" }, fetcher);
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("Google Maps (Places API (New)) returned 403: Places API (New) has not been used");
  expect(result.content[0]!.text).not.toContain(KEY);
  const invalid = await callTool("SearchNearbyPlaces", { query: "thai" }, fetcher);
  expect(invalid.content[0]!.text).toContain("Invalid tool arguments");
});

const googleError = (status: number, reason: string, service: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { code: status, message: `${reason} from Google`, status: "X", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com", metadata: { service, ...extra } }] } }, { status });

test("each Google error reason becomes a specific fix, and only configuration errors are definitive", () => {
  const explain = (status: number, reason: string, extra = {}) => {
    const error = explainGoogleError(status, { error: { message: "x", details: [{ reason, metadata: extra }] } }, "Routes API", KEY);
    return [error.message, error.definitive] as const;
  };
  expect(explain(400, "API_KEY_INVALID")[0]).toContain("API key isn't valid");
  expect(explain(403, "SERVICE_DISABLED", { activationUrl: "https://console.developers.google.com/apis/api/routes.googleapis.com/overview?project=1" })[0])
    .toBe("Routes API isn't enabled for this key's Google Cloud project. Enable it at https://console.developers.google.com/apis/api/routes.googleapis.com/overview?project=1, wait a few minutes, then reconnect.");
  expect(explain(403, "SERVICE_DISABLED")[0]).toContain("https://console.cloud.google.com/apis/library/routes.googleapis.com");
  expect(explain(403, "API_KEY_SERVICE_BLOCKED")[0]).toContain("API restrictions don't include Routes API");
  expect(explain(403, "ACCESS_DENIED")[0]).toContain("can't use Routes API");
  expect(explain(403, "BILLING_DISABLED")[0]).toContain("Billing isn't enabled");
  expect(explain(403, "API_KEY_HTTP_REFERRER_BLOCKED")[0]).toContain("website referrers");
  expect(explain(403, "API_KEY_IP_ADDRESS_BLOCKED")[0]).toContain("IP address restriction");
  for (const reason of ["API_KEY_INVALID", "SERVICE_DISABLED", "ACCESS_DENIED", "BILLING_DISABLED"]) expect(explain(403, reason)[1]).toBe(true);
  expect(explain(429, "RATE_LIMIT_EXCEEDED")[1]).toBe(false);
  const quota = explainGoogleError(429, null, "Places API (New)");
  expect([quota.reason, quota.definitive]).toEqual(["HTTP_429", false]);
  const unknown = explainGoogleError(500, { error: { message: `boom ${KEY}` } }, "Places API (New)", KEY);
  expect(unknown.message).toBe("Google Maps (Places API (New)) returned 500: boom [key]");
  expect(unknown.definitive).toBe(false);
});

test("checkKey proves both APIs with the cheapest requests and reports each one separately", async () => {
  const both = recorder((call) => (call.url.includes("routes.googleapis.com") ? { routes: [{ distanceMeters: 984 }] } : { places: [{ id: "ChIJeiffel000" }] }));
  expect(await checkKey(both.fetcher)).toEqual({
    ok: true,
    places: { ok: true, message: "Places API (New) works with this key." },
    routes: { ok: true, message: "Routes API works with this key." },
  });
  const masks = both.calls.map((call) => (call.init.headers as Record<string, string>)["X-Goog-FieldMask"]).sort();
  expect(masks).toEqual(["places.id", "routes.distanceMeters"]);
  const noRoutes = recorder((call) => (call.url.includes("routes.googleapis.com") ? googleError(403, "ACCESS_DENIED", "routes.googleapis.com") : { places: [{ id: "x" }] }));
  const partial = await checkKey(noRoutes.fetcher);
  expect(partial.ok).toBe(false);
  expect(partial.places.ok).toBe(true);
  expect(partial.routes).toMatchObject({ ok: false, reason: "ACCESS_DENIED", definitive: true });
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as Fetcher;
  const down = await checkKey(offline);
  expect(down.places).toMatchObject({ ok: false, reason: "UNREACHABLE", definitive: false });
  delete process.env.GOOGLE_MAPS_API_KEY;
  await expect(checkKey(both.fetcher)).rejects.toThrow("No Google Maps API key");
  process.env.GOOGLE_MAPS_API_KEY = "${GOOGLE_MAPS_API_KEY}";
  await expect(checkKey(both.fetcher)).rejects.toThrow("No Google Maps API key");
});

test("connecting fails with the fix when the key or an API is misconfigured, but not when Google is unreachable", async () => {
  const invalid = recorder((call) => googleError(400, "API_KEY_INVALID", call.url.includes("routes") ? "routes.googleapis.com" : "places.googleapis.com"));
  const message = await listTools(invalid.fetcher).then(() => "", (error: Error) => error.message);
  expect(message).toBe("The Google Maps API key isn't valid. Check it, or create a new one, in this plugin's account settings.");
  const disabled = recorder((call) =>
    call.url.includes("routes") ? googleError(403, "SERVICE_DISABLED", "routes.googleapis.com", { activationUrl: "https://console.developers.google.com/apis/api/routes.googleapis.com/overview?project=7" }) : { places: [{ id: "x" }] }
  );
  await expect(listTools(disabled.fetcher)).rejects.toThrow("Routes API isn't enabled");
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as Fetcher;
  expect((await listTools(offline)).map((tool) => tool.name)).toContain("SearchPlaces");
  const good = recorder((call) => (call.url.includes("routes") ? { routes: [{ distanceMeters: 1 }] } : { places: [{ id: "x" }] }));
  resetKeyVerification();
  const t0 = Date.now();
  await listTools(good.fetcher, t0);
  await listTools(good.fetcher, t0 + 60_000);
  expect(good.calls).toHaveLength(2); // verified once (both APIs), then reused for 30 minutes
  await listTools(good.fetcher, t0 + 31 * 60_000);
  expect(good.calls).toHaveLength(4);
});

test("the check tool is callable like any other tool", async () => {
  const good = recorder((call) => (call.url.includes("routes") ? { routes: [{ distanceMeters: 1 }] } : { places: [{ id: "x" }] }));
  const result = await callTool("CheckGoogleMapsKey", {}, good.fetcher);
  expect(JSON.parse(result.content[0]!.text).ok).toBe(true);
});
