# Grok managed built-in skills

This directory preserves all 47 `SKILL.md` files from the 930Y export byte for
byte. `manifest.json` records hashes, source paths, provenance, and runtime status.
Marketplace/plugin skills and user-authored workflows are excluded.

The export was requested from a newly created Grok bot on an existing account.
Its managed catalog listed these files; its plugin-skill cache and user workflow
directory were empty. A cached finance plugin contributed no skills. These facts
establish the managed/catalog boundary, not a pristine new-account baseline.
Some upstream bodies contain account-specific capabilities, such as template
visibility. Do not treat those statements as OpenTeam deployment facts.

Marketplace UI verification on 2026-09-30: `Your plugins` listed Finance
(one connector, Authenticate) and Origin (one connector, Connected). Finance's
detail page listed one app and Public availability; Origin's detail page listed
one app, Built-in availability, and 28 of 28 tools enabled. Neither detail page
listed skills. The Private skills section said there were no private skills.
Thus this account is not free of installed marketplace entries, even though the
export reports zero plugin skills. The UI does not enumerate or show enabled
toggles for the 47 managed skills, so it cannot establish that all are enabled
or universally supplied to every fresh account.

OpenTeam's active copies are in `src/prompts/managed-skills.json` (relative to the
messaging package). The adjacent `grok-catalog-2026-09-30-parity.json` records
every source-to-runtime difference. There are 45 active skills; source-control
and voice-calls remain reference-only because their required Grok/Origin and
voice-channel backends are unavailable. Copying their text does not implement
those services.

The 22 site playbooks retain the latest upstream recipes, with only
`RequestUserForm` mapped to OpenTeam's `request_user_form`. Other runtime copies
retain necessary tool, platform, secret-handling, and backend-schema adapters.
The new sign-in skill uses credential discovery when available, then the secure
form and screen handoff. Original upstream wording is always available here.

No hidden system prompts or backend implementations are included. The import
tests check byte fidelity, runtime hashes, catalog references, and clean-store
materialization. They do not establish successful live execution on every site.
