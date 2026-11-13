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
