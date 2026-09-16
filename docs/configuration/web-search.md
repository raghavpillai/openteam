# Web search

Configure search and page fetching independently of the model provider. A chat-model sign-in does not provide search credentials.

## Set up search

Open **Settings → Server → Web search**, choose a provider, enter its API key, and select **Save web search**.

| Provider | Credential |
| --- | --- |
| Exa | Exa API key |
| Tavily | Tavily API key |
| Brave | Brave Search API subscription token |
| Bing via SerpApi | SerpApi API key |

All bots use the saved configuration. Changes apply to the next search without a restart. If search is unconfigured, the bot receives setup guidance and no search is performed.

## Set up page fetching

Open **Settings → Server → Web fetch**. The default **Built-in HTTP fetch** reads public text and HTML pages without an API key. It does not run page JavaScript or extract binary PDFs.

For supported rendering and document extraction, select **Exa Contents** or **Tavily Extract** and enter a key for that service. Fetch credentials are separate from search credentials, even when you use the same provider.

## Change or remove a key

A blank key field keeps the saved key only when the provider stays the same. Changing providers requires a new key. Use **Remove saved key** to delete one. Choosing built-in fetching clears its previous provider key.

Keys are stored in the server database and are not returned to the settings UI. Protect database backups as credentials.

## Troubleshoot

Ask a bot to perform a small search and check its result. A saved key does not prove that the account has permission or quota. Provider authentication and quota errors are reported without silently switching to another service.
