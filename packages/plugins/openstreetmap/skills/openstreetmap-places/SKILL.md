---
name: openstreetmap-places
description: "When the user asks about real places: what is near somewhere, the best place of a kind, opening hours, or directions and routes between stops."
---

# Places with OpenStreetMap

The OpenStreetMap tools return real places and routes. Use them instead of coordinates from memory, and show the results on a map with SendToUser `type: "presentation"`.

- **SearchPlaces** finds a named place, landmark or address and returns its coordinates. Check the city and address of the result, even when only one comes back.
- **SearchNearbyPlaces** finds places of a kind around a point, nearest first, with distance, cuisine, website, phone and opening hours.
- **RoutePlaces** returns a real walking, cycling or driving route through stops in visit order.

OpenStreetMap has no ratings, reviews or photos. If Google Maps tools are also available, use them when ratings, reviews or photos matter.

## Places near somewhere

1. Get the center. For a named area or landmark, call SearchPlaces. If the user says "near me" and you don't know where they are, ask for a neighborhood or landmark. Don't guess.
2. Call SearchNearbyPlaces with the center's coordinates and a short query such as `thai restaurant`, `coffee` or `pharmacy`. Pass the area's IANA `timeZone` so results include `openNow`. Use `openNow: true` when the user wants somewhere open now.
3. If there are few results, try other wording (`thai`, `noodles`) or a wider `radiusMeters`.

## "Best" places

OpenStreetMap has no ratings, reviews or photos. For "best", shortlist candidates with SearchNearbyPlaces, then check reviews for the top few with web search. Rank them using the reviews you found and cite them. Only include a rating, review count or photo that a source you read actually gives, and keep that source's name as the place's `provider` or in the text.

## Routes

Pass the chosen places to RoutePlaces in visit order. Pass the route's `id` as the place_map `route`. Never draw straight lines and call them directions.

## Showing results

- List places by id: `"places": ["osm:node:123", …]`. OpenTeam fills in each one from the tool result, including its source and today's hours (the result's `openingHours` has the whole week). To add your own line under a place, use `{"id": "osm:node:123", "notes": "…"}`.
- Put the picks on a `place_map`. Add the place they are near, such as the station or landmark, so the map shows the distance, and add the route when the walk or drive matters.
- For a ranked answer ("top 3"), add a `ranked_media_list` in your order, with `id`, `title`, a one-line `description` and `placeId` for each item. Put the reasoning in Markdown blocks: why each place made the list.
