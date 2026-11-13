# Maps and places

Add **OpenStreetMap** or **Google Maps** from **Marketplace** to let bots find real places and plan routes. On iPhone and iPad, open **Settings → Plugins**. Both plugins provide read-only tools; they do not make bookings or change listings. Bots can present the results as [maps and ranked places](../usage/conversations.md#maps-and-ranked-places) in a private bot chat.

## OpenStreetMap

Choose **Add**, then **Connect**. No account or API key is needed. Bots can search for an address or landmark, find nearby places, and request walking, cycling, or driving routes through 2–10 stops.

Search uses Photon and Nominatim; routes use Valhalla. OpenStreetMap can supply hours, websites, and phone numbers, but has no ratings, reviews, or business photos. Calculated open-now status uses posted hours and the time zone supplied by the bot; it does not account for public holidays, and is omitted for missing or unsupported hours.

These community services have no uptime guarantee. The plugin caches results for ten minutes and spaces Nominatim requests at least 1.1 seconds apart. Busy services can return an error; ask the bot to retry later rather than treating an empty result as proof that no place exists. See the [OpenStreetMap plugin guide](../../packages/plugins/openstreetmap/README.md).

## Google Maps

1. Choose a Google Cloud project with billing enabled.
2. Enable **Places API (New)** and **Routes API**.
3. Create an API key restricted to those APIs.
4. Add **Google Maps** in Marketplace, paste the key into its account settings, and choose **Connect**.

Bots can search for places, get nearby results, read place details, check the key, and request walking, cycling, or driving routes through 2–25 stops. Results can include Google ratings and review counts, a photo, price level, and current opening status. Place details can include up to five reviews selected by Google.

Google bills requests against your project after any applicable allowance. Photos require separate requests, and richer place fields can use higher billing tiers. Check the project's quotas and billing controls before use; consult the [Google Maps plugin guide](../../packages/plugins/google-maps/README.md#cost) for the API fields and pricing link. Identical requests are reused for five minutes. Photo links can expire, so an older card may show a placeholder.

## Privacy and map display

OpenStreetMap search sends place names and queries to Photon and Nominatim; routes send stop coordinates to Valhalla. Google Maps sends queries, search areas, and route stops to Google with your API key. The key stays on your server and is not shown to bots.

Displaying a map makes additional requests from the client: desktop uses OpenFreeMap tiles and fonts, while iPhone and iPad use Apple's MapKit. Google place photos load from Google's image links. These display services are separate from the plugin that found the place. As with other tool results, place information used in a task can also reach your model provider. See [privacy and connected services](../configuration/privacy.md).
