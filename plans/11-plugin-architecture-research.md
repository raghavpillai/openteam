# Plugin system: remaining work

Status: install/connect/grant/policy/OAuth/MCP/UI foundation shipped; release lifecycle,
distribution breadth, and stdio containment remain open
Last audited: 2026-09-01

## Open work

### Release update and rollback

- Represent multiple immutable releases per plugin with source revision, digest, compatibility, and
  blocked-version metadata.
- Add an update review that shows publisher, component, connector domain, command, permission, and
  trust changes before activation.
- Make activation transactional and recoverable: retain the previous known-good release, roll back
  failed health checks, and expose manual rollback with durable audit history.
- Define how connections, bot grants, policies, skills, and plugin-owned data migrate across a
  release without silently broadening access.

### Catalog and distribution

- Expand the small bundled catalog with curated, independently validated connectors and skills.
- Decide whether to support private Git/package sources and Agent Plugins import; normalize them
  into the OpenBot manifest without executing foreign lifecycle scripts.
- If public publishing is wanted, add publisher identity, review ownership, signing/provenance,
  revocation, moderation, and staged rollout. This is optional and must not become a Cursor
  marketplace dependency.
- Add provider-side OAuth revocation where supported; account removal must say clearly when it only
  deletes OpenBot's token.

### Local stdio containment

- Replace the supervised-child boundary with a tested sandbox that constrains filesystem roots,
  network egress, environment, process count, memory, CPU, and lifetime.
- Deny Docker socket, host home, unrelated credentials, arbitrary lifecycle scripts, and implicit
  package installation by default.
- Add explicit operator allowlists for commands/packages/domains and auditable exceptions.
- Trace the effective MCP protocol/transport matrix needed by supported servers, including
  cancellation and crash-loop behavior; do not add elicitation/tasks/UI support without a product
  requirement and threat model.

## Acceptance gates

1. An update cannot activate until its digest and compatibility pass and its permission/component
   diff is visible; failure restores the previous working release without losing connections or
   grants.
2. Rollback, uninstall, account removal, and provider revocation are distinct, truthful, audited
   actions.
3. A malicious stdio plugin cannot access the host home, Docker socket, unrelated plugin data,
   connector secrets, or unrestricted network/filesystem resources.
4. Catalog additions remain bounded and lazy in model context, and every tool call is reauthorized
   against the current connection, bot grant, policy, and exact arguments.
5. The desktop and mobile plugin surfaces cover update, failure, rollback, partial-source outage,
   keyboard/accessibility, and multi-account provenance states.

## Current code to extend

- `apps/server/src/services/plugin-service.ts`
- `apps/server/src/plugins/openbot-marketplace.ts`
- `apps/server/src/plugins/mcp-client-manager.ts`
- `apps/desktop/src/renderer/components/openbot/plugin-settings.tsx`
- `apps/mobile/src/components/plugin-marketplace-sheet.tsx`
- `apps/mobile/src/components/plugin-manager-sheet.tsx`
