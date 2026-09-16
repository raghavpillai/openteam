# Maintaining the docs

The Markdown in `docs/` supplies both GitHub and the website. [`config.json`](../config.json) sets the home page, navigation groups, titles, and order. Routes use `/docs/` plus the file path without `.md`; the configured home is `/docs`.

## Add or edit a guide

1. Create its Markdown file with one H1 matching the configured title.
2. Add it to a navigation group in `config.json`.
3. Use relative Markdown links, including heading anchors, so links work on GitHub too.
4. Run `bun --filter @openteam/landing docs:generate` to validate, or `bun --filter @openteam/landing build` to build the website.

Missing files, duplicate entries, and broken links between published guides fail the build. Vite rebuilds when the docs change. Copy page copies the original Markdown.

Give each page one job. Keep quickstarts complete enough to finish a first task; keep requirements and recovery steps in their dedicated guides. Link to an existing procedure instead of maintaining another copy. Put schemas, implementation details, and test procedures in `reference/`. Label dated investigation results as history rather than current deployment status.

## Markdown and AI access

Add `.md` to any published guide URL, such as `/docs/integrations/google.md`. The introduction also works at `/docs.md`. Alternatively, request the normal page with `Accept: text/markdown` or `Accept: text/plain`:

```sh
curl -L -H 'Accept: text/markdown' https://openteam.so/docs/integrations/google
```

`/llms.txt` lists guides by their configured groups, with descriptions and direct Markdown links. `/llms-full.txt` contains every published guide. Both indexes also work under `/docs/` and `/.well-known/`. Documentation responses advertise them through `Link` and `X-Llms-Txt` headers.

HTML, Markdown exports, and both indexes are compiled during the build; requests never fetch GitHub. Exported links point to Markdown guides or repository references. Absolute links use the request origin for preview compatibility. Content negotiation varies by `Accept` and preserves app-router prefetch requests.
