import { expect, test } from "bun:test";
import { searchPlaces, routePlaces, type PlaceFetcher } from "../src/services/place-data";

const points = [
  { id: "a", name: "A", latitude: 40.748, longitude: -73.985 },
  { id: "b", name: "B", latitude: 40.753, longitude: -73.982 },
];
test("Photon coordinates are converted once, keeping provenance and unknown business metadata absent", async () => {
  let request: URL | undefined;
  const fetcher = (async (url: URL) => {
    request = url;
    return Response.json({
      features: [
        {
          geometry: { type: "Point", coordinates: [-73.985, 40.748] },
          properties: {
            osm_type: "W",
            osm_id: 42,
            name: "A",
            osm_key: "building",
            osm_value: "yes",
            street: "5th Avenue",
            housenumber: "350",
            city: "New York",
          },
        },
        { geometry: { type: "Point", coordinates: [-73, 140] }, properties: { name: "Invalid" } },
      ],
    });
  }) as PlaceFetcher;
  const result = (await searchPlaces(
    { query: "NYC library test fixture", latitude: 40.75, longitude: -73.98 },
    fetcher
  )) as any;
  expect(request!.searchParams.get("lon")).toBe("-73.98");
  expect(result.places).toHaveLength(1);
  expect(result.places[0]).toMatchObject({
    id: "osm:way:42",
    latitude: 40.748,
    longitude: -73.985,
    category: "building",
    sourceUrl: "https://www.openstreetmap.org/way/42",
  });
  expect(result.places[0].rating).toBeUndefined();
  expect(result.places[0].isOpen).toBeUndefined();
});
test("Valhalla receives lat/lon stops and returns unchanged GeoJSON with measured per-leg travel", async () => {
  let sent: any;
  const fetcher = (async (_: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return Response.json({
      routes: [
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [-73.985, 40.748],
              [-73.983, 40.749],
              [-73.982, 40.753],
            ],
          },
          distance: 734,
          duration: 554,
          legs: [{ distance: 734, duration: 554 }],
        },
      ],
    });
  }) as PlaceFetcher;
  const { route } = await routePlaces({ places: points, mode: "walking" }, fetcher);
  expect(sent).toMatchObject({
    costing: "pedestrian",
    format: "osrm",
    shape_format: "geojson",
    locations: [
      { lat: 40.748, lon: -73.985, type: "break" },
      { lat: 40.753, lon: -73.982, type: "break" },
    ],
  });
  expect(route.geometry.coordinates[0]).toEqual([-73.985, 40.748]);
  expect(route.legs[0]).toMatchObject({
    fromPlaceId: "a",
    toPlaceId: "b",
    durationSeconds: 554,
    distanceMeters: 734,
  });
  await expect(
    routePlaces({ places: points, mode: "walking" }, (async () =>
      Response.json({ routes: [] })) as PlaceFetcher)
  ).rejects.toThrow("every stop");
  await expect(
    routePlaces(
      { places: points, mode: "walking" },
      (async () => new Response("unavailable", { status: 503 })) as PlaceFetcher
    )
  ).rejects.toThrow("503");
});
