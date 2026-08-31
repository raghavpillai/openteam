import {
  describeRoutineSchedule,
  parseRoutineSchedule,
  type RoutineScheduleDraft,
  type RoutineView,
  routineDraftValid,
  routineScheduleDrafts,
  routineScheduleValues,
} from "./routines";

export type RoutineTriggerKind =
  | "schedule"
  | "slack"
  | "github"
  | "microsoftTeams"
  | "linear"
  | "sentry"
  | "pagerduty"
  | "webhook";

export type RoutineTriggerDraft =
  | { kind: "schedule"; schedule: RoutineScheduleDraft }
  | {
      kind: "slack";
      channel: string;
      match: "message" | "keyword" | "reaction" | "mention";
      keyword: string;
      emoji: string;
      bySelf: boolean;
    }
  | {
      kind: "github";
      repo: string;
      events: string[];
      userAllowlist: string;
      ciBranch: string;
      pr?: number;
    }
  | {
      kind: "microsoftTeams";
      tenantId: string;
      teamIds: string;
      channelIds: string;
      messageContains: string;
      messageContainsIsRegex: boolean;
      blockUnauthenticatedTeamsUsers: boolean;
    }
  | {
      kind: "linear";
      event: "issueCreated" | "statusChanged" | "endOfCycle";
      statusIds: string;
      cycleIds: string;
      projectIds: string;
      teamIds: string;
    }
  | {
      kind: "sentry";
      event:
        | "issueCreated"
        | "issueResolved"
        | "issueAssigned"
        | "issueArchived"
        | "issueUnresolved"
        | "issueAny";
      projectIds: string;
    }
  | {
      kind: "pagerduty";
      event:
        | "incidentTriggered"
        | "incidentAcknowledged"
        | "incidentResolved"
        | "incidentEscalated"
        | "incidentAny";
      serviceIds: string;
    }
  | { kind: "webhook" }
  | { kind: "unsupported"; trigger: unknown };

export const routineTriggerKinds: Array<{ kind: RoutineTriggerKind; label: string }> = [
  { kind: "schedule", label: "On a schedule" },
  { kind: "slack", label: "Slack message" },
  { kind: "github", label: "Git event" },
  { kind: "microsoftTeams", label: "Teams message" },
  { kind: "linear", label: "Linear issue" },
  { kind: "sentry", label: "Sentry alert" },
  { kind: "pagerduty", label: "PagerDuty incident" },
  { kind: "webhook", label: "Webhook" },
];

export const defaultRoutineTriggerDraft = (
  kind: Exclude<RoutineTriggerKind, "schedule">
): RoutineTriggerDraft => {
  switch (kind) {
    case "slack":
      return {
        kind,
        channel: "",
        match: "message",
        keyword: "",
        emoji: "",
        bySelf: false,
      };
    case "github":
      return {
        kind,
        repo: "",
        events: ["pr-opened"],
        userAllowlist: "",
        ciBranch: "",
      };
    case "microsoftTeams":
      return {
        kind,
        tenantId: "",
        teamIds: "",
        channelIds: "",
        messageContains: "",
        messageContainsIsRegex: false,
        blockUnauthenticatedTeamsUsers: false,
      };
    case "linear":
      return {
        kind,
        event: "issueCreated",
        statusIds: "",
        cycleIds: "",
        projectIds: "",
        teamIds: "",
      };
    case "sentry":
      return { kind, event: "issueCreated", projectIds: "" };
    case "pagerduty":
      return { kind, event: "incidentTriggered", serviceIds: "" };
    case "webhook":
      return { kind };
  }
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const splitList = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ),
];

const triggerListeners = (trigger: unknown): unknown[] => {
  const value = record(trigger);
  if (!value) return [];
  if (value.type !== "group") return [value];
  const listeners = value.listeners ?? value.triggers;
  return Array.isArray(listeners) ? listeners : [];
};

