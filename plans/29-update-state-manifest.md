# `update_state` compatibility manifest

Status: durable state and scheduled routine lifecycle implemented; event triggers deferred  
Last updated: 2026-08-25

## Purpose

`update_state` is the model-facing write API for one agent's durable OpenBot state. Every call requires `target` and `action`. Only fields relevant to that exact pair are interpreted; unrelated compatibility fields are ignored. Reads do not use this tool.

This document preserves the full supplied shape so future OpenBot work can implement each branch without rediscovering it. It is a compatibility contract, not permission to expose one unrestricted database update.

Current delivery boundary:

- the native Pi tool implements memory, scheduled routine, skill, profile, settings, channel disconnect state, project, and avatar pairs;
- routine create, update, pause, resume, and delete accept a top-level `schedule` or the equivalent cron trigger and dispatch through the typed `RoutineService`;
- non-cron event-trigger shapes remain recorded below as deferred compatibility reference.

The server always binds the current bot, user/installation, active run, and idempotency key from trusted host context. The model cannot choose those identities.

## Top-level shape

```ts
type UpdateStateCall = {
  target:
    | "memory"
    | "routine"
    | "skill"
    | "profile"
    | "settings"
    | "channel"
    | "project"
    | "avatar";
  action:
    | "write"
    | "forget"
    | "create"
    | "update"
    | "pause"
    | "resume"
    | "delete"
    | "set"
    | "disconnect"
    | "join"
    | "leave"
    | "clear";

  // Pair-specific compatibility fields. Most calls use only a few.
  id?: string;
  name?: string;
  description?: string;
  fact?: string;
  tier?: "profile" | "log" | "note";
  scope?: "agent" | "user" | "project";
  project?: string;
  prompt?: string;
  schedule?: string;
  trigger?: RoutineTrigger;
  enabled?: boolean;
  body?: string;
  hidden_from_sidebar?: boolean;
  notify_on_updates?: boolean;
  platform?: string;
  path?: string;
};
```

## Valid target/action pairs

| Target | Actions |
|---|---|
| `memory` | `write`, `forget` |
| `routine` | `create`, `update`, `pause`, `resume`, `delete` |
| `skill` | `write`, `delete` |
| `profile` | `set` |
| `settings` | `set` |
| `channel` | `disconnect` |
| `project` | `create`, `join`, `leave` |
| `avatar` | `set`, `clear` |

Any other pair returns `invalid_target_action`.

## Memory

### `memory/write`

Save a fact.

| Field | Requirement | Meaning |
|---|---|---|
| `fact` | required | Exact fact text |
| `tier` | optional, default `log` | `profile`, `log`, or `note` |
| `scope` | optional, default `agent` | `agent`, `user`, or `project` |
| `project` | required for project scope | Project slug |

Tier semantics:

- `profile`: foundational and kept in mind every turn;
- `log`: dated history;
- `note`: short-lived and fades quickly.

Facts are deduplicated.

```json
{
  "target": "memory",
  "action": "write",
  "fact": "The weekly report uses net revenue, not gross revenue.",
  "tier": "profile",
  "scope": "project",
  "project": "finance-ops"
}
```

### `memory/forget`

Drop a fact by its exact recorded text. Pass the same `scope` and `project` used by the original fact.

```json
{
  "target": "memory",
  "action": "forget",
  "fact": "The weekly report uses net revenue, not gross revenue.",
  "scope": "project",
  "project": "finance-ops"
}
```

## Routine

### `routine/create`

Required:

- `name`;
- `prompt`;
- exactly one of `schedule` or `trigger`.

Optional `enabled` defaults to `true`.

```json
{
  "target": "routine",
  "action": "create",
  "name": "Weekday digest",
  "prompt": "Review current project activity and post a concise digest with source links.",
  "schedule": "CRON_TZ=America/New_York 0 9 * * 1-5",
  "enabled": true
}
```

### `routine/update`

`id` is required. Pass any of `name`, `prompt`, `schedule`, `trigger`, or `enabled`. Omitted fields stay unchanged. Revision history is retained.

```json
{
  "target": "routine",
  "action": "update",
  "id": "f2e8d8bc-9aa5-42f0-96f1-7dc7f70294d0",
  "schedule": "CRON_TZ=America/New_York 30 9 * * 1-5"
}
```

Changing from `schedule` to `trigger`, or back, replaces the prior timing mode; a routine never has both.

### `routine/pause`, `routine/resume`, `routine/delete`

Only `id` is required. The supplied compatibility description calls this ID the routine's folder. OpenBot treats it as an opaque routine ID and may expose a read projection under an agent-data folder later; callers must not parse it as a filesystem path.

