# Web search and fetch configuration

WebSearch supports four providers. Choose one in desktop **Settings → Server → Web search**. Search is independent of the bot's inference provider; a chat-model sign-in is not used as a search credential.

| Configuration value | Service | API key to use |
|---|---|---|
| `exa` | [Exa Search](https://exa.ai/docs/reference/search) | Exa API key |
| `tavily` | [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) | Tavily API key |
| `brave` | [Brave Search](https://api-dashboard.search.brave.com/api-reference/web/search/get) | Brave Search API subscription token |
| `bing-serpapi` | [Bing via SerpApi](https://serpapi.com/bing-search-api) | SerpApi API key |

Microsoft [retired the direct Bing Search APIs on August 11, 2025](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement). `bing-serpapi` uses SerpApi's supported Bing results endpoint and requires a SerpApi account. Old Azure/Bing Search API keys do not work with this option.

Select a provider, enter its API key privately in the password field, and click **Save web search**. The provider and API key are stored in PostgreSQL's `WebSearchSettings` singleton row. All bots share this configuration. The next search reads the current saved settings, without a worker or server restart.

The key is stored as plain text in the database's `apiKey` column, with no encryption or dependency on the server authentication secret. The settings UI only receives `hasApiKey` and configuration status. Search credentials never enter bot files, prompts, tool arguments/results, or agent subprocess environments.

Leaving the key field blank retains the saved key only for the same provider. Switching providers clears the old key unless a new key is supplied. **Remove saved key** deletes the credential; choosing **Not configured** clears both fields.

Authenticated clients can also use `GET` and `PATCH /api/v0/server-settings/web-search`. The update body is `{ "provider": "exa", "apiKey": "..." }`; omit `apiKey` to retain it for the same provider, or use `null` to remove it. Responses contain only `{ provider, hasApiKey, configured }`. `configured` means a readable key is saved; provider entitlement and quota are checked during an actual search. A control-token-protected internal endpoint supplies credentials directly to the computer runtime. Environment-based search configuration is no longer read or forwarded by Compose.

Both settings default to empty in a fresh database. **WebSearch remains visible when unconfigured** and returns setup guidance, `configured: false`, and an explicit statement that no search was performed. Selecting a provider without its key produces a missing-key explanation. Invalid provider names are rejected. There is no automatic switch to another provider, no implicit xAI credential use, and no scraped-search fallback. WebFetch has its own provider configuration, described below.

Configured searches return up to ten unique HTTP(S) source links with titles and short extracts. Exa uses automatic search plus highlights; Tavily uses basic search; Brave and Bing return organic web snippets. Brave queries are limited to its documented 600 characters and 75 words. Requests time out after 30 seconds, reject redirects, cap responses at 5 MiB, and honor cancellation. Authentication/quota errors identify the provider and HTTP status without revealing credentials or private request URLs.

The endpoint, authentication, request and response contracts were checked against the linked official documentation. Automated tests cover all four adapters, database persistence, direct key storage, provider changes, key removal, missing/invalid configuration, empty results, malformed responses, bounds, credential redaction and cancellation. Successful searches with a real account still require that provider's valid key and quota; the test fixtures do not establish an account entitlement.

## WebFetch providers

Configure **Settings → Server → Web fetch** independently of search. The default is **Built-in HTTP fetch**, which reads public pages directly and needs no key. Optional providers:

| Provider | API | Credential |
|---|---|---|
| `builtin` | Direct public HTTP(S), with HTML-to-Markdown extraction | None |
| `exa` | [Exa Contents](https://exa.ai/docs/reference/get-contents) | Exa API key |
| `tavily` | [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) | Tavily API key |

Exa requests full page text with `maxAgeHours: 0` and a 15-second live-crawl timeout. Tavily uses advanced extraction and Markdown output with a 20-second provider timeout. Remote extraction uses the provider's rendering and document support; the built-in fetcher reads returned text/HTML and does not run JavaScript or extract binary PDFs. Brave and Bing via SerpApi are search options only.

The fetch provider and key live in PostgreSQL's `WebFetchSettings` row, with the key stored directly as requested. A fetch key is separate from the search key even when both use the same service. Empty key input retains the existing key only for the same provider. Switching to built-in clears the key. Changes apply to the next fetch without a restart. Authenticated clients can use `GET`/`PATCH /api/v0/server-settings/web-fetch` with `{ "provider": "builtin" | "exa" | "tavily", "apiKey"?: string | null }`; public responses contain provider, hasApiKey and configured only.

Both extraction providers validate public URL destinations, reject redirects of the provider API itself, cap responses at 5 MiB, honor cancellation, redact credentials, and check per-URL failures even when HTTP status is 200. Built-in fetching pins each destination and redirect to a validated public IP; provider-side crawling and redirects run on the selected provider's infrastructure. All modes return a source URL and Markdown/text; content over 100,000 characters is written to a file and linked from the truncated inline result. Missing extraction keys return setup guidance and perform no provider request. There is no silent provider fallback.

Built-in fetching was verified live on September 13, 2026 against example.com, Exa documentation, and Tavily documentation. Search and extraction adapters have protocol tests, and both settings flows were exercised through a real server, PostgreSQL, and Chromium UI. No usable provider keys were found in the inherited environment or the exact provider-named 1Password items checked; successful authenticated paid-provider searches/extractions remain unverified. See the gitignored `findings/web-providers-2026-09-13/` for current evidence.

GenerateImage has been removed from the tool catalog and runtime. Existing image attachments, screenshots and image viewing remain supported.
