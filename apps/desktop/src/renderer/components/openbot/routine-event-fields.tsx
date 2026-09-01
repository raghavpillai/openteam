import type { ComponentType } from "react";
import type { RoutineTriggerDraft } from "../../lib/routine-triggers";

interface CompactSelectProps {
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; triggerLabel?: string }>;
  value: string;
}

interface EventPickerProps {
  ariaLabel: string;
  onChange: (values: string[]) => void;
  options: Array<{ value: string; label: string; group: string }>;
  values: string[];
}

const eventFieldClass =
  "h-7 min-w-0 flex-1 rounded-[6px] border border-transparent bg-[#eeeeee] px-2 text-[12px] shadow-none outline-none focus:border-[#2388ff] focus:ring-2 focus:ring-[#2388ff]/25 dark:bg-[#292929]";

function EventField({
  ariaLabel,
  autoFocus,
  onChange,
  placeholder,
  value,
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      className={eventFieldClass}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      type="text"
      value={value}
    />
  );
}

const gitEventOptions = [
  { value: "pr-opened", label: "Opened", group: "Pull request" },
  { value: "pr-pushed", label: "Updated", group: "Pull request" },
  { value: "pr-merged", label: "Merged", group: "Pull request" },
  { value: "review-requested", label: "Requested", group: "Review" },
  { value: "review-approved", label: "Approved", group: "Review" },
  { value: "review-changes-requested", label: "Changes requested", group: "Review" },
  { value: "review-commented", label: "Commented", group: "Review" },
  { value: "review-thread-resolved", label: "Thread resolved", group: "Review" },
  { value: "review-thread-unresolved", label: "Thread reopened", group: "Review" },
  { value: "pr-comment", label: "PR comment", group: "Comment" },
  {
    value: "inline-review-comment",
    label: "Inline review comment",
    group: "Comment",
  },
  { value: "ci-passed", label: "CI passed", group: "Checks" },
  { value: "ci-failed", label: "CI failed", group: "Checks" },
  { value: "issue-assigned", label: "Assigned", group: "Issue" },
];

