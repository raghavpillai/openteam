// Live checks against Google. They run only with a real key:
//   GOOGLE_MAPS_LIVE_API_KEY=… bun test packages/plugins/google-maps/connector/test/live.test.ts
// Each run makes about a dozen requests, inside Google's monthly free allowance.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkKey, getPlaceDetails, resetGoogleState, routePlaces, searchNearbyPlaces, searchPlaces } from "../google";

const live = process.env.GOOGLE_MAPS_LIVE_API_KEY;
const previous = process.env.GOOGLE_MAPS_API_KEY;
beforeAll(() => {
  if (live) process.env.GOOGLE_MAPS_API_KEY = live;
  resetGoogleState();
});
afterAll(() => {
  if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previous;
});

test.skipIf(!live)("the key works for Places API (New) and Routes API", async () => {
  const check = await checkKey();
  expect(check.places).toEqual({ ok: true, message: "Places API (New) works with this key." });
  expect(check.routes).toEqual({ ok: true, message: "Routes API works with this key." });
});

test.skipIf(!live)("an invalid key is reported as invalid for both APIs, not as an outage", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "AIzaSyInvalidKeyForOpenTeamTests0000000";
  try {
    const check = await checkKey();
    for (const api of [check.places, check.routes]) expect(api).toMatchObject({ ok: false, reason: "API_KEY_INVALID", definitive: true });
  } finally {
    process.env.GOOGLE_MAPS_API_KEY = live!;
  }
});

test.skipIf(!live)("search, nearby, details, photos and routes return real, well-formed data", async () => {
  const penn = await searchPlaces({ query: "Penn Station, New York", limit: 1, photos: false });
  const center = penn.results[0]!.place;
  expect(center.latitude).toBeCloseTo(40.75, 1);
  const nearby = await searchNearbyPlaces({ query: "thai restaurant", latitude: center.latitude, longitude: center.longitude, limit: 3 });
  expect(nearby.results.length).toBeGreaterThan(0);
  for (const { place, distanceMeters } of nearby.results) {
    expect(distanceMeters).toBeLessThanOrEqual(1500);
    expect(place.provider).toBe("Google Maps");
    if (place.rating !== undefined) expect(place.reviewCount).toBeGreaterThan(0); // brand-new places can be unrated
    if (place.imageUrl) expect(place.imageUrl).not.toContain("key=");
  }
  const photo = nearby.results.find((entry) => entry.place.imageUrl)?.place.imageUrl;
  if (photo) expect((await fetch(photo)).headers.get("content-type")).toStartWith("image/");
  const details = await getPlaceDetails({ placeId: nearby.results[0]!.place.id, photos: false });
  expect(details.reviews.length).toBeGreaterThan(0);
  expect(details.reviews[0]!.text?.length).toBeGreaterThan(0);
  const { route } = await routePlaces({ places: [center, nearby.results[0]!.place], mode: "walking" });
  expect(route.distanceMeters).toBeGreaterThan(0);
  expect(route.geometry.coordinates.length).toBeGreaterThan(1);
  expect(route.legs).toHaveLength(1);
}, 60_000);
