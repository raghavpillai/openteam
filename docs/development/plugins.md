# Build a plugin

Package skills, tools, or both as a plugin to reuse them or share them with others. For instructions only you will use, a [private skill](../usage/skills.md#create-a-skill) is simpler.

## Choose a plugin type

| Type | Contains |
| --- | --- |
| Skills | Instructions and supporting files |
| Remote MCP | A connection to an MCP server over HTTP that your OpenTeam server can reach |
| Packaged MCP | An MCP server that runs on the bots' computer |
| Hybrid | Skills together with one or more tool connections |

A packaged MCP server must include everything it needs to run. OpenTeam doesn't compile code or install dependencies when it installs a plugin.

## Create a plugin

1. Open **Marketplace**, then choose **Manage → Develop plugins**.
2. Choose a template for the plugin type.
3. Give the plugin a unique key, a name, a version, and a description.
4. Edit its files, then choose **Validate and save**.

Saving a draft doesn't change any installed copy of the plugin.

## Test it

1. Choose **Install for testing**.
2. Set up an account if the plugin needs one, and run a small read with **Test a tool** under **Manage → Accounts and settings**.
3. Give a test bot access, and try the real workflow in chat.

Check what happens with missing credentials, service errors, and reconnecting. For tools that change data, test with data you don't mind losing.

Write clear tool descriptions and input schemas, since bots rely on them to pick the right tool. Mark which tools read and which write, so users can set sensible [tool policies](../configuration/approvals.md#control-plugin-access).

## Share it

Export the plugin as a ZIP from the development workspace. Exports never include connected accounts, credentials, or bot access settings, so keep secrets in account setup rather than in plugin files.

To release an update, increase the version number. People who installed your plugin review the changes and choose **Apply reviewed update**.

## Reference

The [plugin authoring reference](../reference/plugin-development.md) covers the directory layout, manifest format, OAuth settings, packaged executables, and how to contribute a plugin to this repository.