```json
{ "target": "routine", "action": "pause", "id": "f2e8d8bc-9aa5-42f0-96f1-7dc7f70294d0" }
```

Create or schedule-changing calls may require a user confirmation surface before persistence. That policy is enforced by the typed routine service, not by trusting prompt wording.

### Schedule strings

A schedule is either:

- a five-field cron expression interpreted in the installation's local time;
- the same expression prefixed with `CRON_TZ=<IANA>` to pin a zone;
- `@hourly`, `@daily`, `@weekly`, or `@monthly`;
- a fixed interval such as `@every 30m`.

Examples:

```text
0 7 * * *
0 9 * * 1-5
CRON_TZ=Europe/London 0 8 * * 1-5
@hourly
@every 30m
```

The scheduled-routines implementation details and initial frequency limits are in `28-scheduled-routines.md`.

## Skill

### `skill/write`

Required fields:

- `name`;
- `description`, written as a useful "use this when..." description;
- `body`, a Markdown recipe.

Pass `id` to rewrite an existing skill. A skill has no trigger; scheduled execution belongs to a routine.

```json
{
  "target": "skill",
  "action": "write",
  "name": "Weekly account health",
  "description": "Use this when preparing the weekly account-risk review.",
  "body": "# Steps\n\n1. Load the current account list.\n2. Verify freshness.\n3. Produce a linked risk table."
}
```

### `skill/delete`

Requires `id`. Cursor-managed skills cannot be edited or deleted.

## Profile

### `profile/set`

Pass `name`, `description`, or both. Avatar changes use the `avatar` target.

```json
{
  "target": "profile",
  "action": "set",
  "name": "Release coordinator",
  "description": "Owns release readiness, status, and follow-up."
}
```

## Settings

### `settings/set`

Only supplied fields change:

- `hidden_from_sidebar` (boolean): hide the agent row while keeping it reachable through command/search and hidden chats;
- `notify_on_updates` (boolean): control notifications about this assistant.

```json
{
  "target": "settings",
  "action": "set",
  "notify_on_updates": false
}
```

## Channel

### `channel/disconnect`

Requires `platform`. It closes that connector asynchronously.

```json
{ "target": "channel", "action": "disconnect", "platform": "slack" }
```

The compatibility API cannot delete agents or channels.

## Project

### `project/create`

Requires:

- `project`: stable slug;
- `name`: display name.

`description` is optional. Creating an existing slug behaves as join.

```json
{
  "target": "project",
  "action": "create",
  "project": "q3-launch",
  "name": "Q3 launch",
  "description": "Shared launch planning and artifacts."
}
```

### `project/join` and `project/leave`

Require the `project` slug.

```json
{ "target": "project", "action": "join", "project": "q3-launch" }
```

## Avatar

### `avatar/set`

Requires `path` to an image already available to the agent. Accepted formats are PNG, JPG/JPEG, WebP, GIF, and SVG under 5 MB. The implementation must resolve and normalize the image under its allowed artifact roots rather than trusting an arbitrary host path.

```json
{ "target": "avatar", "action": "set", "path": "/workspace/shared/avatar.png" }
```

### `avatar/clear`

No pair-specific fields. Restore the default picture.

```json
{ "target": "avatar", "action": "clear" }
```

## Routine trigger union

Triggers are used instead of `schedule`. The cron variant is implemented as an alias in the schedule-only service. All other variants are compatibility documentation until the connector/event milestone implements connection references, verification, replay, and provider-specific idempotency.

```ts
type RoutineTrigger =
  | CronTrigger
  | SlackTrigger
  | GitHubTrigger
  | OriginTrigger
  | MicrosoftTeamsTrigger
  | LinearTrigger
  | SentryTrigger
  | PagerDutyTrigger
  | WebhookTrigger
  | GroupTrigger;
```

### Cron trigger

```ts
type CronTrigger = {
  type: "cron";
  schedule: string;
};
```

Example:

```json
{ "type": "cron", "schedule": "0 7 * * *" }
```

The top-level `schedule` form is preferred for schedule-only OpenBot routines. This trigger variant exists for compatibility with grouped listeners.

### Slack trigger

```ts
type SlackTrigger = {
  type: "slack";
  channel: `#${string}` | `@${string}` | "*";
  match:
    | { kind: "mention" }
    | { kind: "message" }
    | { kind: "keyword"; keyword: string }
    | { kind: "reaction"; emoji?: string; bySelf?: boolean };
};
```

Reaction emoji values use short names without colons.

### GitHub trigger

```ts
type GitHubEvent =
  | "pr-opened"
  | "pr-pushed"
  | "pr-merged"
  | "pr-closed"
  | "review-requested"
  | "review-approved"
  | "review-changes-requested"
  | "review-commented"
  | "pr-comment"
  | "inline-review-comment"
  | "review-thread-resolved"
  | "review-thread-unresolved"
  | "issue-assigned"
  | "ci-passed"
  | "ci-failed";

