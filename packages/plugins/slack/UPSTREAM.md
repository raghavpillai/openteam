# Slack source

`upstream/` contains unchanged runtime files from
[slackapi/slack-skills-plugin](https://github.com/slackapi/slack-skills-plugin/tree/8044341769fa84f85ee952dceddb67ef165ab110).
`upstream.json` pins the revision and SHA-256 digest of each original file.
The MIT notice is retained in `upstream/LICENSE`.

The outer `plugin.json` supplies OpenTeam's stable package identity and account
setup. Slack's original Cursor client ID is preserved in the source file but is
never used as this deployment's OAuth identity. Configure your own Slack app.
Tool discovery, account routing, and host tool compatibility live in shared
runtime code; no provider workflow text is rewritten.

Slack hosts and versions the MCP tools independently of these pinned files.
