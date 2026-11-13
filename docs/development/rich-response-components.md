# Maps and ranked media responses

The agent sends data through `SendToUser`, and each client owns the layout. Maps and ranked media render inside the app's normal assistant chat bubble, with the real message spacing, actions and composer around them. The agent can interleave Markdown with the native components; it never has to generate HTML or CSS.

The component contract belongs in the tool schema, with short selection guidance in the tool description. A skill can teach a travel or research workflow, but is not required to render a map or list. No extra UI agent is required.

## Agent flow

1. Get real places from a place tool or verified research. The bundled [OpenStreetMap plugin](../../packages/plugins/openstreetmap/README.md) provides `SearchPlaces`, `SearchNearbyPlaces` and `RoutePlaces`, and its `openstreetmap-places` skill teaches the flow: geocode an area, find places of a kind near it with hours and open-now, check reviews with web search for "best", and route between stops. The core never names these tools; any plugin that returns places in this shape works.
2. Check the city and branch of each place, even with a single result.
3. For directions, pass the `id` of the route a routing tool returned as the map's `route`. Never draw straight lines as directions. For pins alone, omit the route.
4. Call `SendToUser` with `type: "presentation"`, a versioned payload, and the usual `end_turn`. Name places by the ids tools returned; narrative goes in Markdown blocks in the desired order.

```json
{
  "type": "presentation",
  "presentation": {
    "version": 1,
    "places": [
      "osm:way:34633854",
      { "id": "osm:node:5158209121", "notes": "Lunch only; queues by noon." }
    ],
    "blocks": [
      { "type": "markdown", "text": "Start with this landmark, then lunch." },
      {
        "type": "place_map",
        "title": "Midtown Manhattan",
        "placeIds": ["osm:way:34633854", "osm:node:5158209121"],
        "route": "route:3f1c9a2b-7d4e"
      },
      {
        "type": "ranked_media_list",
        "items": [
          { "id": "first", "title": "Empire State Building", "description": "An Art Deco landmark with observation decks.", "placeId": "osm:way:34633854" }
        ]
      }
    ]
  },
  "end_turn": true
}
```

### References

`places` entries and a map's `route` can be ids instead of objects. When a plugin tool returns, the Bot computer indexes the places and routes in its JSON result (before a large result is moved to a file) and stores that index with the run item; the model never sees it. Before a presentation is checked and delivered, the server fills each reference from those indexes, for the sending bot and its subagents, from the last day. Only a plugin's own JSON structure is indexed, never arguments the agent wrote or text a tool relays (a page, an email), so a referenced place is always what a places tool returned. `{ "id": …, "notes": … }` (or `description`, `icon`) adds the agent's own words on top. Results reach the database a moment after a tool returns, so an id that isn't stored yet is retried for about three seconds; an unknown id is refused with a message telling the agent to use the tool's exact ids, call the tool again, or send the full object. Places verified another way, for example from a web page, are still sent as full objects. This keeps map replies short: the agent doesn't re-type coordinates, photo links or route geometry. Routing tools return an `id` on each route for this. The resolver is `apps/server/src/services/place-references.ts`.

The schema and JSON-schema tool definition live in `packages/contracts/src/presentation.ts`. Limits: 50 places, 20 ordered blocks, 50 media items per list, 20,000 route vertices. Routing requests accept 2–10 stops. IDs must resolve; route legs must connect the map's stops in order. Links and image URLs use HTTPS without embedded credentials.

Place coordinates are named **latitude / longitude**. Route vertices are GeoJSON **[longitude, latitude]** pairs. The server validates both before persisting a message. `normalizePlace` also accepts the observed ChatGPT point/entity POI envelope, preserving coordinates, provider IDs, imagery, ratings and source URLs when present. It does not turn an unresolved name into coordinates.

Optional place fields include `imageUrl`, `rating` (0–5), `reviewCount`, `isOpen`, `hours`, `category`, `icon`, `notes`, `description`, `websiteUrl`, `provider`, `sourceUrl`, and `attribution`. Include business metadata only when supplied by a verified source. Missing images get a neutral placeholder; missing ratings and opening status are omitted. A ranked item can use its own image or inherit its referenced place's image.

A `place_map` may carry a measured `route` object, such as the one the OpenStreetMap plugin's `RoutePlaces` returns: mode, LineString geometry, distance in meters, duration in seconds, and ordered legs. `carousel: "hidden"` gives a clean route-only map. Fullscreen remains available in either mode. No composer or Ask button is included.

## Providers and configuration

Place data comes from plugins. The OpenStreetMap plugin needs no account or key; its README covers the services it calls, what the data includes and its privacy notes. The renderers need no tokens either:

| Purpose | Default | Configuration |
| --- | --- | --- |
| Place search, nearby places, routes | OpenStreetMap plugin (Photon, Nominatim, Valhalla) | Install from the marketplace |
| Ratings, reviews, photos, live hours, routes | Google Maps plugin (Places API (New), Routes API) | Install from the marketplace with a Google Maps Platform API key |
| Desktop map rendering | MapLibre GL with OpenFreeMap tiles | Client style in `presentation/map-style.ts` |
| iOS map rendering | Native Apple MapKit | Automatic light/dark appearance |

