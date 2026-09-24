# Slack workflow provenance

Skills, commands, and Block Kit references were imported from
https://github.com/slackapi/slack-skills-plugin at revision
`8044341769fa84f85ee952dceddb67ef165ab110` (September 24, 2026).
The upstream MIT copyright and permission notice are retained in `LICENSE`.

OpenTeam modifications:

- Every skill and command links to `OPENTEAM.md` for account routing, runtime
  capabilities, credentials, and action scope.
- Cursor-specific web/question tool names and positional skill arguments are
  expressed in terms of available capabilities and the user's request.
- Developer sandbox and CLI setup keep passwords, API keys, and login challenge
  codes out of chat and shell arguments.
- The package retains OpenTeam's existing Slack app setup, scopes, connection
  key, and OAuth configuration. Upstream client IDs are not bundled as ours.

The source revision pins workflow content only. Slack hosts and versions the
MCP tools independently; discover their current schemas when invoking them.