type GitHubTrigger = {
  type: "github";
  repo: `${string}/${string}`;
  events: GitHubEvent[];
  pr?: string | number;
  userAllowlist?: string[];
  ciBranch?: string;
};
```

`ciBranch` is required for repo-wide CI when `pr` is absent. A PR-scoped listener containing `pr-merged` or `pr-closed` deletes itself after that terminal wake.

### Origin trigger

```ts
type OriginEvent = Exclude<GitHubEvent, "pr-closed" | "issue-assigned">;

type OriginTrigger = {
  type: "origin";
  repo: `${string}/${string}`;
  events: OriginEvent[];
  pr?: string | number;
  userAllowlist?: string[];
};
```

Origin supports native Origin repositories, not GitHub mirrors. CI is PR-scoped, so `pr` is required for `ci-passed` or `ci-failed`.

### Microsoft Teams trigger

```ts
type MicrosoftTeamsTrigger = {
  type: "microsoftTeams";
  tenantId: string;
  teamId?: string;
  teamIds?: string[];
  channelIds?: string[];
  messageContains?: string;
  messageContainsIsRegex?: boolean;
  blockUnauthenticatedTeamsUsers?: boolean;
};
```

Exactly one of `teamId` or `teamIds` should be supplied.

### Linear trigger

```ts
type LinearTrigger = {
  type: "linear";
  event:
    | { case: "issueCreated" }
    | { case: "statusChanged"; statusIds?: string[] }
    | { case: "endOfCycle"; cycleIds?: string[] };
  projectIds?: string[];
  teamIds?: string[];
};
```

### Sentry trigger

```ts
type SentryTrigger = {
  type: "sentry";
  event: {
    case:
      | "issueCreated"
      | "issueResolved"
      | "issueAssigned"
      | "issueArchived"
      | "issueUnresolved"
      | "issueAny";
  };
  projectIds?: string[];
};
```

### PagerDuty trigger

```ts
type PagerDutyTrigger = {
  type: "pagerduty";
  event: {
    case:
      | "incidentTriggered"
      | "incidentAcknowledged"
      | "incidentResolved"
      | "incidentEscalated"
      | "incidentAny";
  };
  serviceIds?: string[];
};
```

### Webhook trigger

```ts
type WebhookTrigger = { type: "webhook" };
```

The generated URL and sender key live in the routine panel. The model never receives the sender key.

### Group trigger

```ts
type GroupTrigger = {
  type: "group";
  listeners: Array<CronTrigger | SlackTrigger | GitHubTrigger | OriginTrigger>;
};
```

Any one listener fires the same prompt. Origin can group with cron, Slack, and GitHub. Teams, Linear, Sentry, PagerDuty, and webhook cannot be group members in the supplied contract.

## Validation and dispatch rules

1. Decode the compatibility envelope, then validate the exact `(target, action)` pair with a typed command schema.
2. Require the pair's mandatory fields and semantic constraints even though unrelated top-level compatibility fields are ignored.
3. Reject unknown target/action values and unknown trigger variants.
4. Bind caller identity, owning bot, user scope, current run, connector grants, and idempotency key on the server.
5. Re-authorize destructive and consequential changes at execution time.
6. Store an immutable audit/revision event for every effective mutation.
7. A repeated host call ID returns the original result and must not duplicate a mutation.
8. Never accept raw Prisma field names, arbitrary filesystem destinations, credentials, webhook keys, or another bot's identity through this envelope.
9. Return a bounded structured result containing the affected target ID, effective state, and any required next step. Never return secrets.
10. Reads use purpose-built repositories or safe agent-readable projections; `update_state` is write-only.

## Implementation ownership

| Pair group | Owning service | Delivery |
|---|---|---|
| Routine lifecycle | typed `RoutineService` called by the existing durable-state facade | Implemented for schedules |
| Memory write/forget | typed Postgres records and prompt projection | Implemented |
| Skill write/delete | typed bot skill registry and prompt projection | Implemented |
| Profile/settings/avatar | bot profile/settings service and avatar asset route | Implemented |
| Channel disconnect | durable connector gate consumed by future adapters | Implemented state gate |
| Project create/join/leave | project registry, membership, folder, and `project.md` | Implemented |
| Event triggers | provider-specific connector listeners | Deferred |

The runtime manifest exposes the routine target and lifecycle actions because the typed routine service is now present. Every exposed pair validates through its owning typed command path, is bound to the active bot/run, emits an audit event, and uses host call IDs for replay safety. Non-cron event trigger variants remain compatibility evidence only and are rejected by the implemented schedule service.