export function RoutineEventFields({
  value,
  onChange,
  EventPicker,
  SelectControl,
}: {
  value: Exclude<RoutineTriggerDraft, { kind: "schedule" } | { kind: "unsupported" }>;
  onChange: (next: RoutineTriggerDraft) => void;
  EventPicker: ComponentType<EventPickerProps>;
  SelectControl: ComponentType<CompactSelectProps>;
}) {
  const rowClass = "flex min-w-0 flex-wrap items-center gap-1";
  const labelClass = "shrink-0 text-[12px] text-muted-foreground";
  switch (value.kind) {
    case "slack":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <SelectControl
              ariaLabel="Slack event"
              onValueChange={(match) => onChange({ ...value, match: match as typeof value.match })}
              options={[
                {
                  value: "message",
                  label: "New message in channel",
                  triggerLabel: "New messages",
                },
                {
                  value: "reaction",
                  label: "Reaction added to message",
                  triggerLabel: "Reaction added",
                },
                { value: "mention", label: "Bot is mentioned" },
              ]}
              value={value.match === "keyword" ? "message" : value.match}
            />
            <span className={labelClass}>in</span>
            <EventField
              ariaLabel="Slack channel"
              autoFocus={!value.channel}
              onChange={(channel) => onChange({ ...value, channel })}
              placeholder="#channel"
              value={value.channel}
            />
          </div>
          {(value.match === "message" || value.match === "keyword") && (
            <div className={rowClass}>
              <span className={labelClass}>containing</span>
              <EventField
                ariaLabel="Message contains"
                onChange={(keyword) =>
                  onChange({ ...value, keyword, match: keyword.trim() ? "keyword" : "message" })
                }
                placeholder="Any text"
                value={value.keyword}
              />
            </div>
          )}
          {value.match === "reaction" && (
            <>
              <div className={rowClass}>
                <span className={labelClass}>with</span>
                <EventField
                  ariaLabel="Reaction emoji"
                  onChange={(emoji) => onChange({ ...value, emoji })}
                  placeholder="Any emoji"
                  value={value.emoji}
                />
              </div>
              <div className={rowClass}>
                <span className={labelClass}>for</span>
                <SelectControl
                  ariaLabel="Reactor"
                  onValueChange={(bySelf) => onChange({ ...value, bySelf: bySelf === "self" })}
                  options={[
                    { value: "anyone", label: "Anyone" },
                    { value: "self", label: "Only me" },
                  ]}
                  value={value.bySelf ? "self" : "anyone"}
                />
              </div>
            </>
          )}
        </fieldset>
      );
    case "github":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <EventPicker
              ariaLabel="Git events"
              onChange={(events) => onChange({ ...value, events })}
              options={gitEventOptions}
              values={value.events}
            />
            <span className={labelClass}>in</span>
            <EventField
              ariaLabel="Repository"
              autoFocus={!value.repo}
              onChange={(repo) => onChange({ ...value, repo })}
              placeholder="owner/repo"
              value={value.repo}
            />
          </div>
          {value.events.some((event) => event === "ci-passed" || event === "ci-failed") &&
            value.pr === undefined && (
              <div className={rowClass}>
                <span className={labelClass}>on branch</span>
                <EventField
                  ariaLabel="CI branch"
                  onChange={(ciBranch) => onChange({ ...value, ciBranch })}
                  placeholder="main"
                  value={value.ciBranch}
                />
              </div>
            )}
          <div className={rowClass}>
            <span className={labelClass}>from</span>
            <EventField
              ariaLabel="User allowlist"
              onChange={(userAllowlist) => onChange({ ...value, userAllowlist })}
              placeholder="Anyone"
              value={value.userAllowlist}
            />
          </div>
        </fieldset>
      );
    case "microsoftTeams":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <SelectControl
              ariaLabel="Teams event"
              onValueChange={() => undefined}
              options={[
                {
                  value: "message",
                  label: "New message in channel",
                  triggerLabel: "New messages",
                },
              ]}
              value="message"
            />
            <span className={labelClass}>in</span>
            <EventField
              ariaLabel="Team IDs"
              autoFocus={!value.teamIds}
              onChange={(teamIds) => onChange({ ...value, teamIds })}
              placeholder="Team IDs"
              value={value.teamIds}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>tenant</span>
            <EventField
              ariaLabel="Tenant ID"
              onChange={(tenantId) => onChange({ ...value, tenantId })}
              placeholder="Tenant ID"
              value={value.tenantId}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>channels</span>
            <EventField
              ariaLabel="Channel IDs"
              onChange={(channelIds) => onChange({ ...value, channelIds })}
              placeholder="Every channel"
              value={value.channelIds}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>containing</span>
            <EventField
              ariaLabel="Message contains"
              onChange={(messageContains) => onChange({ ...value, messageContains })}
              placeholder="Any message"
              value={value.messageContains}
            />
            <SelectControl
              ariaLabel="Message match"
              onValueChange={(mode) =>
                onChange({ ...value, messageContainsIsRegex: mode === "regex" })
              }
              options={[
                { value: "text", label: "Text" },
                { value: "regex", label: "Regex" },
              ]}
              value={value.messageContainsIsRegex ? "regex" : "text"}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>from</span>
            <SelectControl
              ariaLabel="Teams audience"
              onValueChange={(audience) =>
                onChange({ ...value, blockUnauthenticatedTeamsUsers: audience === "linked" })
              }
              options={[
                { value: "anyone", label: "Anyone" },
                { value: "linked", label: "Only linked users" },
              ]}
              value={value.blockUnauthenticatedTeamsUsers ? "linked" : "anyone"}
            />
          </div>
        </fieldset>
      );
    case "linear":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <SelectControl
              ariaLabel="Linear event"
              onValueChange={(event) => onChange({ ...value, event: event as typeof value.event })}
              options={[
                { value: "issueCreated", label: "Issue created" },
                { value: "statusChanged", label: "Issue status changed" },
                { value: "endOfCycle", label: "End of cycle" },
              ]}
              value={value.event}
            />
          </div>
          {value.event === "statusChanged" && (
            <div className={rowClass}>
              <span className={labelClass}>with status</span>
              <EventField
                ariaLabel="Status IDs"
                onChange={(statusIds) => onChange({ ...value, statusIds })}
                placeholder="Any status"
                value={value.statusIds}
              />
            </div>
          )}
          {value.event === "endOfCycle" && (
            <div className={rowClass}>
              <span className={labelClass}>cycles</span>
              <EventField
                ariaLabel="Cycle IDs"
                onChange={(cycleIds) => onChange({ ...value, cycleIds })}
                placeholder="Any cycle"
                value={value.cycleIds}
              />
            </div>
          )}
          <div className={rowClass}>
            <span className={labelClass}>in</span>
            <EventField
              ariaLabel="Project IDs"
              onChange={(projectIds) => onChange({ ...value, projectIds })}
              placeholder="All projects"
              value={value.projectIds}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>for</span>
            <EventField
              ariaLabel="Team IDs"
              onChange={(teamIds) => onChange({ ...value, teamIds })}
              placeholder="All teams"
              value={value.teamIds}
            />
          </div>
        </fieldset>
      );
    case "sentry":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <SelectControl
              ariaLabel="Sentry event"
              onValueChange={(event) => onChange({ ...value, event: event as typeof value.event })}
              options={[
                { value: "issueCreated", label: "Created" },
                { value: "issueResolved", label: "Resolved" },
                { value: "issueAssigned", label: "Assigned" },
                { value: "issueArchived", label: "Archived" },
                { value: "issueUnresolved", label: "Unresolved" },
                { value: "issueAny", label: "Any issue event" },
              ]}
              value={value.event}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>in</span>
            <EventField
              ariaLabel="Project IDs"
              onChange={(projectIds) => onChange({ ...value, projectIds })}
              placeholder="All projects"
              value={value.projectIds}
            />
          </div>
        </fieldset>
      );
    case "pagerduty":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5"
        >
          <div className={rowClass}>
            <SelectControl
              ariaLabel="PagerDuty event"
              onValueChange={(event) => onChange({ ...value, event: event as typeof value.event })}
              options={[
                { value: "incidentTriggered", label: "Triggered" },
                { value: "incidentAcknowledged", label: "Acknowledged" },
                { value: "incidentResolved", label: "Resolved" },
                { value: "incidentEscalated", label: "Escalated" },
                { value: "incidentAny", label: "Any incident event" },
              ]}
              value={value.event}
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>for</span>
            <EventField
              ariaLabel="Service IDs"
              onChange={(serviceIds) => onChange({ ...value, serviceIds })}
              placeholder="All services"
              value={value.serviceIds}
            />
          </div>
        </fieldset>
      );
    case "webhook":
      return (
        <fieldset
          aria-label="Trigger fields"
          className="m-0 grid gap-1.5 border-0 px-2 pb-2 pt-0.5 text-[12px]"
        >
          <div className={rowClass}>
            <span className={labelClass}>POST to</span>
            <input
              aria-label="Webhook URL"
              className={`${eventFieldClass} text-muted-foreground`}
              placeholder="Available after the routine is saved"
              readOnly
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>key</span>
            <input
              aria-label="Webhook key"
              className={`${eventFieldClass} text-muted-foreground`}
              placeholder="Available after saving"
              readOnly
            />
          </div>
          <div className={rowClass}>
            <span className={labelClass}>header</span>
            <input
              aria-label="Webhook header"
              className={`${eventFieldClass} text-muted-foreground`}
              placeholder="Available after saving"
              readOnly
            />
          </div>
        </fieldset>
      );
  }
}
