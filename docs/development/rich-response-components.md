# Maps and ranked media responses

The agent sends data through `SendToUser`, and each client owns the layout. Maps and ranked media render inside the app's normal assistant chat bubble, with the real message spacing, actions and composer around them. The agent can interleave Markdown with the native components; it never has to generate HTML or CSS.

The component contract belongs in the tool schema, with short selection guidance in the tool description. A skill can teach a travel or research workflow, but is not required to render a map or list. No extra UI agent is required.

## Agent flow

1. Discover `SearchPlaces` and `RoutePlaces` using `GetDynamicTools` in the `cursor` namespace.
2. Search for specific names and addresses. Check the returned city and branch, even with a single result. Supply both bias coordinates when useful.
3. For directions, pass the chosen places in visit order to `RoutePlaces`. Keep its measured GeoJSON geometry and leg data unchanged. For pins alone, omit the route.
4. Call `SendToUser` with `type: "presentation"`, a versioned payload, and the usual `end_turn`. Narrative goes in Markdown blocks in the desired order.

```json
{
  "type": "presentation",
  "presentation": {
    "version": 1,
    "places": [
      {
        "id": "osm:way:34633854",
        "name": "Empire State Building",
        "latitude": 40.7484421,
        "longitude": -73.9856589,
        "address": "350 5th Avenue, New York",
        "provider": "OpenStreetMap",
        "sourceUrl": "https://www.openstreetmap.org/way/34633854"
      }
    ],
    "blocks": [
      { "type": "markdown", "text": "Start with this landmark." },
      {
        "type": "place_map",
        "title": "Midtown Manhattan",
        "placeIds": ["osm:way:34633854"],
        "carousel": "auto"
      },
      {
        "type": "ranked_media_list",
        "items": [
          {
            "id": "first",
            "title": "Empire State Building",
            "description": "An Art Deco landmark with observation decks.",
            "placeId": "osm:way:34633854",
            "href": "https://www.esbnyc.com/"
          }
        ]
      }
    ]
  },
  "end_turn": true
}
```

The schema and JSON-schema tool definition live in `packages/contracts/src/presentation.ts`. Limits: 50 places, 20 ordered blocks, 50 media items per list, 20,000 route vertices. Routing requests accept 2–10 stops. IDs must resolve; route legs must connect the map's stops in order. Links and image URLs use HTTPS without embedded credentials.

Place coordinates are named **latitude / longitude**. Route vertices are GeoJSON **[longitude, latitude]** pairs. The server validates both before persisting a message. `normalizePlace` also accepts the observed ChatGPT point/entity POI envelope, preserving coordinates, provider IDs, imagery, ratings and source URLs when present. It does not turn an unresolved name into coordinates.

Optional place fields include `imageUrl`, `rating` (0–5), `reviewCount`, `isOpen`, `hours`, `category`, `icon`, `notes`, `description`, `websiteUrl`, `provider`, `sourceUrl`, and `attribution`. Include business metadata only when supplied by a verified source. Missing images get a neutral placeholder; missing ratings and opening status are omitted. A ranked item can use its own image or inherit its referenced place's image.

A `place_map` may carry the `route` object returned by `RoutePlaces`: mode, LineString geometry, distance in meters, duration in seconds, and ordered legs. `carousel: "hidden"` gives a clean route-only map. Fullscreen remains available in either mode. No composer or Ask button is included.

## Providers and configuration

There was no bundled map search/routing plugin. The new first-party tools provide a baseline without an API key:

| Purpose | Default | Configuration |
| --- | --- | --- |
| POI search / geocoding | Photon / OpenStreetMap | `OPENTEAM_GEOCODER_URL` (default `https://photon.komoot.io/api/`) |
| Walking, driving, cycling routes | Valhalla / OpenStreetMap | `OPENTEAM_ROUTER_URL` (default `https://valhalla1.openstreetmap.de/route`) |
| Desktop map rendering | MapLibre GL with OpenFreeMap tiles | Client style in `presentation/map-style.ts` |
| iOS map rendering | Native Apple MapKit | Automatic light/dark appearance |

Desktop keeps MapLibre/OpenStreetMap with an Apple-inspired palette, blue route accents, translucent place cards and rounded controls. It requires no Apple Maps token. Street geometry, labels and POI artwork come from the selected map source, so they are not identical to Apple's basemap. The native iOS view uses Apple's built-in MapKit SDK, which also needs no MapKit JS browser token. A browser token is relevant only to an app that chooses Apple's web renderer; it is managed by the app operator, not by every end user.

Set a data provider URL to `off` to disable its tool's requests. Custom endpoints must implement the corresponding Photon/Valhalla API. A managed or self-hosted endpoint is appropriate for production traffic; the public defaults are community services without a service guarantee. Search queries and optional bias coordinates go to the geocoder; selected stop coordinates go to the router. The map renderer separately requests tiles and fonts. Search results are cached server-side for ten minutes, with a 200-query bound; requests time out after fifteen seconds.

Photon supplies names, coordinates, categories and addresses. It does **not** supply business photos, star ratings or live opening hours. The contract can carry those from a separately configured provider or verified research, but this change does not install or configure a commercial Places account. Do not imply that a map tile subscription also provides a licensed business directory. Existing WebSearch/WebFetch remain useful for source verification.

References: [Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md), [Valhalla routing API](https://valhalla.github.io/valhalla/api/route/api-reference/), [OpenFreeMap](https://openfreemap.org/quick_start/), [MapKit for SwiftUI](https://developer.apple.com/documentation/mapkit/mapkit-for-swiftui).

## Client behavior and transport

- Desktop: lazy MapLibre renderer, day/night vector styles, numbered route pins, dotted measured geometry, horizontally scrollable cards, selected-card/pin synchronization, fullscreen map and independently scrollable itinerary, keyboard dismissal and focus restoration. Offscreen maps dispose their WebGL context. On narrow windows, the itinerary sits below the map.
- iOS: native MapKit annotations and route overlay, horizontal cards with automatic selection scrolling, full-screen cover with a scrollable itinerary, and an iPad side-by-side layout. Theme colors follow the app. Source links open with native link handling.
- Ranked lists use ordered titles, rounded thumbnails, descriptions and optional source links, with the app's existing typography.
- Messages retain a readable text fallback for notifications, history, older clients and invalid payloads. `presentation` uses the existing durable message metadata path; it is not a pending approval or question card. Like the other rich cards, delivery is currently supported in the Bot's private chat, not group-room or external connector posts.

The ChatGPT reference inspected in the supplied thread used a web Mapbox GL renderer, a resolved map/POI payload, and inline component markup for media lists. That observation is not a published stable API or evidence of a separate map agent. OpenTeam uses its own versioned contract and licensed/public map sources; no ChatGPT private tokens, styles or backend endpoints are required.

## Verification

`packages/contracts/test/presentation.test.ts` and `apps/ios/Tests/CoreTests/PresentationTests.swift` consume the same fixture at `apps/ios/Tests/CoreTests/Fixtures/presentation.json`. They check coordinate order, reference validation and native block decoding. Server provider tests cover coordinate conversion, routing format, provenance, missing metadata and provider errors. Messaging tests check the delivery branch.

The desktop browser fixture is `apps/desktop/test/browser/presentation.html`. The native `PresentationUITests` uses the loopback parity server on port 20180 (`SWIFT_PARITY_PORT=20180 bun apps/ios/scripts/parity-server.ts`) and covers carousel scrolling, fullscreen opening/closing, and ranked media in both appearances. Fixture POIs and route geometry are examples, not live business status.
