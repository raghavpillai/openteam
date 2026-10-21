import { RE2JS } from "re2js";
/** Normalized event contract for authenticated connector adapters. Event IDs must
 * be stable provider delivery IDs. Payload text is data, never authority. */
export interface AutomationEvent {
  id: string;
  source:
    | "slack"
    | "github"
    | "origin"
    | "microsoftTeams"
    | "linear"
    | "sentry"
    | "pagerduty"
    | "email"
    | "webhook";
  kind: string;
  text: string;
  occurredAt?: string;
  channel?: string;
  mention?: boolean;
  emoji?: string;
  bySelf?: boolean;
  repo?: string;
  pr?: number;
  actor?: string;
  /** The pull request's author, for repo events about a PR. */
  prOwner?: string;
  branch?: string;
  tenantId?: string;
  teamId?: string;
  channelId?: string;
  authenticatedUser?: boolean;
  projectId?: string;
  statusId?: string;
  cycleId?: string;
  serviceId?: string;
}
const sources = [
  "slack",
  "github",
  "origin",
  "microsoftTeams",
  "linear",
  "sentry",
  "pagerduty",
  "email",
  "webhook",
];
export function parseAutomationEvent(raw: unknown): AutomationEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("An automation event is required");
  const input = raw as Record<string, unknown>;
  if (
    !sources.includes(String(input.source)) ||
    typeof input.id !== "string" ||
    !input.id.trim() ||
    input.id.length > 256 ||
    typeof input.kind !== "string" ||
    !input.kind ||
    input.kind.length > 80 ||
    typeof input.text !== "string" ||
    input.text.length > 32_000
  )
    throw new Error("Invalid event source, ID, kind or text");
  const event: AutomationEvent = {
    id: input.id,
    source: input.source as AutomationEvent["source"],
    kind: input.kind,
    text: input.text,
  };
  for (const key of [
    "occurredAt",
    "channel",
    "emoji",
    "repo",
    "actor",
    "prOwner",
    "branch",
    "tenantId",
    "teamId",
    "channelId",
    "projectId",
    "statusId",
    "cycleId",
    "serviceId",
  ] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || input[key].length > 512)
        throw new Error(`Invalid event ${key}`);
      event[key] = input[key];
    }
  }
  for (const key of ["mention", "bySelf", "authenticatedUser"] as const)
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`Invalid event ${key}`);
      event[key] = input[key];
    }
  if (input.pr !== undefined) {
    if (typeof input.pr !== "number" || !Number.isSafeInteger(input.pr) || input.pr <= 0)
      throw new Error("Invalid event PR");
    event.pr = input.pr;
  }
  if (event.occurredAt && !Number.isFinite(Date.parse(event.occurredAt)))
    throw new Error("Invalid event timestamp");
  return event;
}
const member = (filter: unknown, value?: string) =>
  !Array.isArray(filter) || !filter.length || (value !== undefined && filter.includes(value));
/** userAllowlist gates who drives each kind: the PR author for PR and comment events, the
 * reviewer or the PR author for review events, the assigner for assignments, and never CI. */
const allowlisted = (filter: unknown, event: AutomationEvent) => {
  if (!Array.isArray(filter) || !filter.length || event.kind.startsWith("ci-")) return true;
  const logins = filter.map((login) => String(login).replace(/^@+/, "").toLowerCase());
  const named = (login?: string) => login !== undefined && logins.includes(login.toLowerCase());
  if (event.kind === "issue-assigned") return named(event.actor);
  if (event.kind.startsWith("review-")) return named(event.actor) || named(event.prOwner);
  return named(event.prOwner);
};
export function matchesAutomationEvent(
  trigger: Record<string, unknown>,
  event: AutomationEvent
): boolean {
  if (trigger.type === "group")
    return (
      Array.isArray(trigger.listeners) &&
      trigger.listeners.some((item) => matchesAutomationEvent(item, event))
    );
  if (trigger.type !== event.source) return false;
  const match = (trigger.match ?? {}) as Record<string, unknown>;
  const configuredEvent = (trigger.event ?? {}) as Record<string, unknown>;
  switch (event.source) {
    case "webhook":
      return true;
    case "slack":
      if (
        trigger.channel !== "*" &&
        String(trigger.channel).toLowerCase() !== event.channel?.toLowerCase()
      )
        return false;
      if (match.kind === "message") return event.kind === "message";
      if (match.kind === "mention") return event.kind === "message" && event.mention === true;
      if (match.kind === "keyword")
        return (
          event.kind === "message" &&
          event.text.toLowerCase().includes(String(match.keyword).toLowerCase())
        );
      return (
        match.kind === "reaction" &&
        event.kind === "reaction" &&
        member(match.emoji, event.emoji?.replace(/^:+|:+$/g, "").toLowerCase()) &&
        (match.bySelf !== true || event.bySelf === true)
      );
    case "github":
    case "origin":
      return (
        String(trigger.repo).toLowerCase() === event.repo?.toLowerCase() &&
        member(trigger.events, event.kind) &&
        (trigger.pr === undefined || trigger.pr === event.pr) &&
        (trigger.ciBranch === undefined ||
          !event.kind.startsWith("ci-") ||
          trigger.ciBranch === event.branch) &&
        allowlisted(trigger.userAllowlist, event)
      );
    case "microsoftTeams": {
      if (
        trigger.tenantId !== event.tenantId ||
        !member(trigger.teamIds, event.teamId) ||
        !member(trigger.channelIds, event.channelId) ||
        (trigger.blockUnauthenticatedTeamsUsers === true && !event.authenticatedUser)
      )
        return false;
      const pattern = String(trigger.messageContains ?? "");
      if (!pattern) return true;
      if (!trigger.messageContainsIsRegex)
        return event.text.toLowerCase().includes(pattern.toLowerCase());
      try {
        return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE).matcher(event.text).find();
      } catch {
        return false;
      }
    }
    case "linear":
      return (
        configuredEvent.case === event.kind &&
        member(trigger.projectIds, event.projectId) &&
        member(trigger.teamIds, event.teamId) &&
        member(configuredEvent.statusIds, event.statusId) &&
        member(configuredEvent.cycleIds, event.cycleId)
      );
    case "sentry":
      return (
        (configuredEvent.case === "issueAny" || configuredEvent.case === event.kind) &&
        member(trigger.projectIds, event.projectId)
      );
    case "pagerduty":
      return (
        (configuredEvent.case === "incidentAny" || configuredEvent.case === event.kind) &&
        member(trigger.serviceIds, event.serviceId)
      );
    case "email": {
      // channel is the receiving mailbox and actor the From address. authenticatedUser
      // records the receiving server's DMARC/DKIM verdict for that From domain.
      if (String(trigger.inbox).toLowerCase() !== event.channel?.toLowerCase()) return false;
      const sender = event.actor?.toLowerCase() ?? "";
      const senders = Array.isArray(trigger.from)
        ? trigger.from.map((entry) => String(entry).toLowerCase())
        : [];
      if (
        senders.length &&
        !senders.some((entry) =>
          entry.startsWith("@") ? sender.endsWith(entry) : entry === sender
        )
      )
        return false;
      return trigger.requireAuthPass === false || event.authenticatedUser === true;
    }
  }
}
