# Ramp

Connect Ramp's hosted MCP server with browser OAuth, then use its live tools and the included official finance skills. Each OpenTeam account keeps independent OAuth credentials, tools, and activity. Ramp enforces the user's role and selected read-only or full access. Connections expire and can be renewed through account settings.

If Ramp rejects authorization for a custom client, request allowlisting for the exact callback URL shown in OpenTeam. Server callbacks are shared across accounts within a deployment. Desktop sign-in can use a fixed loopback port configured in account settings. See [Ramp's connection guide](https://agents.ramp.com/docs/guides/connecting).

## Included workflows

The package includes 29 official Ramp skills and their supporting references from the commit pinned in `upstream.json`. Original files are preserved under `upstream/`. The OpenTeam skill and rule handle account routing, differences between conceptual and actual tool names, and CLI setup. MIT notices are included in `LICENSE` and `upstream/LICENSE`.

The CLI fallback supports document uploads and other CLI-only playbooks. It downloads official Ramp CLI 0.2.97 for macOS/Linux ARM64 or x64 and verifies a pinned SHA-256 checksum before publishing the installation. Bun, curl, and tar are required. CLI setup uses a separate Ramp authorization and a private configuration directory keyed by the selected OpenTeam connection ID. Run all CLI commands through `skills/ramp-openteam/scripts/ramp.ts`; the skill describes login, identity verification, and logout.

Disconnecting the OpenTeam account stops its MCP connection. A separate CLI session requires `auth logout` through the helper or revocation in Ramp. Plugin removal does not delete separately installed CLI state. `OPENTEAM_RAMP_HOME` can select an absolute directory for managed CLI installations and account state; defaults use writable `/workspace` on the Bot computer or the user's application-data directory.

Tools and workflows depend on Ramp permissions, business features, environment, and access level. In particular, a read-only connection cannot validate financial writes. Test a small read before running a workflow. Bill approval can advance payment according to the business's Ramp settings.
