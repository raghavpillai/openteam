# OpenTeam documentation

[Read the docs](https://openteam.so/docs) · [Back to the repository](../README.md)

New to OpenTeam? Start with the [introduction](overview/introduction.md), follow the [quickstart](getting-started/quickstart.md), then [create a bot](getting-started/first-bot.md).

## Getting started

- [Introduction](overview/introduction.md)
- [Use cases](overview/use-cases.md)
- [Quickstart](getting-started/quickstart.md)
- [Installation](getting-started/installation.md)
- [Desktop and mobile](getting-started/apps.md)

## Working with bots

- [Create and manage bots](getting-started/first-bot.md)
- [Chat and teamwork](usage/conversations.md)
- [Files and results](usage/files.md)
- [Computer and browser](usage/computer.md)
- [Memory](usage/memory.md)
- [Skills](usage/skills.md)
- [Routines](usage/routines.md)

## Connect your tools

- [Plugins](usage/plugins.md)
- [Connecting accounts](integrations/accounts.md)
- [Google](integrations/google.md)
- [Slack](integrations/slack.md)

## Configuration

- [Model providers](configuration/models.md)
- [Web search](configuration/web-search.md)
- [Voice notes](configuration/transcription.md)
- [Settings and notifications](configuration/apps.md)
- [Approvals and privacy](configuration/approvals.md)

## Self-hosting

- [How hosting works](overview/architecture.md)
- [Server settings](configuration/server.md)
- [Remote access](configuration/remote-access.md)
- [Server commands](manage/server.md)
- [Updates](manage/updates.md)
- [Backups and restore](manage/backups.md)

## Help

- [Troubleshooting](manage/troubleshooting.md)
- [FAQ](manage/faq.md)

## Advanced setup

- [Development from source](development/from-source.md)
- [Build a plugin](development/plugins.md)

## Operator and contributor references

[Reference notes](reference/README.md) contain the detailed backup commands, environment options, plugin schemas, and runtime implementation notes. They are not included in the website navigation.

## Maintain the docs

The Markdown in this directory is the source for GitHub and the website. `config.json` controls the landing page, navigation groups, titles, file references, and order. Routes use `/docs/` plus the file path without `.md`; the configured home is `/docs`.

To add a guide, create its Markdown file, give it one H1 matching the configured title, and add its file to a navigation group. Use relative Markdown links so it works on GitHub too.

Run `bun --filter @openteam/landing docs:generate` to validate content, or `bun --filter @openteam/landing build` to build the website. Missing files, duplicate entries, and broken links between published guides fail the build. Vite development rebuilds when the docs change. Copy page uses the original Markdown.

### Markdown and AI access

Every published guide is available as Markdown by adding `.md` to its website URL, for example `/docs/integrations/google.md`. The introduction is also available at `/docs.md`. Alternatively, request the normal page URL with `Accept: text/markdown` or `Accept: text/plain`:

```sh
curl -L -H 'Accept: text/markdown' https://openteam.so/docs/integrations/google
```

`/llms.txt` lists the published guides by their configured groups, with descriptions and direct Markdown links. `/llms-full.txt` contains all published guides. Both files also work under `/docs/` and `/.well-known/`. Documentation responses advertise these indexes through `Link` and `X-Llms-Txt` headers.

HTML, Markdown exports, and both indexes are compiled from this directory during the build; serving them never fetches GitHub. Exported links point to Markdown guides or repository references as appropriate. Absolute links use the current request origin so local previews work too. Content negotiation varies responses by `Accept` and preserves the app router's page-prefetch requests.

Write for the person doing the task: explain what a feature does, show how to use it, give an example where useful, and name the next step if it fails. Keep implementation details in the reference notes unless they affect setup or a user decision.
