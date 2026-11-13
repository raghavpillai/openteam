# OpenStreetMap

Bots look up real places and routes from OpenStreetMap's free public services, then show them on maps in chat. No account or API key is needed.

## Connect

1. Install **OpenStreetMap** from the marketplace.
2. Choose **Connect**. There is nothing to sign in to. Every Bot can then use the tools.

## Tools

| Tool | Service | What it returns |
| --- | --- | --- |
| `SearchPlaces` | [Photon](https://photon.komoot.io) | Places that match a name, landmark or address, with coordinates and addresses |
| `SearchNearbyPlaces` | [Nominatim](https://nominatim.org) | Places of a kind near a point, nearest first, with distance, cuisine, website, phone, opening hours and open-now |
| `RoutePlaces` | [Valhalla](https://valhalla1.openstreetmap.de) | A walking, cycling or driving route through 2–10 stops, with per-leg distance, duration and turn instructions |

All three are read-only. The `openstreetmap-places` skill shows Bots how to combine them with web search and SendToUser map presentations.

## What the data covers

- OpenStreetMap has hours, websites and phone numbers for many places. It has no ratings, reviews or photos, so for "best" questions Bots check reviews with web search and cite them.
- Open-now is worked out from the place's posted hours in the time zone the Bot passes. It is left out when hours are missing or use an unusual form, such as seasonal hours. Public holidays aren't considered.
- Nearby search matches names and place types. A place whose name and tags don't match the query can be missed, so Bots retry with other wording or a wider radius.

## Privacy

Place names and search queries go to Photon and Nominatim, and route stop coordinates go to Valhalla. The plugin sends no user names or messages. Results are cached on the Bot computer for ten minutes, and Nominatim requests are spaced at least 1.1 seconds apart, following its [usage policy](https://operations.osmfoundation.org/policies/nominatim/).

The public services are community-run and have no uptime guarantee. When one is busy, the tool says so and the Bot can retry.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the ODbL.
