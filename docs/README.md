# OpenTeam documentation

[Back to OpenTeam](../README.md)

Start with [installation](deployment.md) to run a release, or
[development](development.md) to run from source.

## Setup and everyday use

| Guide | What you will find |
| --- | --- |
| [Deployment](deployment.md) | Requirements, installation, remote access, accounts, updates, backups, and troubleshooting |
| [Settings](settings.md) | Models, bot profiles, memory files, routines, app preferences, and environment variables |
| [Plugins and skills](plugins.md) | Install integrations, connect accounts, grant bot access, and develop packages |
| [Model providers](model-providers.md) | Provider discovery, custom endpoints, model selection, and connection failures |
| [Mobile app](../apps/mobile/README.md) | Native builds, server connection, and push notification setup |
| [CLI reference](../apps/cli/README.md) | Server management and provider commands |

## Features and integrations

| Guide | What you will find |
| --- | --- |
| [Web search](web-search.md) | Search providers and web fetch configuration |
| [Voice transcription](transcription.md) | Configure voice notes and a self-hosted transcription service |
| [Event subscriptions](automation-event-subscriptions.md) | Connect external events to routines |
| [Native capabilities](native-capabilities.md) | Host tools, saved logins, browser import, and file transfers |
| [Memory](memory-parity.md) | Memory storage, recall, and compatibility behavior |
| [Compaction](compaction.md) | How long conversations are reduced to fit model context |

## Development and implementation

| Guide | What you will find |
| --- | --- |
| [Development](development.md) | Local setup, repository map, checks, and common commands |
| [Architecture](architecture.md) | Service responsibilities, bot execution, credentials, and persistent data |
| [Platform prompt and tools](platform-system-prompt.md) | Runtime behavior, configuration, and implementation limits |
| [Tool comparison](tool-comparison.md) | Tool coverage against captured reference behavior |
| [Input policy](input-parity.md) | Message and attachment behavior across clients |
| [Health checks](health-checks.md) | Readiness, diagnostics, and fault testing |
| [Performance](../scripts/performance/README.md) | Desktop and mobile performance measurement |
| [Releases](../.github/RELEASING.md) | Versioning, signing, build artifacts, and release verification |

## QA and research

- [Onboarding and login QA](auth-onboarding-qa.md)
- [Input policy QA, September 14, 2026](qa/input-parity-2026-09-14.md)
- [iOS haptics audit](ios-haptics-audit.md)
- [iOS haptic design research](ios-haptic-design-research.md)
