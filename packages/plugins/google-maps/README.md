# Google Maps

Bots look up places on Google Maps, with ratings, reviews, photos, price levels and live opening hours, and plan routes. Answers appear as maps and ranked lists in chat. The plugin uses your own Google Maps Platform API key.

## Connect

1. In the [Google Cloud console](https://console.cloud.google.com/), pick a project with a billing account.
2. Enable **Places API (New)** and **Routes API**.
3. Create an API key under **APIs & Services → Credentials**. Restricting it to those two APIs is safest.
4. Install **Google Maps** from the marketplace, paste the key in its account settings, and choose **Connect**.

## Tools

| Tool | Google API | What it returns |
| --- | --- | --- |
| `SearchPlaces` | Places Text Search | Places matching a name, address or description, optionally near a point |
| `SearchNearbyPlaces` | Places Text Search, limited to a radius | Places of a kind near a point, by relevance or distance, with distance |
| `GetPlaceDetails` | Place Details | Up to five reviews (Google picks the most relevant), Google's review summary and overview, and the week's hours |
| `CheckGoogleMapsKey` | Places API (New) and Routes API | Whether the key works for each API, and what to fix in Google Cloud if not |
| `RoutePlaces` | Routes API | A walking, cycling or driving route through 2–25 stops, with per-leg distance, duration and turn instructions |

Search results include the Google rating and review count, price level, today's hours, open-now, website, phone and one photo. All tools are read-only. The `google-maps-places` skill shows Bots how to combine them for "best nearby" answers and maps.

## Cost

Google bills per request after a monthly free allowance for each request type. Ratings, hours and phone numbers are in its Enterprise tier, and reviews and summaries in Enterprise + Atmosphere, so most calls here use those tiers. Each photo is a separate Place Photos request. See Google's [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) for current prices.

## Privacy

Queries, search areas and route stops are sent to Google with your key. The key stays on your server and is never shown to Bots. Photos are returned as Google image links, which don't contain the key. Google can expire these links, so photos in older conversations may stop loading; the card then shows its placeholder. Identical requests are reused for five minutes.
