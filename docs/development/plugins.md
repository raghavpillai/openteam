# Build a plugin

Create a package when you want to share a skill, connect a custom service, or combine reusable instructions with tools.

## Start in the UI

Open **Plugins → Manage → Develop**. Choose a skills, remote MCP, packaged MCP, or hybrid template.

Give the package a stable key, name, version, and description. Edit its definition and files, then choose **Validate and save**. Saving a draft does not replace an installed package.

For a personal instruction set that does not need distribution, [create a private skill](../usage/skills.md#create-a-private-skill) instead.

## Choose how tools connect

| Package | Use it for |
| --- | --- |
| Skills | Instructions and supporting files |
| Remote MCP | An HTTP MCP service the OpenTeam server can reach |
| Packaged MCP | A runnable connector on the bot computer |
| Hybrid | Skills alongside one or more tool connections |

A packaged connector must include a runnable entry point and required assets. Installing it does not automatically compile source code or install dependencies.

## Test the package

Choose **Install for testing**, configure an account, and run a small read under **Test a tool**. Grant it to a test bot and verify the actual workflow in chat.

Check missing credentials, provider errors, and reconnect behavior. For tools that change data, use disposable data and review the requested approval.

Declare tool descriptions and input schemas clearly. Set read and write permissions deliberately; a tool being discovered does not prove the connected account is allowed to run it.

## Share or update

Export a ZIP from the development workspace. Keep secrets in account configuration, not package files. Exports do not include connected-account credentials or bot grants.

Increment the package version when distributing an update. Users review and apply it to their installed package; draft edits do not silently replace it.

## Implementation details

The [plugin authoring reference](../reference/plugin-development.md) covers directory layout, manifest examples, OAuth fields, packaged executables, and repository contribution checks.
