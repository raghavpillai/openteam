# GitHub

Connects GitHub's official remote MCP server (`https://api.githubcopilot.com/mcp/`) so Bots can search repositories, inspect code, manage issues, and work with pull requests. OpenTeam discovers the tools from GitHub's server when an account connects; `plugin.json` declares only the connection and setup. The package has no skills.

## Accounts

Each account is one GitHub personal access token. Create a fine-grained token in GitHub settings, give it only the repositories and permissions you want OpenTeam to use, and paste it into **Personal access token**. Your server stores the token. Use **Add Another Account** for another token or GitHub identity.

Installed plugins and their connected accounts are available to all bots, and connected tools run directly. The token's repository access and permissions are the limit on what a Bot can do.

The setup form links GitHub's [host integration guide](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md) for the server.
