const MAX_GROUP_TRIGGERS = 8;
const GITHUB_EVENT_KINDS = new Set([
  "pr-opened",
  "pr-pushed",
  "pr-merged",
  "pr-closed",
  "review-requested",
  "review-approved",
  "review-changes-requested",
  "review-commented",
  "pr-comment",
  "inline-review-comment",
  "review-thread-resolved",
  "review-thread-unresolved",
  "issue-assigned",
  "ci-passed",
  "ci-failed",
]);
const ORIGIN_EVENT_KINDS = new Set(
  [...GITHUB_EVENT_KINDS].filter((kind) => kind !== "pr-closed" && kind !== "issue-assigned")
);
const CI_EVENT_KINDS = new Set(["ci-passed", "ci-failed"]);
const ORIGIN_EXCLUSIONS = new Set(["microsoftTeams", "linear", "sentry", "pagerduty", "webhook"]);

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const line = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, maximum);
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
};

const stringList = (value: unknown, maximumItems: number, maximumLength: number): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().slice(0, maximumLength);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= maximumItems) break;
  }
  return result;
};

const parseSlack = (trigger: Record<string, unknown>): Record<string, unknown> => {
  const channel = line(trigger.channel, "trigger.channel", 80);
  if (channel !== "*" && !/^[#@][^#@\s]+$/.test(channel)) {
    throw new Error("slack trigger channel must be *, #channel, or @dm");
  }
  const match = object(trigger.match, "trigger.match");
  const kind = line(match.kind, "trigger.match.kind", 40);
  if (kind === "mention" || kind === "message") {
    return { type: "slack", channel, match: { kind } };
  }
  if (kind === "keyword") {
    return {
      type: "slack",
      channel,
      match: { kind, keyword: line(match.keyword, "trigger.match.keyword", 120) },
    };
  }
  if (kind === "reaction") {
    const emoji = stringList(match.emoji, 8, 100)
      .map((entry) =>
        entry
          .replace(/^:+|:+$/g, "")
          .split("::", 1)[0]
          ?.trim()
          .toLowerCase()
      )
      .filter(
        (entry): entry is string => typeof entry === "string" && /^[a-z0-9_+-]+$/.test(entry)
      );
    const uniqueEmoji = emoji.filter((entry, index) => emoji.indexOf(entry) === index);
    return {
      type: "slack",
      channel,
      match: {
        kind,
        ...(uniqueEmoji.length > 0 ? { emoji: uniqueEmoji } : {}),
        ...(match.bySelf === true ? { bySelf: true } : {}),
      },
    };
  }
  throw new Error(`unsupported slack match kind: ${kind}`);
};

const validGitBranch = (value: string): boolean =>
  !/[\s~^:?*[\\]/.test(value) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.includes("//") &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.endsWith(".") &&
  !value.endsWith(".lock");

const parseGithubLike = (
  trigger: Record<string, unknown>,
  type: "github" | "origin"
): Record<string, unknown> => {
  const repo = line(trigger.repo, "trigger.repo", 140);
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
    throw new Error(`${type} trigger repo must be owner/name`);
  }
  const allowed = type === "github" ? GITHUB_EVENT_KINDS : ORIGIN_EVENT_KINDS;
  let events = stringList(trigger.events, GITHUB_EVENT_KINDS.size, 80).filter((kind) =>
    allowed.has(kind)
  );
  const pr =
    typeof trigger.pr === "number" && Number.isSafeInteger(trigger.pr) && trigger.pr > 0
      ? trigger.pr
      : null;
  const authoredBranch =
    type === "github" && typeof trigger.ciBranch === "string"
      ? trigger.ciBranch.trim().slice(0, 200)
      : "";
  const ciBranch = authoredBranch && validGitBranch(authoredBranch) ? authoredBranch : null;
  if (type === "github") {
    events = events.filter((kind) => !CI_EVENT_KINDS.has(kind) || pr !== null || ciBranch !== null);
  } else {
    events = events.filter((kind) => !CI_EVENT_KINDS.has(kind) || pr !== null);
  }
  if (events.length === 0) throw new Error(`${type} trigger requires at least one usable event`);
  const allowlist: string[] = [];
  const seen = new Set<string>();
  for (const candidate of stringList(trigger.userAllowlist, 50, 81)) {
    const login = candidate.replace(/^@+/, "").slice(0, 80);
    const key = login.toLowerCase();
    if (!login || seen.has(key)) continue;
    seen.add(key);
    allowlist.push(login);
  }
  const watchesCi = events.some((kind) => CI_EVENT_KINDS.has(kind));
  return {
    type,
    repo,
    events,
    ...(pr === null ? {} : { pr }),
    ...(allowlist.length > 0 ? { userAllowlist: allowlist } : {}),
    ...(type === "github" && watchesCi && pr === null && ciBranch ? { ciBranch } : {}),
  };
};

const parseTeams = (trigger: Record<string, unknown>): Record<string, unknown> => {
  const tenantId = line(trigger.tenantId, "trigger.tenantId", 200);
  const teamIds = stringList(
    trigger.teamIds ?? (typeof trigger.teamId === "string" ? [trigger.teamId] : []),
    50,
    200
  );
  if (teamIds.length === 0) throw new Error("microsoftTeams trigger requires a team id");
  return {
    type: "microsoftTeams",
    tenantId,
    teamIds,
    channelIds: stringList(trigger.channelIds, 50, 200),
    messageContains:
      typeof trigger.messageContains === "string" ? trigger.messageContains.slice(0, 2_000) : "",
    messageContainsIsRegex: trigger.messageContainsIsRegex === true,
    blockUnauthenticatedTeamsUsers: trigger.blockUnauthenticatedTeamsUsers === true,
  };
};

const parseCaseTrigger = (
  trigger: Record<string, unknown>,
  type: "linear" | "sentry" | "pagerduty"
): Record<string, unknown> => {
  const event = object(trigger.event, "trigger.event");
  const eventCase = line(event.case, "trigger.event.case", 80);
  if (type === "linear") {
    if (!["issueCreated", "statusChanged", "endOfCycle"].includes(eventCase)) {
      throw new Error(`unsupported linear event case: ${eventCase}`);
    }
    return {
      type,
      event: {
        case: eventCase,
        ...(eventCase === "statusChanged"
          ? { statusIds: stringList(event.statusIds, 50, 200) }
          : {}),
        ...(eventCase === "endOfCycle" ? { cycleIds: stringList(event.cycleIds, 50, 200) } : {}),
      },
      projectIds: stringList(trigger.projectIds, 50, 200),
      teamIds: stringList(trigger.teamIds, 50, 200),
    };
  }
  const allowed =
    type === "sentry"
      ? [
          "issueCreated",
          "issueResolved",
          "issueAssigned",
          "issueArchived",
          "issueUnresolved",
          "issueAny",
        ]
      : [
          "incidentTriggered",
          "incidentAcknowledged",
          "incidentResolved",
          "incidentEscalated",
          "incidentAny",
        ];
  if (!allowed.includes(eventCase)) throw new Error(`unsupported ${type} event case: ${eventCase}`);
  return {
    type,
    event: { case: eventCase },
    ...(type === "sentry"
      ? { projectIds: stringList(trigger.projectIds, 50, 200) }
      : { serviceIds: stringList(trigger.serviceIds, 50, 200) }),
  };
};

const validateGroup = (listeners: Array<Record<string, unknown>>): Record<string, unknown> => {
  const types = new Set(listeners.map((entry) => entry.type));
  if (types.has("origin") && [...types].some((type) => ORIGIN_EXCLUSIONS.has(String(type)))) {
    throw new Error(
      "origin cannot be grouped with Teams, Linear, Sentry, PagerDuty, or webhook triggers"
    );
  }
  const onlyListener = listeners.length === 1 ? listeners[0] : undefined;
  return onlyListener ?? { type: "group", listeners };
};

export const parseStoredTrigger = (input: unknown): Record<string, unknown> => {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new Error("group trigger must contain at least one listener");
    const listeners = input.slice(0, MAX_GROUP_TRIGGERS).map(parseStoredTrigger);
    if (listeners.some((listener) => listener.type === "group")) {
      throw new Error("group triggers may not contain another group");
    }
    return validateGroup(listeners);
  }
  const trigger = object(input, "trigger");
  const type = line(trigger.type, "trigger.type", 80);
  if (type === "group") {
    const raw = trigger.listeners ?? trigger.triggers;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("group trigger must contain at least one listener");
    }
    const listeners = raw.slice(0, MAX_GROUP_TRIGGERS).map(parseStoredTrigger);
    if (listeners.some((listener) => listener.type === "group")) {
      throw new Error("group triggers may not contain another group");
    }
    return validateGroup(listeners);
  }
  if (type === "cron") {
    return { type, schedule: line(trigger.schedule, "trigger.schedule", 120) };
  }
  if (type === "slack") return parseSlack(trigger);
  if (type === "github" || type === "origin") return parseGithubLike(trigger, type);
  if (type === "microsoftTeams") return parseTeams(trigger);
  if (type === "linear" || type === "sentry" || type === "pagerduty") {
    return parseCaseTrigger(trigger, type);
  }
  if (type === "webhook") return { type };
  throw new Error(`unsupported automation trigger type: ${type}`);
};

