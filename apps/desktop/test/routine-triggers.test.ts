import { describe, expect, test } from "bun:test";
import {
  defaultRoutineTriggerDraft,
  describeRoutineTrigger,
  routineDraftTriggerValue,
  routineTriggerDrafts,
  routineTriggerDraftValid,
  routineTriggerKinds,
  routineTriggerPresentationValue,
  type RoutineTriggerDraft,
} from "../src/renderer/lib/routine-triggers";
import { DEFAULT_ROUTINE_SCHEDULE, type RoutineView } from "../src/renderer/lib/routines";

const routine = (change: Partial<RoutineView> = {}): RoutineView => ({
  id: "routine-1",
  folder: "routine-1",
  ownerId: "bot-1",
  ownerKind: "bot",
  botId: "bot-1",
  channelId: null,
  name: "Parity routine",
  prompt: "Check parity",
  schedule: "0 9 * * 1-5",
  schedules: ["0 9 * * 1-5"],
  scheduleKind: "cron",
  cronExpression: "0 9 * * 1-5",
  intervalSeconds: null,
  timezone: "UTC",
  timezoneMode: "installation",
  enabled: true,
  revision: 1,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  latestExecution: null,
  triggerPresentation: null,
  ...change,
});

describe("Grok-compatible routine triggers", () => {
  test("lists every trigger in Grok's exact order", () => {
    expect(routineTriggerKinds).toEqual([
      { kind: "schedule", label: "On a schedule" },
      { kind: "slack", label: "Slack message" },
      { kind: "github", label: "Git event" },
      { kind: "microsoftTeams", label: "Teams message" },
      { kind: "linear", label: "Linear issue" },
      { kind: "sentry", label: "Sentry alert" },
      { kind: "pagerduty", label: "PagerDuty incident" },
      { kind: "webhook", label: "Webhook" },
    ]);
  });

  test("uses Grok's defaults and blocks only incomplete trigger types", () => {
    const slack = defaultRoutineTriggerDraft("slack");
    const github = defaultRoutineTriggerDraft("github");
    const teams = defaultRoutineTriggerDraft("microsoftTeams");
    expect(slack).toMatchObject({ channel: "", match: "message", bySelf: false });
    expect(github).toMatchObject({ repo: "", events: ["pr-opened"], ciBranch: "" });
    expect(teams).toMatchObject({ tenantId: "", teamIds: "" });
    expect(routineTriggerDraftValid(slack)).toBe(false);
    expect(routineTriggerDraftValid(github)).toBe(false);
    expect(routineTriggerDraftValid(teams)).toBe(false);
    expect(routineTriggerDraftValid(defaultRoutineTriggerDraft("linear"))).toBe(true);
    expect(routineTriggerDraftValid(defaultRoutineTriggerDraft("sentry"))).toBe(true);
    expect(routineTriggerDraftValid(defaultRoutineTriggerDraft("pagerduty"))).toBe(true);
    expect(routineTriggerDraftValid(defaultRoutineTriggerDraft("webhook"))).toBe(true);
  });

  test("serializes a mixed eight-listener routine exactly", () => {
    const triggers: RoutineTriggerDraft[] = [
      { kind: "schedule", schedule: DEFAULT_ROUTINE_SCHEDULE },
      {
        kind: "slack",
        channel: "#alerts",
        match: "reaction",
        keyword: "",
        emoji: ":eyes:, white_check_mark",
        bySelf: true,
      },
      {
        kind: "github",
        repo: "openai/openbot",
        events: ["pr-opened", "ci-failed"],
        userAllowlist: "@alice, bob",
        ciBranch: "main",
      },
      {
        kind: "microsoftTeams",
        tenantId: "tenant-1",
        teamIds: "team-1, team-2",
        channelIds: "channel-1",
        messageContains: "urgent",
        messageContainsIsRegex: false,
        blockUnauthenticatedTeamsUsers: true,
      },
      {
        kind: "linear",
        event: "statusChanged",
        statusIds: "done, cancelled",
        cycleIds: "",
        projectIds: "project-1",
        teamIds: "team-1",
      },
      { kind: "sentry", event: "issueAny", projectIds: "project-1" },
      { kind: "pagerduty", event: "incidentEscalated", serviceIds: "service-1" },
      { kind: "webhook" },
    ];
    expect(routineDraftTriggerValue(triggers)).toEqual({
      type: "group",
      listeners: [
        { type: "cron", schedule: "0 8 * * 1-5" },
        {
          type: "slack",
          channel: "#alerts",
          match: { kind: "reaction", emoji: ["eyes", "white_check_mark"], bySelf: true },
        },
        {
          type: "github",
          repo: "openai/openbot",
          events: ["pr-opened", "ci-failed"],
          userAllowlist: ["alice", "bob"],
          ciBranch: "main",
        },
        {
          type: "microsoftTeams",
          tenantId: "tenant-1",
          teamIds: ["team-1", "team-2"],
          channelIds: ["channel-1"],
          messageContains: "urgent",
          messageContainsIsRegex: false,
          blockUnauthenticatedTeamsUsers: true,
        },
        {
          type: "linear",
          event: { case: "statusChanged", statusIds: ["done", "cancelled"] },
          projectIds: ["project-1"],
          teamIds: ["team-1"],
        },
        { type: "sentry", event: { case: "issueAny" }, projectIds: ["project-1"] },
        {
          type: "pagerduty",
          event: { case: "incidentEscalated" },
          serviceIds: ["service-1"],
        },
        { type: "webhook" },
      ],
    });
  });

  test("enforces schedule validity, CI scope, and the eight-listener limit", () => {
    expect(
      routineTriggerDraftValid({
        kind: "schedule",
        schedule: { ...DEFAULT_ROUTINE_SCHEDULE, preset: "custom", customSchedule: "" },
      })
    ).toBe(false);
    expect(
      routineTriggerDraftValid({
        kind: "github",
        repo: "openai/openbot",
        events: ["ci-failed"],
        userAllowlist: "",
        ciBranch: "",
      })
    ).toBe(false);
    expect(
      routineDraftTriggerValue(Array.from({ length: 9 }, () => ({ kind: "webhook" }) as const))
    ).toBeNull();
  });

  test("round-trips the v3 presentation and falls back safely for malformed data", () => {
    const triggers: RoutineTriggerDraft[] = [
      { kind: "schedule", schedule: DEFAULT_ROUTINE_SCHEDULE },
      { kind: "webhook" },
    ];
    const presentation = JSON.parse(JSON.stringify(routineTriggerPresentationValue(triggers)));
    expect(
      routineTriggerDrafts(
        routine({
          trigger: { type: "group", listeners: routineDraftTriggerValue(triggers) },
          triggerPresentation: presentation,
        })
      )
    ).toEqual(triggers);
    expect(
      routineTriggerDrafts(
        routine({
          trigger: { type: "slack", channel: "#alerts", match: { kind: "message" } },
          triggerPresentation: {
            version: 3,
            kind: "grok-routine-triggers",
            triggers: [{ kind: "slack" }],
          },
        })
      )
    ).toEqual([
      {
        kind: "slack",
        channel: "#alerts",
        match: "message",
        keyword: "",
        emoji: "",
        bySelf: false,
      },
    ]);
  });

  test("describes every trigger without hiding the running routine's cadence", () => {
    expect(describeRoutineTrigger({ kind: "schedule", schedule: DEFAULT_ROUTINE_SCHEDULE })).toBe(
      "On weekdays at 8:00 AM"
    );
    expect(
      describeRoutineTrigger({
        kind: "slack",
        channel: "#alerts",
        match: "keyword",
        keyword: "urgent",
        emoji: "",
        bySelf: false,
      })
    ).toBe("New messages containing “urgent” in #alerts");
    expect(
      describeRoutineTrigger({
        kind: "github",
        repo: "",
        events: ["pr-opened"],
        userAllowlist: "",
        ciBranch: "",
      })
    ).toBe("When a PR opens in …");
    expect(describeRoutineTrigger(defaultRoutineTriggerDraft("microsoftTeams"))).toBe(
      "New messages in … (tenant …)"
    );
    expect(describeRoutineTrigger(defaultRoutineTriggerDraft("sentry"))).toBe(
      "Issue created in all projects"
    );
    expect(describeRoutineTrigger(defaultRoutineTriggerDraft("pagerduty"))).toBe(
      "Incident triggered for all services"
    );
    expect(describeRoutineTrigger({ kind: "webhook" })).toBe("When a webhook fires");
  });
});
