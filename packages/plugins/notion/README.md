# Notion

Uses Notion's official MCP service and the 14 original workflows from
[Notion's Cursor plugin](https://github.com/makenotion/cursor-notion-plugin/tree/cf1324609edba6d617164f1dec138aeb43f26735).
They cover search, pages, databases, tasks, knowledge capture, meetings, research,
and specification implementation.

The pinned revision declares no redistribution license. `upstream.json` records
its revision and file hashes; install or update fetches the originals directly
from GitHub, verifies them, and saves an immutable installed snapshot under
`upstream/`. Execution and unchanged-source updates reuse that snapshot. No
workflow bodies are rewritten or replaced with OpenTeam-authored versions.

Install it from **Marketplace** and connect an account. Installed plugins and
their connected accounts are available to all bots. Shared runtime code resolves
upstream tool names against discovered schemas and connected accounts. Existing
account credentials survive an update.

See [the plugin guide](../../../docs/usage/plugins.md) for account setup and updates.