export const firstCronSchedule = (trigger: Record<string, unknown>): string | null => {
  if (trigger.type === "cron" && typeof trigger.schedule === "string") return trigger.schedule;
  if (trigger.type !== "group" || !Array.isArray(trigger.listeners)) return null;
  const cron = trigger.listeners.find(
    (listener) =>
      Boolean(listener) &&
      typeof listener === "object" &&
      !Array.isArray(listener) &&
      (listener as { type?: unknown }).type === "cron"
  ) as { schedule?: unknown } | undefined;
  return typeof cron?.schedule === "string" ? cron.schedule : null;
};

export const cronSchedules = (trigger: Record<string, unknown>): string[] => {
  if (trigger.type === "cron" && typeof trigger.schedule === "string") {
    return [trigger.schedule];
  }
  if (trigger.type !== "group" || !Array.isArray(trigger.listeners)) return [];
  return trigger.listeners.flatMap((listener) => {
    if (!listener || typeof listener !== "object" || Array.isArray(listener)) return [];
    const candidate = listener as { type?: unknown; schedule?: unknown };
    return candidate.type === "cron" && typeof candidate.schedule === "string"
      ? [candidate.schedule]
      : [];
  });
};

export const triggerIdentity = (trigger: Record<string, unknown>): string =>
  trigger.type === "cron" && typeof trigger.schedule === "string"
    ? `cron:${trigger.schedule}`
    : JSON.stringify(trigger);
