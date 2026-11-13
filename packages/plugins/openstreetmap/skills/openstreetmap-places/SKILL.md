---
name: openstreetmap-places
description: "When the user asks about real places: what is near somewhere, the best place of a kind, opening hours, or directions and routes between stops."
---

# Places with OpenStreetMap

The OpenStreetMap tools return real places and routes. Use them instead of coordinates from memory, and show the results on a map with SendToUser `type: "presentation"`.

- **SearchPlaces** finds a named place, landmark or address and returns its coordinates. Check the city and address of the result, even when only one comes back.
- **SearchNearbyPlaces** finds places of a kind around a point, nearest first, with distance, cuisine, website, phone and opening hours.
- **RoutePlaces** returns a real walking, cycling or driving route through stops in visit order.

## Places near somewhere

1. Get the center. For a named area or landmark, call SearchPlaces. If the user says "near me" and you don't know where they are, ask for a neighborhood or landmark. Don't guess.
2. Call SearchNearbyPlaces with the center's coordinates and a short query such as `thai restaurant`, `coffee` or `pharmacy`. Pass the area's IANA `timeZone` so results include `openNow`. Use `openNow: true` when the user wants somewhere open now.
3. If there are few results, try other wording (`thai`, `noodles`) or a wider `radiusMeters`.

## "Best" places

OpenStreetMap has no ratings, reviews or photos. For "best", shortlist candidates with SearchNearbyPlaces, then check reviews for the top few with web search. Rank them using the reviews you found and cite them. Only include a rating, review count or photo that a source you read actually gives, and keep that source's name as the place's `provider` or in the text.

## Routes

Pass the chosen places to RoutePlaces in visit order. Put its `route` in the place_map unchanged. Never draw straight lines and call them directions.

## Showing results

Copy each result's `place` object into the presentation's `places`, and reference the ids from a `place_map` (`placeIds`) and, for ranked answers, a `ranked_media_list`. Keep each place's `provider`, `sourceUrl` and `attribution`. Put the reasoning in Markdown blocks, for example why each place made the list.