const draftFromStoredTrigger = (input: unknown): RoutineTriggerDraft => {
  const trigger = record(input);
  if (!trigger || typeof trigger.type !== "string") return { kind: "unsupported", trigger: input };
  switch (trigger.type) {
    case "cron":
      return {
        kind: "schedule",
        schedule: parseRoutineSchedule(
          typeof trigger.schedule === "string" ? trigger.schedule : ""
        ),
      };
    case "slack": {
      const match = record(trigger.match);
      const matchKind = match?.kind;
      return {
        kind: "slack",
        channel: typeof trigger.channel === "string" ? trigger.channel : "",
        match:
          matchKind === "keyword" || matchKind === "reaction" || matchKind === "mention"
            ? matchKind
            : "message",
        keyword: typeof match?.keyword === "string" ? match.keyword : "",
        emoji: strings(match?.emoji).join(", "),
        bySelf: match?.bySelf === true,
      };
    }
    case "github":
      return {
        kind: "github",
        repo: typeof trigger.repo === "string" ? trigger.repo : "",
        events: strings(trigger.events),
        userAllowlist: strings(trigger.userAllowlist).join(", "),
        ciBranch: typeof trigger.ciBranch === "string" ? trigger.ciBranch : "",
        ...(typeof trigger.pr === "number" ? { pr: trigger.pr } : {}),
      };
    case "microsoftTeams":
      return {
        kind: "microsoftTeams",
        tenantId: typeof trigger.tenantId === "string" ? trigger.tenantId : "",
        teamIds: strings(trigger.teamIds).join(", "),
        channelIds: strings(trigger.channelIds).join(", "),
        messageContains: typeof trigger.messageContains === "string" ? trigger.messageContains : "",
        messageContainsIsRegex: trigger.messageContainsIsRegex === true,
        blockUnauthenticatedTeamsUsers: trigger.blockUnauthenticatedTeamsUsers === true,
      };
    case "linear": {
      const event = record(trigger.event);
      const eventCase = event?.case;
      return {
        kind: "linear",
        event:
          eventCase === "statusChanged" || eventCase === "endOfCycle" ? eventCase : "issueCreated",
        statusIds: strings(event?.statusIds).join(", "),
        cycleIds: strings(event?.cycleIds).join(", "),
        projectIds: strings(trigger.projectIds).join(", "),
        teamIds: strings(trigger.teamIds).join(", "),
      };
    }
    case "sentry": {
      const event = record(trigger.event)?.case;
      return {
        kind: "sentry",
        event:
          event === "issueResolved" ||
          event === "issueAssigned" ||
          event === "issueArchived" ||
          event === "issueUnresolved" ||
          event === "issueAny"
            ? event
            : "issueCreated",
        projectIds: strings(trigger.projectIds).join(", "),
      };
    }
    case "pagerduty": {
      const event = record(trigger.event)?.case;
      return {
        kind: "pagerduty",
        event:
          event === "incidentAcknowledged" ||
          event === "incidentResolved" ||
          event === "incidentEscalated" ||
          event === "incidentAny"
            ? event
            : "incidentTriggered",
        serviceIds: strings(trigger.serviceIds).join(", "),
      };
    }
    case "webhook":
      return { kind: "webhook" };
    default:
      return { kind: "unsupported", trigger: input };
  }
};

const presentedDrafts = (presentation: unknown): RoutineTriggerDraft[] | null => {
  const value = record(presentation);
  if (
    value?.version !== 3 ||
    value.kind !== "grok-routine-triggers" ||
    !Array.isArray(value.triggers)
  ) {
    return null;
  }
  const drafts = value.triggers as RoutineTriggerDraft[];
  if (
    drafts.length === 0 ||
    drafts.length > 8 ||
    !drafts.every((draft) => record(draft) && typeof draft.kind === "string")
  ) {
    return null;
  }
  try {
    return routineDraftTriggerValue(drafts) ? drafts : null;
  } catch {
    return null;
  }
};

export const routineTriggerDrafts = (routine: RoutineView): RoutineTriggerDraft[] => {
  const presented = presentedDrafts(routine.triggerPresentation);
  if (presented) return presented;
  const presentation = record(routine.triggerPresentation);
  const stored = routine.trigger ?? (presentation?.version === 1 ? presentation.trigger : null);
  const parsed = triggerListeners(stored).map(draftFromStoredTrigger);
  if (parsed.length > 0) return parsed;
  return routineScheduleDrafts(routine).map((schedule) => ({ kind: "schedule", schedule }));
};

