# Web search

Web search lets bots find current information online. Page fetching lets them read a page quickly without opening it in their browser. Both are off until you set them up, and they use their own API keys, separate from your model provider.

## Set up search

1. Open **Settings → Server → Web search**.
2. Choose a provider and enter its API key.
3. Choose **Save web search**.

| Provider | What you need |
| --- | --- |
| Exa | An Exa API key |
| Tavily | A Tavily API key |
| Brave Search | A Brave Search API key |
| Bing via SerpApi | A SerpApi API key |

All bots use the same search settings. Changes take effect on the next search.

## Set up page fetching

1. Open **Settings → Server → Web fetch**.
2. Choose a provider:
   - **Built-in HTTP fetch (no key)** reads ordinary web pages. It doesn't run JavaScript or read PDFs.
   - **Exa Contents** or **Tavily Extract** send the page's address to that service, which fetches and reads many pages the built-in fetch can't. Enter the service's API key here too, even if you already saved it for search.
3. Choose **Save web fetch**.

Without page fetching, bots can still open pages in their browser, but it's slower.

## Change or remove a key

To switch providers, choose the new one and enter its key. To delete a saved key, select **Remove saved key** and save. To turn search or fetching off, choose **Not configured** and save.

Saved keys are stored on your server and never shown again in the app. Treat your server backups as sensitive for this reason.

## Check that it works

Ask a bot to search for something and look at the result. If it fails, the bot gets an error with a hint, such as checking the API key or quota.
