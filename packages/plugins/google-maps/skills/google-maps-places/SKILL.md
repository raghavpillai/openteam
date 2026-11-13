---
name: google-maps-places
description: "When the user asks about real places with Google Maps connected: the best place of a kind, what is near somewhere, ratings, reviews, opening hours, or directions between stops."
---

# Places with Google Maps

The Google Maps tools return real places with Google ratings, review counts, price levels, live opening hours and photos, and real routes. Use them instead of places or directions from memory, and show the results with SendToUser `type: "presentation"`.

- **SearchPlaces** finds a named place, landmark or address, or a described search ("best ramen in Shibuya").
- **SearchNearbyPlaces** finds places of a kind within a radius of a point, by Google relevance (default) or by distance.
- **GetPlaceDetails** reads one place in depth: up to five reviews, Google's review summary and overview, and the week's hours.
- **RoutePlaces** returns a walking, cycling or driving route through stops in visit order. Driving uses live traffic.
- **CheckGoogleMapsKey** reports whether the key works for places and for routes, and what to fix.

## Places near somewhere

1. Get the center. For a named area or landmark, call SearchPlaces and check the address. If the user says "near me" and you don't know where they are, ask for a neighborhood or landmark. Don't guess.
2. Call SearchNearbyPlaces with the center's coordinates and a short query, such as `thai restaurant`. Use `openNow: true` when they want somewhere open now, and `rankBy: "distance"` when they want the closest.
3. If results are few, widen `radiusMeters` or reword the query.

## "Best" places

1. Shortlist with SearchNearbyPlaces or SearchPlaces. Weigh the rating together with the review count: 4.6 from 2,000 reviews is stronger evidence than 5.0 from 8.
2. Call GetPlaceDetails for the top three to five. Read the reviews and the review summary for what people order, praise and complain about, and whether recent reviews disagree with older ones.
3. When the choice is about taste, also check critics or guides with web search. Google ratings measure popularity and consistency, not distinctiveness.
4. Rank with your reasons. Quote or paraphrase reviews with the reviewer's name and Google Maps as the source. Google returns at most five reviews, so treat them as a sample.

## Routes

Pass the chosen places to RoutePlaces in visit order. Pass the route's `id` as the place_map `route`, and state the time and distance it returns. Never draw straight lines and call them directions.

## Showing results

- List places by id: `"places": ["google:ChIJ…", …]`. OpenTeam fills in each one from the tool result: rating, review count, open-now, today's hours, photo and source. To add your own line under a place, use `{"id": "google:ChIJ…", "notes": "Order the duck noodles."}`.
- Keep `photos` on (the default) for every search or detail call whose places you will show. Pass `photos: false` only for a wide shortlist you won't display.
- Put the picks on a `place_map`. Add the place they are near, such as the station or landmark, so the map shows the distance, and add the route when the walk or drive matters.
- For a ranked answer ("top 3"), add a `ranked_media_list` in your order, with `id`, `title`, a one-line `description` and `placeId` for each item; it shows the place's photo. Put the reasoning in Markdown blocks: why each place made the list and what to order.

## When a call fails

Errors name Google's reason and the fix. If the key is missing or invalid, an API isn't enabled, or billing is off, tell the user what to change in the Google Maps plugin's account settings or in Google Cloud, using the error's words. Run CheckGoogleMapsKey when it's unclear which part fails. Never ask for the key in chat.
