# Web search and page fetching

Bots use two web tools. **Search** finds information online. **Fetch** reads a web page without opening the bot's browser. You configure them separately in **Settings → Providers**, on desktop or iPhone. Each tool has its own page, its own list of providers and its own keys.

Out of the box, search is **off** and fetch uses OpenTeam's **built-in** reader. Every other provider needs an API key from that provider. Both defaults show a warning: with search off, bots can't search the web, and the built-in reader only handles basic pages. Nothing is sent to a third-party service until you choose one.

## Choose a provider

1. Open **Settings → Providers**. It shows the provider each tool is using, or **Off**.
2. Choose **Search** or **Fetch**.
3. Choose a provider and enter its API key. **Get a key** opens the provider's page for creating one.
4. Choose **Check**. OpenTeam runs a real test search, or reads example.com, with the saved key. A check mark shows when it works. The result is saved, so you'll still see it next time you open Settings. Changing the key clears the check.
5. Select the provider to use it.

If you use Exa or another provider for both tools, enter its key on each page.

## Search providers

| Provider | Notes |
| --- | --- |
| Exa | AI search with page highlights |
| Brave Search | Brave's independent index |
| Parallel | Search built for AI agents |
| Firecrawl | Web search with page summaries |
| Bing | Bing results, using a [SerpApi](https://serpapi.com) key |
| Perplexity | Perplexity's search index |

Search queries are sent to the provider you choose. Until you choose one, bots can't search. If a bot tries, it's told search isn't set up and should tell you, rather than pretend it searched.

## Fetch providers

The **built-in** reader fetches public pages directly from your server, with no account. It handles:

- web pages, converted to text with their tables kept
- plain text, JSON, and RSS and Atom feeds
- PDFs up to 20 MiB
- any text encoding

It refuses private and local network addresses.

It can't run JavaScript, so apps such as flight or map search come back nearly empty, and some sites block automated reading. In both cases, the bot is told to open the page in its browser.

For those sites, choose **Exa**, **Parallel** or **Firecrawl** and enter its API key. Firecrawl renders JavaScript. Parallel returns full page content, including PDFs. The addresses of the pages bots read are sent to the service you choose.

To stop bots fetching pages, choose **Off**. Bots can still use their browser.

## Change or remove a key

To replace a key, open the provider, enter the new key and save. To delete a key, choose **Remove**. You can't remove the key of the provider a tool is using, so choose another provider first.

Saved keys are stored on your server and never shown again in the app. For this reason, treat your server backups as sensitive.