const githubCiEvents = new Set(["ci-passed", "ci-failed"]);

const storedTriggersForDraft = (
  draft: RoutineTriggerDraft
): Array<Record<string, unknown>> | null => {
  switch (draft.kind) {
    case "schedule": {
      if (!routineDraftValid({ name: "Routine", prompt: "Run", schedule: draft.schedule })) {
        return null;
      }
      return routineScheduleValues(draft.schedule).map((schedule) => ({ type: "cron", schedule }));
    }
    case "slack": {
      const channel = draft.channel.trim();
      if (!channel || (channel !== "*" && !/^[#@][^#@\s]+$/.test(channel))) return null;
      if (draft.match === "keyword" && !draft.keyword.trim()) return null;
      const emoji = splitList(draft.emoji)
        .map((item) =>
          item
            .replace(/^:+|:+$/g, "")
            .split("::", 1)[0]
            ?.toLowerCase()
        )
        .filter((item): item is string => Boolean(item && /^[a-z0-9_+-]+$/.test(item)));
      return [
        {
          type: "slack",
          channel,
          match:
            draft.match === "keyword"
              ? { kind: "keyword", keyword: draft.keyword.trim() }
              : draft.match === "reaction"
                ? {
                    kind: "reaction",
                    ...(emoji.length > 0 ? { emoji: [...new Set(emoji)] } : {}),
                    ...(draft.bySelf ? { bySelf: true } : {}),
                  }
                : { kind: draft.match },
        },
      ];
    }
    case "github": {
      const repo = draft.repo.trim();
      const ciBranch = draft.ciBranch.trim();
      if (!/^[^\s/]+\/[^\s/]+$/.test(repo) || draft.events.length === 0) return null;
      if (
        draft.events.some((event) => githubCiEvents.has(event)) &&
        draft.pr === undefined &&
        !ciBranch
      ) {
        return null;
      }
      const allowlist = splitList(draft.userAllowlist).map((item) => item.replace(/^@+/, ""));
      return [
        {
          type: "github",
          repo,
          events: [...new Set(draft.events)],
          ...(draft.pr === undefined ? {} : { pr: draft.pr }),
          ...(allowlist.length > 0 ? { userAllowlist: allowlist } : {}),
          ...(draft.pr === undefined && ciBranch ? { ciBranch } : {}),
        },
      ];
    }
    case "microsoftTeams": {
      const tenantId = draft.tenantId.trim();
      const teamIds = splitList(draft.teamIds);
      if (!tenantId || teamIds.length === 0) return null;
      return [
        {
          type: "microsoftTeams",
          tenantId,
          teamIds,
          channelIds: splitList(draft.channelIds),
          messageContains: draft.messageContains.trim(),
          messageContainsIsRegex: draft.messageContainsIsRegex,
          blockUnauthenticatedTeamsUsers: draft.blockUnauthenticatedTeamsUsers,
        },
      ];
    }
    case "linear":
      return [
        {
          type: "linear",
          event: {
            case: draft.event,
            ...(draft.event === "statusChanged" ? { statusIds: splitList(draft.statusIds) } : {}),
            ...(draft.event === "endOfCycle" ? { cycleIds: splitList(draft.cycleIds) } : {}),
          },
          projectIds: splitList(draft.projectIds),
          teamIds: splitList(draft.teamIds),
        },
      ];
    case "sentry":
      return [
        {
          type: "sentry",
          event: { case: draft.event },
          projectIds: splitList(draft.projectIds),
        },
      ];
    case "pagerduty":
      return [
        {
          type: "pagerduty",
          event: { case: draft.event },
          serviceIds: splitList(draft.serviceIds),
        },
      ];
    case "webhook":
      return [{ type: "webhook" }];
    case "unsupported": {
      const trigger = record(draft.trigger);
      return trigger ? [trigger] : null;
    }
  }
};

export const routineDraftTriggerValue = (
  drafts: readonly RoutineTriggerDraft[]
): Record<string, unknown> | null => {
  const listeners: Array<Record<string, unknown>> = [];
  for (const draft of drafts) {
    const values = storedTriggersForDraft(draft);
    if (!values) return null;
    listeners.push(...values);
  }
  if (listeners.length === 0 || listeners.length > 8) return null;
  return listeners.length === 1 ? (listeners[0] ?? null) : { type: "group", listeners };
};

export const routineTriggerPresentationValue = (
  triggers: readonly RoutineTriggerDraft[]
): Record<string, unknown> => ({
  version: 3,
  kind: "grok-routine-triggers",
  triggers,
});

const scope = (channel: string) => {
  const value = channel.trim();
  return value === "*" ? "all channels" : value || "…";
};

const joined = (value: string, fallback: string) => splitList(value).join(", ") || fallback;

const githubEventSummary: Record<string, string> = {
  "pr-opened": "When a PR opens",
  "pr-pushed": "When a PR updates",
  "pr-merged": "When a PR merges",
  "review-requested": "When a review is requested",
  "review-approved": "When a review is approved",
  "review-changes-requested": "When review changes are requested",
  "review-commented": "When a review is commented on",
  "review-thread-resolved": "When a review thread is resolved",
  "review-thread-unresolved": "When a review thread is reopened",
  "pr-comment": "When a PR is commented on",
  "inline-review-comment": "When an inline review is commented on",
  "ci-passed": "When CI passes",
  "ci-failed": "When CI fails",
  "issue-assigned": "When an issue is assigned",
};

const eventCaseLabel = (value: string, prefix: "issue" | "incident") =>
  value
    .replace(new RegExp(`^${prefix}`), "")
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();

export const describeRoutineTrigger = (draft: RoutineTriggerDraft): string => {
  switch (draft.kind) {
    case "schedule":
      return describeRoutineSchedule(draft.schedule);
    case "slack":
      if (draft.match === "mention") return `When @mentioned in ${scope(draft.channel)}`;
      if (draft.match === "keyword") {
        return `New messages containing “${draft.keyword.trim() || "…"}” in ${scope(draft.channel)}`;
      }
      if (draft.match === "reaction") {
        const emoji = joined(draft.emoji, "any reaction");
        return `${draft.bySelf ? "My reaction" : "Reaction"} ${emoji} in ${scope(draft.channel)}`;
      }
      return `New messages in ${scope(draft.channel)}`;
    case "github": {
      const event = draft.events[0];
      const summary =
        draft.events.length > 1
          ? `When ${draft.events.length} Git events occur`
          : event
            ? (githubEventSummary[event] ?? "When a Git event occurs")
            : "When a Git event occurs";
      return `${summary} in ${draft.repo.trim() || "…"}`;
    }
    case "microsoftTeams": {
      const teams = joined(draft.teamIds, "…");
      const match = draft.messageContains.trim()
        ? ` containing “${draft.messageContains.trim()}”`
        : "";
      return `New messages${match} in ${teams} (tenant ${draft.tenantId.trim() || "…"})`;
    }
    case "linear":
      return draft.event === "statusChanged"
        ? `Issue status → ${joined(draft.statusIds, "any status")}`
        : draft.event === "endOfCycle"
          ? `At end of cycle for ${joined(draft.teamIds, "any team")}`
          : `Issue created in ${joined(draft.projectIds, "all projects")}`;
    case "sentry":
      return `Issue ${eventCaseLabel(draft.event, "issue") || "event"} in ${joined(
        draft.projectIds,
        "all projects"
      )}`;
    case "pagerduty":
      return `Incident ${eventCaseLabel(draft.event, "incident") || "event"} for ${joined(
        draft.serviceIds,
        "all services"
      )}`;
    case "webhook":
      return "When a webhook fires";
    case "unsupported":
      return "This trigger needs a newer app version";
  }
};

export const routineTriggerDraftValid = (draft: RoutineTriggerDraft): boolean =>
  storedTriggersForDraft(draft) !== null;
