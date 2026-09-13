# Notion

Uses Notion’s official MCP service and browser OAuth, with independently authored OpenTeam skills for 14 workflows: search, find, page creation, database queries and rows, task creation/setup/planning/building, diff documentation, knowledge capture, meeting preparation, research, and spec-to-implementation planning.

The workflow inventory was compared with [Notion’s Cursor plugin](https://github.com/makenotion/cursor-notion-plugin) at revision `cf1324609edba6d617164f1dec138aeb43f26735` on September 12, 2026. That repository did not contain a redistribution license at the inspected revision. These skill bodies are original OpenTeam implementations; no upstream skill text or assets are bundled. The package is maintained by OpenTeam, and Notion operates the connector.

Install or update in Plugins, connect an account, enable the package for a Bot, and grant the intended account. Skills are independent of OAuth, but executing their Notion operations requires an authorized account. Each skill uses discovered tool schemas, validates destinations and database properties, preserves unrelated content, and verifies writes. Provider tools and workspace permissions determine which operations are available.

See [the plugin guide](../../../docs/plugins.md) for UI setup, multiple accounts, permissions, updates and contribution requirements.