Desktop keeps MapLibre/OpenStreetMap with a palette sampled from Apple Maps (land, city blocks, roads, parks and water in both themes, with spaced-capital neighborhood labels), blue route accents, and glass cards, pins and controls (a translucent blurred fill with a specular rim). It requires no Apple Maps token. Street geometry, labels and POI artwork come from the selected map source, so they are not identical to Apple's basemap. The native iOS view uses Apple's built-in MapKit SDK, which also needs no MapKit JS browser token. A browser token is relevant only to an app that chooses Apple's web renderer; it is managed by the app operator, not by every end user.

OpenStreetMap has no business photos, star ratings or reviews. The Google Maps plugin returns them on each place (rating, review count, photo, open-now, today's hours), with up to five reviews from `GetPlaceDetails`. Otherwise the contract can carry them from a source the bot verifies, such as reviews it found with web search. Only include what a source actually gives, and keep that source as the place's provider. The map renderer separately requests tiles and fonts.

References: [Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md), [Valhalla routing API](https://valhalla.github.io/valhalla/api/route/api-reference/), [OpenFreeMap](https://openfreemap.org/quick_start/), [MapKit for SwiftUI](https://developer.apple.com/documentation/mapkit/mapkit-for-swiftui).

## Client behavior and transport

- Desktop: lazy MapLibre renderer, day/night vector styles, Apple-style photo pins (the place photo in a white ring, a route-number badge, and a jelly landing when selected), dotted measured geometry, selected-card/pin synchronization, keyboard dismissal and focus restoration. The card lane has weight: mouse drags and flicks carry momentum into a spring snap onto the nearest card, the lane rubber-bands past its ends, cards lean with velocity and recede near the edges, and trackpad scrolling springs onto a card when it settles. Fullscreen reuses the same map canvas, grows out of the inline map's frame, and follows Apple Maps' arrangement: a floating glass list on the left (a bottom sheet on narrow windows) and controls on the right. Motion uses damped-spring curves (`motion.ts`, mirrored as CSS variables in `presentation.css`), and every animation is disabled under reduced motion.
- iOS: native MapKit annotations and route overlay, Apple-style photo pins with a keyframed jelly when selected, automatic selection scrolling, and a fullscreen map that zooms out of the inline map with a floating glass itinerary (bottom sheet on iPhone, side panel on iPad). Every Apple-styled surface (cards, preview, tiles, sections, pins, chips, controls and rank badges) is Liquid Glass on iOS 26 and later, interactive where tappable, with a matching material before iOS 26. Haptics give the controls weight: a soft tap on touch-down, a tick as each card snaps into place or a place changes, a soft thud when a card opens, a light tap on close, and a medium tap for fullscreen. Theme colors follow the app. Source links open with native link handling.
- Selecting a card or pin opens a glass place preview inside the map component on both platforms, laid out like Apple Maps' place card: title and "stop · category" subtitle, Directions (opens Apple Maps directions in the route's walking, driving or cycling mode), Website and Map tiles, a stats row (hours, rating with its review count, source), a large photo when one is supplied, then About, Details, the source link and the place's data attribution. Both clients format ratings, review counts, durations ("1 hr 30 min") and road distances (in the region's units) the same way. The tapped card grows into the preview: the container morphs from the card's frame, or out of the pin, while the photo and title move to their new positions on a slightly softer spring, and the other cards sink away and bounce back on close. Desktop cards have a fixed 120px height and 16px internal padding in both themes. The preview scrolls independently, and Map returns to the carousel; only the explicit expand control opens fullscreen. There, a place opened from the list or a pin takes the list's place on both platforms; on desktop it grows out of its list row. Details show only supplied metadata. Closing restores focus on desktop. No Ask composer appears in map previews.
- Ranked lists use ordered titles, rounded thumbnails with a glass rank badge, descriptions and optional source pills, with the app's existing typography. When an item has a link, the whole row opens it, with hover and press feedback.
- Messages retain a readable text fallback for notifications, history, older clients and invalid payloads. `presentation` uses the existing durable message metadata path; it is not a pending approval or question card. Like the other rich cards, delivery is currently supported in the Bot's private chat, not group-room or external connector posts.

The ChatGPT reference inspected in the supplied thread used a web Mapbox GL renderer, a resolved map/POI payload, and inline component markup for media lists. That observation is not a published stable API or evidence of a separate map agent. OpenTeam uses its own versioned contract and licensed/public map sources; no ChatGPT private tokens, styles or backend endpoints are required.

## Verification

`packages/contracts/test/presentation.test.ts` and `apps/ios/Tests/CoreTests/PresentationTests.swift` consume the same fixture at `apps/ios/Tests/CoreTests/Fixtures/presentation.json`. They check coordinate order, reference validation and native block decoding. Server provider tests cover coordinate conversion, routing format, provenance, missing metadata and provider errors. Messaging tests check the delivery branch.

The desktop browser fixture is `apps/desktop/test/browser/presentation.html`. The native `PresentationUITests` uses the loopback parity server on port 20180 (`SWIFT_PARITY_PORT=20180 bun apps/ios/scripts/parity-server.ts`) and covers carousel scrolling, fullscreen opening/closing, and ranked media in both appearances. Fixture POIs and route geometry are examples, not live business status.
