---
name: google-maps-places
description: "When the user asks about real places with Google Maps connected: the best place of a kind, what is near somewhere, ratings, reviews, opening hours, or directions between stops."
---

# Places with Google Maps

The Google Maps tools return real places with Google ratings, review counts, price levels, live opening hours and photos. Use them instead of places from memory, and show the results on a map with SendToUser `type: "presentation"`.

- **SearchPlaces** finds a named place, landmark, address or a described search ("best ramen in Shibuya").
- **SearchNearbyPlaces** finds places of a kind within a radius of a point, by Google relevance or by distance.
- **GetPlaceDetails** reads one place in depth: up to five reviews, Google's review summary and overview, and the week's hours.
- **RoutePlaces** returns a real walking, cycling or driving route through stops in visit order; driving uses live traffic.

## Places near somewhere

1. Get the center. For a named area or landmark, call SearchPlaces and check the address. If the user says "near me" and you don't know where they are, ask for a neighborhood or landmark. Don't guess.
2. Call SearchNearbyPlaces with the center's coordinates and a short query such as `thai restaurant`. Use `openNow: true` when the user wants somewhere open now, and `rankBy: "distance"` when closeness matters more than quality.

## "Best" places

1. Shortlist with SearchNearbyPlaces or SearchPlaces. Weigh the rating together with the review count: a 4.6 from 2,000 reviews is stronger evidence than a 5.0 from 8.
2. Call GetPlaceDetails for the top three to five. Read the reviews and Google's review summary for what people order, praise and complain about, and whether recent reviews disagree with older ones.
3. When the choice is about taste, also check critics or guides with web search. Google ratings measure popularity and consistency, not distinctiveness.
4. Rank with your reasons. Quote or paraphrase reviews with the reviewer's name and Google Maps as the source. Google returns at most five reviews, so treat them as a sample.

## Photos

Photos make the map cards and lists. Keep `photos` on (the default) for every search whose places you will show, and for GetPlaceDetails of a pick. Pass `photos: false` only for a wide shortlist you won't display.

## Routes

Pass the chosen places to RoutePlaces in visit order. Put its `route` in the place_map unchanged. Never draw straight lines and call them directions.

## Showing results

Copy each result's `place` object into the presentation's `places` unchanged: it already carries the rating, review count, open-now, today's hours, photo, `provider`, `sourceUrl` and `attribution`. Reference the ids from a `place_map` (`placeIds`) and, for ranked answers, a `ranked_media_list`. Put the reasoning in Markdown blocks, such as why each place made the list and what to order.

## When a call fails

An error names Google's reason. If the key is missing or invalid, or an API isn't enabled, tell the user to fix it in the Google Maps plugin's account settings or the Google Cloud console. Never ask for the key in chat.
