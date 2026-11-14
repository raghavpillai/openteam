import { expect, test } from "bun:test";
import fixture from "../../../apps/ios/Tests/CoreTests/Fixtures/presentation.json";
import { normalizePlace, parsePresentation, presentationFallback } from "../src/presentation";
import { normalizeMainToolArguments } from "../src/reference-main-parsers";
import { NATIVE_TOOLS, CURSOR_TOOLS } from "../src";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";

test("the agent's schema and send parser accept the same native presentation as iOS", () => {
  const input = { type: "presentation", presentation: fixture, end_turn: true };
  const tool = NATIVE_TOOLS.find((tool) => tool.name === "SendToUser")!;
  expect(createToolValidator(tool.inputSchema)(input).valid).toBe(true);
  const parsed = normalizeMainToolArguments("SendToUser", input);
  expect(parsed.end_turn).toBe(true);
  expect(parsed.presentation.blocks[0].route.geometry.coordinates[0]).toEqual([
    -73.985847, 40.748191,
  ]);
  expect(presentationFallback(parsed.presentation)).toContain("New York Public Library");
});

test("ChatGPT POI envelopes preserve coordinates and source metadata without inventing missing fields", () => {
  const place = normalizePlace({
    name: "Library",
    latitude: 40.753,
    longitude: -73.982,
    entity: {
      entity_lookup_id: "provider-library",
      rating: 4.6,
      review_count: 20,
      is_open: false,
      provider: "Example provider",
      provider_url: "https://example.com/place",
      image_url: "https://example.com/photo.jpg",
    },
  });
  expect(place).toMatchObject({
    id: "provider-library",
    latitude: 40.753,
    longitude: -73.982,
    rating: 4.6,
    reviewCount: 20,
    isOpen: false,
    sourceUrl: "https://example.com/place",
  });
  const bare = normalizePlace({ id: "bare", name: "Park", latitude: 1, longitude: 2 });
  expect(bare.rating).toBeUndefined();
  expect(bare.isOpen).toBeUndefined();
  expect(bare.imageUrl).toBeUndefined();
});

test("malformed coordinates, unsafe links and disconnected route stops are rejected before delivery", () => {
  const copy = () => structuredClone(fixture);
  const badLatitude = copy();
  badLatitude.places[0]!.latitude = 100;
  const missingPlace = copy();
  missingPlace.places.pop();
  const wrongOrder = copy();
  wrongOrder.blocks[0]!.placeIds!.reverse();
  const badRoute = copy();
  badRoute.blocks[0]!.route!.geometry.coordinates[0] = [40, -120];
  const unsafeImage = copy();
  Object.assign(unsafeImage.places[0]!, { imageUrl: "javascript:alert(1)" });
  for (const value of [badLatitude, missingPlace, wrongOrder, badRoute, unsafeImage])
    expect(() => parsePresentation(value)).toThrow();
  expect(() =>
    normalizeMainToolArguments("SendToUser", {
      type: "presentation",
      presentation: fixture,
      html: "<script/>",
    })
  ).toThrow();
});

test("agents may name places and routes by id; delivery requires them resolved", async () => {
  const { PresentationSendSchema, presentationReferences, resolvePresentationReferences, parsePresentation } = await import("../src/presentation");
  const input = {
    version: 1,
    places: ["google:a", { id: "google:b", notes: "Order the duck." }, { id: "web:c", name: "C", latitude: 1, longitude: 2 }],
    blocks: [
      { type: "place_map", placeIds: ["google:a", "google:b"], route: "route:1" },
      { type: "ranked_media_list", items: [{ id: "1", title: "A", placeId: "google:a" }] },
    ],
  };
  expect(PresentationSendSchema.safeParse({ type: "presentation", presentation: input }).success).toBe(true);
  // Block ids must still name a listed place, reference or not.
  expect(PresentationSendSchema.safeParse({ type: "presentation", presentation: { ...input, blocks: [{ type: "place_map", placeIds: ["google:z"] }] } }).success).toBe(false);
  expect(presentationReferences(input)).toEqual({ places: ["google:a", "google:b"], routes: ["route:1"] });
  expect(() => parsePresentation(input)).toThrow("Unresolved references: google:a, google:b, route:1");

  const a = { id: "google:a", name: "A", latitude: 40.75, longitude: -73.99, rating: 4.6, imageUrl: "https://lh3.googleusercontent.com/a", provider: "Google Maps", sourceUrl: "https://maps.google.com/?cid=1" };
  const b = { id: "google:b", name: "B", latitude: 40.76, longitude: -73.98, notes: "tool note" };
  const route = { id: "route:1", mode: "walking", geometry: { type: "LineString", coordinates: [[-73.99, 40.75], [-73.98, 40.76]] }, distanceMeters: 900, durationSeconds: 700,
    legs: [{ fromPlaceId: "google:a", toPlaceId: "google:b", distanceMeters: 900, durationSeconds: 700 }] };
  const resolved = parsePresentation(resolvePresentationReferences(input, new Map([["google:a", a], ["google:b", b]] as any), new Map([["route:1", route]] as any)));
  expect(resolved.places.map((place) => place.name)).toEqual(["A", "B", "C"]);
  expect(resolved.places[1]!.notes).toBe("Order the duck."); // the agent's words win over the tool's
  expect((resolved.blocks[0] as any).route.distanceMeters).toBe(900);
});

test("plugin results are indexed from their own JSON only, never from text they relay", async () => {
  const { presentationReferencesInResult } = await import("../src/presentation");
  const place = { id: "google:a", name: "A", latitude: 40.75, longitude: -73.99, rating: 4.5 };
  const route = { id: "route:1", mode: "walking", geometry: { type: "LineString", coordinates: [[-73.99, 40.75], [-73.98, 40.76]] }, distanceMeters: 1, durationSeconds: 1,
    legs: [{ fromPlaceId: "google:a", toPlaceId: "google:b", distanceMeters: 1, durationSeconds: 1 }] };
  const index = presentationReferencesInResult([
    JSON.stringify({ results: [{ place, distanceMeters: 3 }, { place: { id: "google:bad", name: "No coordinates" } }], route }),
    // An email body or page that happens to be JSON stays text.
    JSON.stringify({ body: JSON.stringify({ id: "google:evil", name: "Evil", latitude: 1, longitude: 1, rating: 5 }) }),
    "Large output has been written to: /workspace/x.json",
  ])!;
  expect(index.places.map((p) => p.id)).toEqual(["google:a"]);
  expect(index.routes.map((r) => r.id)).toEqual(["route:1"]);
  expect(presentationReferencesInResult(["plain text", "{broken"])).toBeUndefined();
});
