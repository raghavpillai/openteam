// @ts-nocheck
// Pure captured reference input schemas and trigger rendering. No host entrypoints.
import { z as external_exports } from "zod";
const invariant=(value,message)=>{if(!value)throw new Error(message);};
class SandToolInputError extends Error {}
const CLOUD_AGENT_INJECTED_SECRET_NAMES_ENV_VAR = "CLOUD_AGENT_INJECTED_SECRET_NAMES";
var SAND_UPDATE_STATE_TOOL_NAME = "update_state";

function nonEmptyTuple(items) {
  if (items.length === 0) {
    throw new Error(`${SAND_UPDATE_STATE_TOOL_NAME} has no operations to offer`);
  }
  const [first, ...rest] = items;
  return [first, ...rest];
}

var OPERATIONS = {
  memory: {
    write: 'save a durable fact (fact, tier, optional scope). scope "agent" (default) is your own memory; "user" is shared user-memory every assistant should know; "project" needs project=<slug> and writes your shard in that project. tier "profile" is foundational and kept in mind every turn; "log" (default) is dated history; "note" fades fast. Facts are deduped.',
    forget: "drop a fact by its EXACT recorded text (fact, same scope/project). Pair with a write for the corrected version."
  },
  routine: {
    create: "save a routine (name, prompt, and either schedule or trigger). prompt is what you do each time it fires, written to your future self.",
    update: "rewrite an existing one in place (id, plus any of name/prompt/schedule/trigger/enabled you mean to change). Omitted fields keep their current values; it keeps its history.",
    pause: "(id) disarm one the user wants back later.",
    resume: "(id) rearm a paused one.",
    delete: "(id) remove a finite watch as soon as it has done its job."
  },
  skill: {
    write: 'save or rewrite a reusable skill (name, description, body; id to rewrite). The description is REQUIRED and is what a reader uses to decide whether the skill applies, so write it as "use this when \u2026". A skill has no trigger \u2014 a saved task that runs on a schedule is a routine.',
    delete: "(id). Cursor-managed skills can't be edited or deleted."
  },
  profile: {
    set: "your name (the chat title the user sees in the sidebar and header), description, title (the short role label beside your name), avatar_shape, and/or avatar_color (your default mark, hidden while a custom picture is installed). Only the fields you pass change. For your picture use target avatar."
  },
  settings: {
    set: "hidden_from_sidebar, notify_on_updates. Only the fields you pass change."
  },
  channel: {
    disconnect: "(platform). The connector closes the live connection within a few seconds."
  },
  project: {
    create: "(project slug, name, optional description). Creates the folder + project.md and joins it; if the slug already exists this is create-is-join.",
    join: "(project slug).",
    leave: "(project slug)."
  },
  avatar: {
    set: "(path to an image on your box or the host \u2014 write/download it first, then install it here; a box path under /workspace is fine).",
    clear: "back to the default picture."
  }
};

function isKeyOf(table, key) {
  return typeof key === "string" && Object.hasOwn(table, key);
}

var TARGETS = nonEmptyTuple(
  Object.keys(OPERATIONS).filter(
    (target) => isKeyOf(OPERATIONS, target)
  )
);

function actionsOf(target) {
  const actions = OPERATIONS[target];
  return Object.keys(actions).filter(
    (action) => isKeyOf(actions, action)
  );
}

var ACTIONS = nonEmptyTuple([...new Set(TARGETS.flatMap(actionsOf))]);

var OPERATION_ENTRIES = TARGETS.map((target) => [target, OPERATIONS[target]]);

var ACTION_MATRIX = OPERATION_ENTRIES.map(
  ([target, actions]) => `${target}: ${Object.keys(actions).join(" | ")}`
).join(". ");

function normalizeSchedule(raw) {
  return raw.trim().replace(/\s+/g, " ");
}

var TEMPORAL_EVERY_PATTERN = /^@every\s+(\S+)$/i;

var TEMPORAL_DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;

var UNIT_MS = {
  ms: 1,
  s: 1e3,
  m: 6e4,
  h: 36e5,
  d: 864e5
};

function parseTemporalDurationMs(duration3, allowZero) {
  if (duration3 === "") return null;
  let totalMs = 0;
  let consumed = 0;
  TEMPORAL_DURATION_PART.lastIndex = 0;
  for (let part = TEMPORAL_DURATION_PART.exec(duration3); part != null; part = TEMPORAL_DURATION_PART.exec(duration3)) {
    const unitMs = UNIT_MS[part[2]?.toLowerCase() ?? ""];
    if (unitMs == null) return null;
    totalMs += Number(part[1]) * unitMs;
    consumed += part[0].length;
  }
  return consumed === duration3.length && (totalMs > 0 || allowZero) ? totalMs : null;
}

function parseEverySchedule(schedule) {
  const intervalAndPhase = TEMPORAL_EVERY_PATTERN.exec(schedule.trim())?.[1];
  if (intervalAndPhase == null) return null;
  const [interval, phase, extra] = intervalAndPhase.split("/");
  if (interval == null || extra != null) return null;
  const intervalMs = parseTemporalDurationMs(interval, false);
  if (intervalMs == null) return null;
  if (phase == null) return { intervalMs };
  const phaseMs = parseTemporalDurationMs(phase, true);
  return phaseMs == null || phaseMs >= intervalMs ? null : { intervalMs, phaseMs };
}

function parseEveryIntervalMs(schedule) {
  return parseEverySchedule(schedule)?.intervalMs ?? null;
}

var SCHEDULE_TZ_PREFIX = /^(?:CRON_TZ|TZ)=(\S+)\s+/;

function splitScheduleTimeZone(schedule) {
  const normalized = normalizeSchedule(schedule);
  const match2 = SCHEDULE_TZ_PREFIX.exec(normalized);
  return match2 == null ? { schedule: normalized, timeZone: void 0 } : { schedule: normalized.slice(match2[0].length), timeZone: match2[1] };
}

function parseCronField(field, min, max) {
  const values = /* @__PURE__ */ new Set();
  for (const part of field.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) return null;
    const rangePart = stepSplit[0] ?? "";
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    let rangeStart;
    let rangeEnd;
    if (rangePart === "*" || rangePart === "") {
      rangeStart = min;
      rangeEnd = max;
    } else if (rangePart.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-");
      rangeStart = Number(startRaw);
      rangeEnd = Number(endRaw);
    } else {
      rangeStart = Number(rangePart);
      rangeEnd = stepSplit.length === 2 ? max : rangeStart;
    }
    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) return null;
    if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) return null;
    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : null;
}

function parseCron(expression) {
  const fields2 = expression.split(" ");
  if (fields2.length !== 5) return null;
  const [minuteRaw = "", hourRaw = "", domRaw = "", monthRaw = "", dowRaw = ""] = fields2;
  const minute = parseCronField(minuteRaw, 0, 59);
  const hour = parseCronField(hourRaw, 0, 23);
  const dayOfMonth = parseCronField(domRaw, 1, 31);
  const month = parseCronField(monthRaw, 1, 12);
  const dayOfWeekRaw = parseCronField(dowRaw, 0, 7);
  if (minute == null || hour == null || dayOfMonth == null || month == null || dayOfWeekRaw == null) {
    return null;
  }
  const dayOfWeek = new Set([...dayOfWeekRaw].map((day) => day === 7 ? 0 : day));
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    isDayOfMonthRestricted: domRaw !== "*",
    isDayOfWeekRestricted: dowRaw !== "*"
  };
}

var CRON_ALIASES = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *"
};

function expandAlias(schedule) {
  const lower = schedule.toLowerCase();
  return CRON_ALIASES[lower] ?? schedule;
}

var zonedFormatterCache = /* @__PURE__ */ new Map();

function getZonedFormatter(timeZone) {
  const cached2 = zonedFormatterCache.get(timeZone);
  if (cached2 !== void 0) return cached2;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short"
    });
  } catch {
    formatter = null;
  }
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
}

function compileCronMatcher(schedule) {
  const { schedule: expression, timeZone } = splitScheduleTimeZone(schedule);
  const matcher = parseCron(expandAlias(expression));
  if (matcher == null || timeZone == null) return matcher;
  return getZonedFormatter(timeZone) == null ? null : { ...matcher, timeZone };
}

var MINUTE_MS = 6e4;

function cronDayMatches(matcher, wall) {
  if (!matcher.month.has(wall.month)) return false;
  const domOk = matcher.dayOfMonth.has(wall.dayOfMonth);
  const dowOk = matcher.dayOfWeek.has(wall.dayOfWeek);
  if (matcher.isDayOfMonthRestricted && matcher.isDayOfWeekRestricted) {
    return domOk || dowOk;
  }
  return (matcher.isDayOfMonthRestricted ? domOk : true) && (matcher.isDayOfWeekRestricted ? dowOk : true);
}

function cronIntervalIsAtLeast(matcher, minimumIntervalMs) {
  const timesOfDay = [...matcher.hour].flatMap((hour) => [...matcher.minute].map((minute) => hour * 60 + minute)).sort((a, b2) => a - b2);
  for (let index = 1; index < timesOfDay.length; index++) {
    const previous = timesOfDay[index - 1];
    const current = timesOfDay[index];
    if (previous != null && current != null && (current - previous) * MINUTE_MS < minimumIntervalMs) {
      return false;
    }
  }
  const first = timesOfDay[0];
  const last = timesOfDay[timesOfDay.length - 1];
  if (first == null || last == null || (24 * 60 - last + first) * MINUTE_MS >= minimumIntervalMs) {
    return true;
  }
  let previousDayMatches = false;
  for (let dayMs = Date.UTC(2e3, 0, 1); dayMs <= Date.UTC(2400, 0, 1); dayMs += 24 * 60 * MINUTE_MS) {
    const date6 = new Date(dayMs);
    const matches = cronDayMatches(matcher, {
      month: date6.getUTCMonth() + 1,
      dayOfMonth: date6.getUTCDate(),
      dayOfWeek: date6.getUTCDay()
    });
    if (matches && previousDayMatches) return false;
    previousDayMatches = matches;
  }
  return true;
}

function isValidSchedule(schedule, minimumIntervalMs) {
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  if (intervalMs != null) {
    return minimumIntervalMs === void 0 || intervalMs >= minimumIntervalMs;
  }
  const matcher = compileCronMatcher(normalized);
  return matcher != null && (minimumIntervalMs === void 0 || cronIntervalIsAtLeast(matcher, minimumIntervalMs));
}

var automationSchedule = external_exports.string().trim().min(1).refine(isValidSchedule, {
  message: "Schedule must be a valid cron expression or @every interval."
});

function recoverTriggerModelSentAsJsonEncodedString(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

var cronTriggerMember = external_exports.object({
  type: external_exports.literal("cron"),
  schedule: automationSchedule.describe(
    `A 5-field cron expression in the user's local time ("0 7 * * *"), or a shorthand (@hourly/@daily/@weekly/@monthly, "@every 30m"). Calendar shorthands take their clock fields from the routine's creation time, and unphased @every intervals anchor to creation. A clock time the user names is saved as named, so "8am" is "0 8 * * *" and "daily at 2" is "0 2 * * *"; only an ask that names no time takes the current minute off the <timestamp>, so asked at 1:32 "hourly" is "32 * * * *".`
  )
});

var slackListener2 = external_exports.object({
  type: external_exports.literal("slack"),
  channel: external_exports.string().trim().min(1).describe('A channel ("#eng"), a DM ("@dana"), or "*" for anywhere.'),
  match: external_exports.discriminatedUnion("kind", [
    external_exports.object({ kind: external_exports.literal("mention") }),
    external_exports.object({
      kind: external_exports.literal("keyword"),
      keyword: external_exports.string().trim().min(1)
    }),
    external_exports.object({ kind: external_exports.literal("message") }),
    external_exports.object({
      kind: external_exports.literal("reaction"),
      emoji: external_exports.array(external_exports.string().trim().min(1)).optional().describe(
        'Normalized short names without colons ("eyes", "white_check_mark"). Absent or empty means any emoji.'
      ),
      bySelf: external_exports.boolean().optional().describe("When true, only the user's own reactions fire it \u2014 not a colleague's.")
    })
  ]).describe("What makes a message count as a match.")
});

var GITHUB_EVENT_KINDS = [
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
  "ci-failed"
];

var githubListener2 = external_exports.object({
  type: external_exports.literal("github"),
  repo: external_exports.string().trim().min(1).describe('One concrete "owner/name" repo. No wildcards; omit pr for repo-wide events.'),
  events: external_exports.array(external_exports.enum(GITHUB_EVENT_KINDS)).min(1).describe(
    'Which GitHub events fire this routine. For a PR babysitter, use ["review-requested", "review-approved", "review-changes-requested", "review-commented", "pr-comment", "inline-review-comment", "review-thread-resolved", "review-thread-unresolved", "pr-pushed", "pr-merged", "pr-closed", "ci-passed", "ci-failed"].'
  ),
  pr: external_exports.number().int().positive().optional().describe(
    "Optional pull request number. When set, only events for that PR fire; a listener containing pr-merged or pr-closed deletes itself after that terminal wake finishes."
  ),
  userAllowlist: external_exports.array(external_exports.string().trim().min(1)).optional().describe(
    'Git usernames that may fire this listener ("alice", "@bob"). Absent or empty means anyone. Does not apply to ci-passed/ci-failed \u2014 CI is never user-gated.'
  ),
  ciBranch: external_exports.string().trim().min(1).optional().describe(
    'REQUIRED when repo-wide events includes ci-passed or ci-failed: the one branch whose settled checks fire them ("main"). Omit it when pr is set; that PR scopes CI instead.'
  )
});

var ORIGIN_EVENT_KINDS = [
  "pr-opened",
  "pr-pushed",
  "pr-merged",
  "review-requested",
  "review-approved",
  "review-changes-requested",
  "review-commented",
  "pr-comment",
  "inline-review-comment",
  "review-thread-resolved",
  "review-thread-unresolved",
  "ci-passed",
  "ci-failed"
];

var originListener2 = external_exports.object({
  type: external_exports.literal("origin"),
  repo: external_exports.string().trim().min(1).describe(
    'One concrete native Origin "owner/name" repo. Mirrored repos are rejected; no wildcards.'
  ),
  events: external_exports.array(external_exports.enum(ORIGIN_EVENT_KINDS)).min(1).describe(
    'Which Origin events fire this routine. For a PR babysitter, use ["review-requested", "review-approved", "review-changes-requested", "review-commented", "pr-comment", "inline-review-comment", "review-thread-resolved", "review-thread-unresolved", "pr-pushed", "pr-merged", "ci-passed", "ci-failed"].'
  ),
  pr: external_exports.number().int().positive().optional().describe(
    "Optional Origin pull request number. Required for ci-passed/ci-failed; a listener containing pr-merged deletes itself after that merged wake finishes."
  ),
  userAllowlist: external_exports.array(external_exports.string().trim().min(1)).optional().describe(
    "Origin actor IDs in either user-facing or internal numeric form. PR/comment events gate the PR owner; review/reviewer/thread events require both actor and PR owner; CI ignores this list. Missing required identities fail closed."
  )
});

var microsoftTeamsTrigger2 = external_exports.object({
  type: external_exports.literal("microsoftTeams"),
  tenantId: external_exports.string().trim().min(1).describe("The Microsoft Entra tenant ID."),
  teamId: external_exports.string().optional().describe(
    "One Microsoft Teams Graph API team ID. At least one of teamId or teamIds is required."
  ),
  teamIds: external_exports.array(external_exports.string()).optional().describe("Microsoft Teams Graph API team IDs. At least one of teamId or teamIds is required."),
  channelIds: external_exports.array(external_exports.string()).optional().describe(
    "Optional channel filter using Microsoft Teams Graph API channel IDs. Empty or absent means every channel."
  ),
  messageContains: external_exports.string().optional().describe("Optional message text filter. Empty or absent means any message."),
  messageContainsIsRegex: external_exports.boolean().optional().describe("Whether messageContains is a regular expression."),
  blockUnauthenticatedTeamsUsers: external_exports.boolean().optional().describe("When true, messages from unauthenticated Microsoft Teams users do not fire it.")
});

var linearTrigger2 = external_exports.object({
  type: external_exports.literal("linear"),
  event: external_exports.discriminatedUnion("case", [
    external_exports.object({
      case: external_exports.literal("issueCreated").describe("Fire when a Linear issue is created.")
    }),
    external_exports.object({
      case: external_exports.literal("statusChanged").describe("Fire when a Linear issue changes status."),
      statusIds: external_exports.array(external_exports.string()).optional().describe(
        "Optional narrowing filter using Linear status UUIDs. Empty or absent means any status."
      )
    }),
    external_exports.object({
      case: external_exports.literal("endOfCycle").describe("Fire when a Linear cycle ends."),
      cycleIds: external_exports.array(external_exports.string()).optional().describe(
        "Optional narrowing filter using Linear cycle UUIDs. Empty or absent means any cycle."
      )
    })
  ]).describe("Which Linear event fires this routine."),
  projectIds: external_exports.array(external_exports.string()).optional().describe(
    "Optional narrowing filter using Linear project UUIDs. Empty or absent means any project."
  ),
  teamIds: external_exports.array(external_exports.string()).optional().describe("Optional narrowing filter using Linear team UUIDs. Empty or absent means any team.")
});

var SENTRY_EVENT_CASES = [
  "issueCreated",
  "issueResolved",
  "issueAssigned",
  "issueArchived",
  "issueUnresolved",
  "issueAny"
];

var sentryTrigger2 = external_exports.object({
  type: external_exports.literal("sentry"),
  event: external_exports.object({
    case: external_exports.enum(SENTRY_EVENT_CASES).describe("Which Sentry issue event fires the routine.")
  }).describe("The Sentry event to watch."),
  projectIds: external_exports.array(external_exports.string()).optional().describe("Optional project ID filter. Empty or absent means any Sentry project.")
});

var PAGERDUTY_EVENT_CASES = [
  "incidentTriggered",
  "incidentAcknowledged",
  "incidentResolved",
  "incidentEscalated",
  "incidentAny"
];

var pagerdutyTrigger = external_exports.object({
  type: external_exports.literal("pagerduty"),
  event: external_exports.object({
    case: external_exports.enum(PAGERDUTY_EVENT_CASES).describe("Which PagerDuty incident event fires the routine.")
  }).describe("The PagerDuty event to watch."),
  serviceIds: external_exports.array(external_exports.string()).optional().describe("Optional service ID filter. Empty or absent means any PagerDuty service.")
});

var webhookTrigger2 = external_exports.object({
  type: external_exports.literal("webhook")
});

var triggerMember = external_exports.discriminatedUnion("type", [
  cronTriggerMember,
  slackListener2,
  githubListener2,
  originListener2,
  microsoftTeamsTrigger2,
  linearTrigger2,
  sentryTrigger2,
  pagerdutyTrigger,
  webhookTrigger2
]);

var automationTriggerShape = external_exports.union([
  external_exports.discriminatedUnion("type", [
    cronTriggerMember,
    slackListener2,
    githubListener2,
    originListener2,
    microsoftTeamsTrigger2,
    linearTrigger2,
    sentryTrigger2,
    pagerdutyTrigger,
    webhookTrigger2,
    external_exports.object({
      type: external_exports.literal("group"),
      listeners: external_exports.array(triggerMember).min(1).describe(
        "Any one of these fires the same prompt. Origin may mix with cron, Slack, or GitHub, but not with server-only listener types."
      )
    })
  ]),
  external_exports.array(triggerMember).min(1).describe("Bare-array shorthand for the group form: any one member fires the prompt.")
]).superRefine((value, ctx) => {
  let members;
  if (Array.isArray(value)) members = value;
  else if (value.type === "group") members = value.listeners;
  else members = [value];
  for (const member of members) {
    if (member.type === "origin" && member.pr === void 0 && member.events.some((event) => event === "ci-passed" || event === "ci-failed")) {
      ctx.addIssue({
        code: "custom",
        message: "Origin CI listeners require one explicit PR number."
      });
    }
  }
  if (!members.some((member) => member.type === "origin")) return;
  const incompatible = members.find(
    (member) => ["microsoftTeams", "linear", "sentry", "pagerduty", "webhook"].includes(member.type)
  );
  if (incompatible === void 0) return;
  ctx.addIssue({
    code: "custom",
    message: `Origin can't be grouped with ${incompatible.type} until both have one scheduling authority.`
  });
}).describe(
  "What fires the routine. Prefer an event listener (Slack, GitHub, Origin, Microsoft Teams, Linear, Sentry, PagerDuty) over polling on a cron when the event you care about is one of the listed shapes; never pass both this and the schedule argument."
);

var automationTrigger2 = external_exports.preprocess(
  recoverTriggerModelSentAsJsonEncodedString,
  automationTriggerShape
);

var GROK_BOT_MARK_SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf"
];

var GROK_BOT_COLORS = [
  { id: "black", label: "Black", value: "#000" },
  { id: "brown", label: "Brown", value: "#936439" },
  { id: "red", label: "Red", value: "#FF263C" },
  { id: "orange", label: "Orange", value: "#FF6700" },
  { id: "yellow", label: "Yellow", value: "#FF9800" },
  { id: "green", label: "Green", value: "#00C972" },
  { id: "cyan", label: "Cyan", value: "#00BCA6" },
  { id: "blue", label: "Blue", value: "#1084FE" },
  { id: "violet", label: "Violet", value: "#9159FE" },
  { id: "magenta", label: "Magenta", value: "#FF309B" },
  { id: "gray", label: "Gray", value: "#777777" }
];

var GROK_BOT_MARK_COLORS = GROK_BOT_COLORS.map(({ id }) => id);

var sandUpdateStateParameters = external_exports.object({
  target: external_exports.preprocess(
    (value) => value === "workflow" ? "skill" : value,
    external_exports.enum(TARGETS).describe("Which part of your own state to change.")
  ),
  action: external_exports.enum(ACTIONS).describe(`What to do. ${ACTION_MATRIX}.`),
  fact: external_exports.string().trim().min(1).optional().describe(
    "memory only. The fact, one self-contained sentence. For forget, the EXACT text of the recorded fact (find it with RecallMemory first, or read the memory folder when it is on your computer)."
  ),
  tier: external_exports.enum(["profile", "log", "note"]).optional().describe("memory write only. Defaults to log. Keep profile small."),
  scope: external_exports.enum(["agent", "user", "project"]).optional().describe("memory only. Defaults to agent (your own memory)."),
  project: external_exports.string().trim().min(1).optional().describe(
    'Project slug. Required for memory when scope is "project", and for every project action.'
  ),
  id: external_exports.string().trim().min(1).optional().describe(
    "The routine's folder or the skill's id. Required for every routine action except create, and for skill delete. Omit on a skill write to create a new one."
  ),
  name: external_exports.string().trim().min(1).optional().describe(
    "routine/skill/project create: its name. Required on create and on a skill write; on routine update, omit to keep the current name. profile: your new name, which is the chat title the user sees."
  ),
  prompt: external_exports.string().trim().min(1).optional().describe(
    "routine only. What you should do each time it fires, written to your future self. Write it as an INTENT, not a frozen tool recipe: a connector's schema can change between fires, so describe the goal and let each run look the tool up. Required on create; on update, omit to keep the current prompt."
  ),
  schedule: automationSchedule.optional().describe(
    `routine only. Shorthand for a cron trigger \u2014 "0 7 * * *", "@daily", "@every 2h" \u2014 interpreted in the user's local time. Calendar shorthands take their clock fields from the routine's creation time, and unphased @every intervals anchor to creation. A clock time the user names is saved as named, so "8am" is "0 8 * * *" and "daily at 2" is "0 2 * * *"; only an ask that names no time takes the current minute off the <timestamp>, so asked at 1:32 "hourly" is "32 * * * *". Use this OR trigger, never both. On update, omit (with trigger) to keep the current fire condition.`
  ),
  trigger: automationTrigger2.optional(),
  enabled: external_exports.boolean().optional().describe(
    "routine create/update only. On create, defaults to true. On update, omit to leave the current arming alone (use pause/resume to toggle)."
  ),
  description: external_exports.string().trim().optional().describe(
    "skill write: REQUIRED. One line on when to use the skill. profile: your new description. project create: optional summary."
  ),
  body: external_exports.string().trim().min(1).optional().describe("skill write only. The recipe, in markdown."),
  title: external_exports.string().trim().optional().describe(
    'profile set only. The short role label shown as a chip beside your name ("Designer"), not the chat title \u2014 that is your name. Pass "" to clear it.'
  ),
  avatar_shape: external_exports.enum(nonEmptyTuple(GROK_BOT_MARK_SHAPES)).optional().describe(
    "profile set only. The shape of your default mark in the sidebar. Not visible while a custom picture is installed."
  ),
  avatar_color: external_exports.enum(nonEmptyTuple(GROK_BOT_MARK_COLORS)).optional().describe(
    "profile set only. The color of your default mark in the sidebar. Not visible while a custom picture is installed."
  ),
  hidden_from_sidebar: external_exports.boolean().optional().describe(
    "settings set only. Removes your row from the user's sidebar; you stay fully functional and reachable through Cmd-K and the Hidden chats manager."
  ),
  notify_on_updates: external_exports.boolean().optional().describe('settings set only. The "Notify me about this assistant" toggle.'),
  platform: external_exports.string().trim().min(1).optional().describe("channel disconnect only. The platform to disconnect."),
  path: external_exports.string().trim().min(1).optional().describe(
    "avatar set only. Absolute path to an image you already have (write or download it first, with Shell on your own computer or Shell using the user's computer's machineId, then install it here). A path on your box under /workspace is fine \u2014 no CopyFromBox needed. png/jpg/webp/gif/svg under 5 MB."
  )
});

var COMPUTER_ACTIONS = [
  "screenshot",
  "click",
  "move",
  "drag",
  "type",
  "key",
  "scroll",
  "wait"
];

function boxPixelSchema() {
  return external_exports.number().int().refine((value) => value >= 0, {
    message: "Pixel coordinates are non-negative in the box display space (origin top-left)."
  });
}

var HELD_MODIFIER_KEYS = ["ctrl", "alt", "shift", "meta", "super"];

var HELD_MODIFIER_KEY_SET = new Set(HELD_MODIFIER_KEYS);

function heldModifiersSchema() {
  return external_exports.string().refine(
    (value) => value.split("+").every((part) => HELD_MODIFIER_KEY_SET.has(part.toLowerCase())),
    { message: `Modifiers must be +-joined from: ${HELD_MODIFIER_KEYS.join(", ")}.` }
  ).transform((value) => value.toLowerCase());
}

function scrollAmountSchema() {
  return external_exports.number().int().refine((value) => value >= 1, { message: "Scroll amount is at least 1 click." });
}

var SAND_COMPUTER_MAX_WAIT_MS = 3e4;

var SAND_COMPUTER_MAX_HOLD_MS = SAND_COMPUTER_MAX_WAIT_MS;

function buildComputerActionCoreSchema(actions = COMPUTER_ACTIONS, options2) {
  const describeFields = options2?.describeFields ?? true;
  const withFieldDescription = (schema2, description3) => describeFields ? schema2.describe(description3) : schema2;
  return external_exports.object({
    action: withFieldDescription(
      external_exports.enum(actions),
      "What to do on the box desktop. Every call captures a fresh screenshot of the resulting screen once all of its actions have run."
    ),
    x: withFieldDescription(
      boxPixelSchema().optional(),
      "X pixel in the box display space (origin top-left) for click/move/scroll, or the start point for drag (omit to act at the cursor for click/move/scroll)."
    ),
    y: withFieldDescription(
      boxPixelSchema().optional(),
      "Y pixel in the box display space (origin top-left) for click/move/scroll, or the start point for drag (omit to act at the cursor for click/move/scroll)."
    ),
    x2: withFieldDescription(
      boxPixelSchema().optional(),
      "X pixel for the drag end point. Required with y2 when path is omitted."
    ),
    y2: withFieldDescription(
      boxPixelSchema().optional(),
      "Y pixel for the drag end point. Required with x2 when path is omitted."
    ),
    path: withFieldDescription(
      external_exports.array(
        external_exports.object({
          x: withFieldDescription(boxPixelSchema(), "X pixel for this drag path point."),
          y: withFieldDescription(boxPixelSchema(), "Y pixel for this drag path point.")
        })
      ).optional(),
      "Optional ordered drag path. A path with at least two {x, y} points is used verbatim instead of x/y/x2/y2."
    ),
    text: withFieldDescription(external_exports.string().optional(), "Text to type. Required for type."),
    key: withFieldDescription(
      external_exports.string().optional(),
      "Key or chord in xdotool form, e.g. Return, ctrl+a, Alt+Left. Required for key. A shortcut meant to open a palette or search may not register \u2014 check the returned screenshot that it opened and holds focus before typing a query into it."
    ),
    button: withFieldDescription(
      external_exports.enum(["left", "right", "middle"]).optional(),
      "Mouse button for click or drag (default left)."
    ),
    count: withFieldDescription(
      external_exports.number().int().min(1).max(3).optional(),
      "Click count for click: 1 single, 2 double, 3 triple."
    ),
    modifiers: withFieldDescription(
      heldModifiersSchema().optional(),
      "Modifier keys held for the whole click, drag, or scroll, e.g. shift, ctrl, meta, ctrl+shift. Use for Shift-click range select and Ctrl/Cmd-click multi-select."
    ),
    direction: withFieldDescription(
      external_exports.enum(["up", "down", "left", "right"]).optional(),
      "Scroll direction. Required for scroll."
    ),
    amount: withFieldDescription(
      scrollAmountSchema().optional(),
      "Scroll amount in clicks (default 3)."
    ),
    durationMs: withFieldDescription(
      external_exports.number().int().min(0).max(SAND_COMPUTER_MAX_WAIT_MS).optional(),
      `Milliseconds to wait. Required for wait. Max ${SAND_COMPUTER_MAX_WAIT_MS}. A settle delay before the screenshot is automatic, so do not add a wait just to let the screen settle.`
    ),
    holdDurationMs: withFieldDescription(
      external_exports.number().int().min(1).max(SAND_COMPUTER_MAX_HOLD_MS).optional(),
      `Milliseconds to keep the mouse button pressed before releasing it. Only valid for click. Use for press-and-hold "I'm human" widgets, holding until the widget completes; when it asks you to try again, hold longer. Max ${SAND_COMPUTER_MAX_HOLD_MS}. Cannot be combined with count > 1 or modifiers.`
    )
  });
}

function isAutoReviewEnforcing(autoReview) {
  return autoReview?.mode === "enforce";
}

function toEnumValues(actions) {
  const [first, ...rest] = actions;
  invariant(first !== void 0, "A Computer action enum needs at least one action.");
  return [first, ...rest];
}

var FOLLOW_UP_ACTIONS = toEnumValues(
  COMPUTER_ACTIONS.filter((action) => action !== "screenshot")
);

var SAND_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS = [
  "screenshot",
  "move",
  "wait",
  "scroll"
];

var BYPASS_COMPUTER_ACTIONS = new Set(
  SAND_COMPUTER_AUTO_REVIEW_BYPASS_ACTIONS
);

function isSandComputerAutoReviewBypassAction(action) {
  return BYPASS_COMPUTER_ACTIONS.has(action);
}

var REVIEWABLE_FOLLOW_UP_ACTIONS = toEnumValues(
  FOLLOW_UP_ACTIONS.filter(isSandComputerAutoReviewBypassAction)
);

function refineDragCoordinates(args, ctx) {
  if (args.action !== "drag") return;
  if (args.path !== void 0 && args.path.length >= 2) return;
  if (args.x === void 0 || args.y === void 0 || args.x2 === void 0 || args.y2 === void 0) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Drag requires x, y, x2, and y2 or a path with at least 2 points."
    });
  }
}

function refineHoldClick(args, ctx) {
  if (args.holdDurationMs === void 0) return;
  if (args.action !== "click") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "holdDurationMs is only valid for click.",
      path: ["holdDurationMs"]
    });
    return;
  }
  if ((args.count ?? 1) > 1) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "holdDurationMs cannot be combined with a multi-click count.",
      path: ["holdDurationMs"]
    });
  }
  if (args.modifiers !== void 0) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "holdDurationMs cannot be combined with modifiers.",
      path: ["holdDurationMs"]
    });
  }
}

var SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS = 9;

var COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS = 2e3;

function buildFollowUpParameter(autoReview) {
  const allowed = isAutoReviewEnforcing(autoReview) ? REVIEWABLE_FOLLOW_UP_ACTIONS : FOLLOW_UP_ACTIONS;
  const item = buildComputerActionCoreSchema(allowed, {
    describeFields: false
  }).superRefine((args, ctx) => {
    refineDragCoordinates(args, ctx);
    refineHoldClick(args, ctx);
  });
  return external_exports.array(item).min(1).max(SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS).optional().describe(
    `Up to ${SAND_COMPUTER_MAX_FOLLOW_UP_ACTIONS} more actions to run in this same call, in order, right after the primary action. Each entry takes the same fields as the primary action. The whole sequence shares one ${COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS}ms settle and returns one screenshot of the final screen, so batching is several times faster than a call per action. Batch only steps you already know without seeing the screen between them; when a step depends on what the previous one rendered, make separate calls. Allowed here: ${allowed.join(", ")}.`
  );
}

var sandComputerDeclaredPurposeParameter = external_exports.string().optional().describe(
  "Concise model-facing intent for this action. Required for click and drag in Auto-review enforce mode; include for type/key when it clarifies purpose."
);

function buildComputerParameters(autoReview) {
  const shape = {
    ...buildComputerActionCoreSchema().shape,
    then: buildFollowUpParameter(autoReview),
    description: sandComputerDeclaredPurposeParameter
  };
  return external_exports.object(shape).superRefine((args, ctx) => {
    refineDragCoordinates(args, ctx);
    refineHoldClick(args, ctx);
    if (autoReview?.mode !== "enforce") return;
    if (args.action !== "click" && args.action !== "drag") return;
    const description3 = args.description?.trim();
    if (description3 !== void 0 && description3.length > 0) return;
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "Click and drag require description: a concise statement of the intended UI target and purpose.",
      path: ["description"]
    });
  }).describe(
    "A computer-use action against the box desktop, optionally followed by more actions in the same call."
  );
}

var computerActionParameters = buildComputerParameters();

var SEND_MESSAGE_TYPES = [
  "text",
  "attachment",
  "widget",

  "secret-request"
];

var SEND_MESSAGE_TYPES_WITH_CREDENTIAL_REQUEST = [
  ...SEND_MESSAGE_TYPES,
  "credential-request"
];

var SEND_MESSAGE_TYPE_DESCRIPTION = "text for chat messages, attachment for actual files or standalone media, widget for an interactive question with selectable options, cursor-agent to reference a Cursor cloud agent by its bcId (renders as a card that opens the agent in Cursor on click), secret-request to ask the user for a credential through a secure masked input (never a chat paste).";

var SEND_MESSAGE_TYPE_DESCRIPTION_WITH_CREDENTIAL_REQUEST = `${SEND_MESSAGE_TYPE_DESCRIPTION.slice(0, -1)}, credential-request to ask the user to approve one-time browser fill of a saved login.`;

var SEND_MESSAGE_DM_DESTINATION = "dm";

var SEND_MESSAGE_DM_DESCRIPTION = `Optional, only meaningful during a local group-chat turn. Pass "dm" to deliver this message privately to YOUR OWN user's 1:1 chat instead of the room; the room never sees it. Only valid with type:text. Outside a group-chat turn it is ignored because your user is already the audience.`;

var SAND_WIDGET_ACTION_STYLES = ["default", "primary", "danger"];

var widgetActionStyleSchema = external_exports.enum(SAND_WIDGET_ACTION_STYLES);

var choiceOptionSchema = external_exports.object({
  label: external_exports.string().trim().min(1),
  value: external_exports.string().trim().min(1).optional().describe(
    "Text sent back to you when this option is picked. Defaults to the label. Make it read like something the user would naturally say in reply."
  ),
  description: external_exports.string().trim().min(1).optional(),
  style: widgetActionStyleSchema.optional()
});

var sandWidgetSchema = external_exports.object({
  prompt: external_exports.string().trim().min(1),
  helpText: external_exports.string().trim().min(1).optional(),
  options: external_exports.array(choiceOptionSchema).min(1).max(6),
  multiSelect: external_exports.boolean().optional().describe(
    "When true, several options may apply. The user toggles any subset, then submits once. Picked values return in one reply, one per line."
  ),
  allowCustom: external_exports.boolean().optional().describe(
    "When true, the user can type a custom free-text answer instead of choosing one of the options."
  ),
  dismissOnMoveOn: external_exports.boolean().optional().describe(
    "When true, this widget auto-dismisses (becomes inert, shows a muted Dismissed state) once the user sends a newer message without answering it. Omit/false to keep the question live and answerable indefinitely. Set true only for low-stakes questions that become moot if the user moves on; keep it off for real decisions you still need answered."
  )
});

var ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

var RESERVED_EXACT_NAMES = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "DISPLAY",
  CLOUD_AGENT_INJECTED_SECRET_NAMES_ENV_VAR
]);

var RESERVED_NAME_PREFIXES = ["SAND_", "__CURSOR", "LD_"];

var CURSOR_SANDBOX_NAME_PATTERN = /CURSOR_SANDBOX/i;

function validateBoxSecretKey(key) {
  if (!ENV_NAME_PATTERN.test(key)) {
    return `"${key}" is not a valid environment variable name`;
  }
  if (RESERVED_EXACT_NAMES.has(key)) {
    return `${key} is reserved by the box runtime`;
  }
  for (const prefix of RESERVED_NAME_PREFIXES) {
    if (key.startsWith(prefix)) {
      return `Names starting with ${prefix} are reserved by the box runtime`;
    }
  }
  if (CURSOR_SANDBOX_NAME_PATTERN.test(key)) {
    return `${key} is reserved by the box runtime`;
  }
  return null;
}

var sendMessageObjectSchemaWithCredentialRequest = external_exports.object({
  type: external_exports.enum(SEND_MESSAGE_TYPES_WITH_CREDENTIAL_REQUEST).describe(SEND_MESSAGE_TYPE_DESCRIPTION_WITH_CREDENTIAL_REQUEST),
  content: external_exports.string().trim().optional().describe(
    "Required when type is text. The message to show to the user. Use actual newline characters for paragraph or list breaks, not literal backslash-n text."
  ),
  url: external_exports.string().trim().optional().describe(
    "Required when type is attachment. Use file:// for local files or https:// for remote files and standalone media."
  ),
  images: external_exports.array(
    external_exports.object({
      url: external_exports.string().trim().min(1).describe("file:// or https:// URL of the image."),
      alt: external_exports.string().trim().optional().describe(
        "Optional short description of this image, shown on hover and as its fullscreen caption."
      )
    })
  ).optional().describe(
    "Optional, only for type:text. Image(s) that belong with this message; they render inside the same chat bubble, below your text \u2014 one image full width, several as a compact gallery. Use whenever you're showing something you're talking about; use type:attachment only for an image that IS the whole message."
  ),
  alt: external_exports.string().trim().optional().describe(
    "Optional. A short description (alt text) of the image for type:attachment \u2014 what the image shows. Shown to the user on hover and in the fullscreen viewer."
  ),
  reply_to: external_exports.string().trim().optional().describe(
    "Optional. Address of a prior message to reply under (for example, t3u or t3s1). If the current user message was sent through Reply, omit this to reply under the same message automatically. Otherwise, omitting it posts normally in the main chat. Set it only to choose a different prior message."
  ),
  channel: external_exports.string().trim().optional().describe(
    "Optional. A connected messaging channel address to deliver this to instead of the in-app Grok Bot chat, shaped platform:chat, the address shown to you in an [inbound] wake. Omit to send to the in-app chat (the default). Only valid with type:text or type:attachment."
  ),
  to: external_exports.enum([SEND_MESSAGE_DM_DESTINATION]).optional().describe(SEND_MESSAGE_DM_DESCRIPTION),
  widget: sandWidgetSchema.optional().describe(
    "Required when type is widget. A question with selectable options: { prompt, helpText?, options: [{ label, value?, description?, style? }], multiSelect?, allowCustom?, dismissOnMoveOn? }. The user picks one option; its value comes back as their reply, and the chat shows the resolved card with their selection checked under your prompt \u2014 so phrase the prompt as a natural question, not a menu instruction. Set multiSelect: true when several options may apply. The user toggles any subset and submits once, and the picked values return together in one reply, one per line. The user can also dismiss the question without answering; you'll be told on your next turn, so treat that as a decline and don't re-ask. Set allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on (it auto-dismisses once they send a newer message without answering); leave it off for real decisions you still need answered."
  ),
  bcId: external_exports.string().trim().optional().describe(
    "Required when type is cursor-agent. The bcId of the Cursor cloud agent to reference (e.g. bc-xxxxxxxx-...)."
  ),
  secret: external_exports.object({
    label: external_exports.string().trim().min(1).describe(
      'What credential to ask for, shown as the card title and echoed in the field placeholder ("Paste your \u2026"), e.g. "Slack bot token".'
    ),
    description: external_exports.string().trim().optional().describe("Optional short help shown under the label."),
    name: external_exports.string().trim().min(1).refine((name17) => validateBoxSecretKey(name17) == null, {
      message: "Must be an allowed environment variable name."
    }).describe(
      'The environment variable name new box processes will read, e.g. "CURSOR_API_KEY".'
    )
  }).optional().describe(
    "Required when type is secret-request. Asks for a credential through a masked secure input. The value never reaches you or the chat. You only learn that it was provided. Where it is saved, and whether this turn may ask, is in the tool description. Do not ask anyone to paste a token, key, or password."
  ),
  credential: external_exports.object({
    kind: external_exports.literal("browser-login"),
    credential_id: external_exports.string().trim().min(1),
    connection_id: external_exports.string().trim().min(1),
    catalog_revision: external_exports.string().trim().min(1),
    site: external_exports.string().trim().min(1).describe(
      "The current browser URL or domain reported by computerUse. This is a target hint, not a saved item URL."
    ),
    purpose: external_exports.string().trim().min(1).describe("One honest sentence describing the immediate use, shown on the approval card.")
  }).strict().optional().describe(
    "Required when type is credential-request. Requests one-time approval to fill a saved login into a matching live browser page; values never reach you."
  )
});

var TYPE_SCOPED_SEND_MESSAGE_FIELDS = [
  { field: "content", types: ["text"] },
  { field: "url", types: ["attachment"] },
  { field: "alt", types: ["attachment"] },
  { field: "widget", types: ["widget"] },
  { field: "bcId", types: ["cursor-agent"] },
  { field: "secret", types: ["secret-request"] },
  { field: "credential", types: ["credential-request"] }
];

function isFieldProvided(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

var SEND_MESSAGE_DM_TEXT_ONLY_ERROR = 'to:"dm" can only be set for type:text';

var SEND_MESSAGE_DM_CHANNEL_CONFLICT_ERROR = 'to:"dm" and channel are mutually exclusive; pick one destination';

function isValidAttachmentUrl(rawUrl) {
  try {
    const url2 = new URL(rawUrl);
    return url2.protocol === "file:" || url2.protocol === "https:";
  } catch {
    return false;
  }
}

function refineSendMessage(value, ctx) {
  for (const { field, types: types3 } of TYPE_SCOPED_SEND_MESSAGE_FIELDS) {
    if (types3.includes(value.type)) continue;
    if (!isFieldProvided(value[field])) continue;
    const allowed = types3.map((type2) => `type:${type2}`).join(" or ");
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: [field],
      message: `${field} is only valid with ${allowed} and cannot ride a type:${value.type} message \u2014 it would be silently dropped. Nothing was sent. Re-send as separate SendToUser calls, one per type: this field on its own properly-typed message (${allowed}), and any text as its own type:text message.`
    });
  }
  if (value.channel != null && value.channel.length > 0 && value.type !== "text" && value.type !== "attachment") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["channel"],
      message: "channel can only be set for type:text or type:attachment, not widgets or cursor-agent cards"
    });
  }
  if (value.to != null && value.type !== "text") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["to"],
      message: SEND_MESSAGE_DM_TEXT_ONLY_ERROR
    });
  }
  if (value.to != null && value.channel != null && value.channel.length > 0) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["to"],
      message: SEND_MESSAGE_DM_CHANNEL_CONFLICT_ERROR
    });
  }
  if (value.images != null && value.images.length > 0 && value.type !== "text") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["images"],
      message: "images can only be set for type:text (they attach to a text message); for a standalone attachment use type:attachment with url"
    });
  }
  switch (value.type) {
    case "text": {
      if (!value.content) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["content"],
          message: "content is required when type is text"
        });
      }
      for (const [index, image2] of (value.images ?? []).entries()) {
        if (!isValidAttachmentUrl(image2.url)) {
          ctx.addIssue({
            code: external_exports.ZodIssueCode.custom,
            path: ["images", index, "url"],
            message: "each images url must include a file:// or https:// scheme"
          });
        }
      }
      return;
    }
    case "widget": {
      if (value.widget == null) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["widget"],
          message: "widget is required when type is widget"
        });
      }
      return;
    }
    case "cursor-agent": {
      if (!value.bcId) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["bcId"],
          message: "bcId is required when type is cursor-agent"
        });
      }
      return;
    }
    case "secret-request": {
      if (value.secret == null) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["secret"],
          message: "secret is required when type is secret-request"
        });
      }
      return;
    }
    case "credential-request": {
      if (value.credential == null) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["credential"],
          message: "credential is required when type is credential-request"
        });
      }
      return;
    }
    case "attachment": {
      const attachmentUrl = value.url;
      if (!attachmentUrl) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["url"],
          message: "url is required when type is attachment"
        });
        return;
      }
      if (!isValidAttachmentUrl(attachmentUrl)) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          path: ["url"],
          message: "url must include a file:// or https:// scheme when type is attachment"
        });
      }
      return;
    }
    default: {
      const _exhaustive = value.type;
      return _exhaustive;
    }
  }
}

var sendMessageParametersWithCredentialRequest = sendMessageObjectSchemaWithCredentialRequest.superRefine(refineSendMessage);

var reactToMessageParameters = external_exports.object({
  message_address: external_exports.string().trim().min(1).describe(
    "The address of the USER message to react to \u2014 the [t3u]-style tag shown on their message. Only the user's own messages, never your own sends."
  ),
  emoji: external_exports.string().trim().min(1).max(16).describe("A single common emoji to react with, e.g. \u{1F44D}, \u2764\uFE0F, \u{1F602}, \u{1F389}.")
});

var SAND_AUTO_REVIEW_COMMAND_MAX_CHARS = 4e3;

var sendFeedbackParameters = external_exports.object({
  message: external_exports.string().trim().min(1).max(SAND_AUTO_REVIEW_COMMAND_MAX_CHARS).describe("The user's feedback, in their own words."),
  wantsResponse: external_exports.boolean().describe(
    "Whether the user wants a human reply from the SpaceXAI team. Same choice as the Send Feedback form checkbox 'I would like a response from the support team on this feedback'. Ask first unless they already said. true if they want a reply; false if they do not. Never omit this and never guess."
  )
});

var requestBoxHelpParameters = external_exports.object({
  instruction: external_exports.string().trim().min(1).describe(
    'A short instruction shown over the box and in chat, addressed to the user (e.g. "Sign in to your Google account", "Approve the 2FA prompt"). Keep it to one line; no explanatory paragraph.'
  ),
  reason: external_exports.enum(["auth", "captcha", "payment", "other"]).optional().catch(void 0).describe(
    'Why the user is needed: "auth" for any sign-in step (login, SSO, passkey, 2FA), "captcha" for a puzzle or image captcha (a press-and-hold button is a mouse hold the subagent does itself), "payment", or "other".'
  ),
  domain: external_exports.string().trim().optional().catch(void 0).describe(
    'Destination app/site the user is trying to access (e.g. "salesforce.com", "google.com"). On a normal login page this is the browser-bar host. On an SSO/IdP page (Okta, Google accounts, Azure AD, \u2026) this is the *destination* app that started SSO \u2014 NOT the IdP host (put that in idp_domain). Omit when unknown or the step is not on a website.'
  ),
  idp_domain: external_exports.string().trim().optional().catch(void 0).describe(
    'When the browser is on an SSO/IdP page, the IdP host from the URL bar (e.g. "anysphere.okta.com", "accounts.google.com", "login.microsoftonline.com"). Omit on a direct app login with no separate IdP.'
  )
});

var DRAFT_PLATFORMS = ["email", "slack"];

var draftExternalMessageObjectSchema = external_exports.object({
  platform: external_exports.enum(DRAFT_PLATFORMS).describe(
    "Which platform this draft is for. email requires providerIdentifier, from, to, subject, and body (plus replyToMessageId when replying within an existing email thread). slack requires providerIdentifier, target, channelId, and body (plus threadTs when replying in a thread)."
  ),
  providerIdentifier: external_exports.string().trim().min(1).describe(
    "The installed MCP server identifier that will carry the send, exactly as GetMcpServerStatus lists it for the account you mean. This picks both the connector and the account, and the user cannot change it on the card, so resolve it first."
  ),
  body: external_exports.string().trim().min(1).describe("The message body, written in the user's voice. Required for both platforms."),
  from: external_exports.string().trim().optional().describe(
    `Required when platform is email. The exact email address the chosen account sends from, shown on the card's From row \u2014 a plain address like ariel@acme.com, never a display name and never guessed. If you don't already know it, read it from the mailbox first: call the Gmail connector's search_threads with query "in:sent" and use a returned message's sender field.`
  ),
  to: external_exports.array(external_exports.string().trim().min(1)).optional().describe(
    'Required when platform is email. The recipient(s), each a plain email address ("user@example.com" \u2014 the "Name <user@example.com>" form is not accepted).'
  ),
  cc: external_exports.array(external_exports.string().trim().min(1)).optional().describe("Optional, email only. Cc recipient(s), each a plain email address."),
  subject: external_exports.string().trim().optional().describe("Required when platform is email. The subject line."),
  replyToMessageId: external_exports.string().trim().optional().describe(
    "Optional, email only. The provider's id of the message being replied to; this is the ONLY reply key the send uses, so set it whenever the draft replies within an existing thread and omit it for a fresh email."
  ),
  target: external_exports.string().trim().optional().describe(
    'Required when platform is slack. Where the message goes, as the user reads it: a channel ("#general") or a person ("Ariel Chen").'
  ),
  channelId: external_exports.string().trim().optional().describe(
    "Required when platform is slack. The channel or DM conversation id the send is addressed to (e.g. C0123456789), resolved with the connector's search tools \u2014 never guessed."
  ),
  threadTs: external_exports.string().trim().optional().describe(
    "Optional, slack only. The parent message's ts when this draft replies in a thread; omit for a new message."
  )
});

var PLATFORM_SCOPED_DRAFT_FIELDS = [
  { field: "from", platform: "email" },
  { field: "to", platform: "email" },
  { field: "cc", platform: "email" },
  { field: "subject", platform: "email" },
  { field: "replyToMessageId", platform: "email" },
  { field: "target", platform: "slack" },
  { field: "channelId", platform: "slack" },
  { field: "threadTs", platform: "slack" }
];

function isFieldProvided2(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function requireField(ctx, field, platform2) {
  ctx.addIssue({
    code: external_exports.ZodIssueCode.custom,
    path: [field],
    message: `${field} is required when platform is ${platform2}`
  });
}

function isPlainEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requireAddresses(ctx, field, values) {
  const invalid = values.filter((value) => !isPlainEmailAddress(value));
  if (invalid.length === 0) return;
  ctx.addIssue({
    code: external_exports.ZodIssueCode.custom,
    path: [field],
    message: `${field} must carry plain email address(es) like user@example.com \u2014 not a display name or "Name <addr>" form. Got: ${invalid.join(", ")}`
  });
}

function refineDraftExternalMessage(value, ctx) {
  for (const { field, platform: platform2 } of PLATFORM_SCOPED_DRAFT_FIELDS) {
    if (platform2 === value.platform) continue;
    if (!isFieldProvided2(value[field])) continue;
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: [field],
      message: `${field} is only valid with platform:${platform2} and cannot ride a platform:${value.platform} draft \u2014 it would be silently dropped. Nothing was drafted. Re-send with only the fields that belong to platform:${value.platform}.`
    });
  }
  if (value.platform === "email") {
    if (!value.from) requireField(ctx, "from", "email");
    else requireAddresses(ctx, "from", [value.from]);
    if (value.to == null || value.to.length === 0) {
      requireField(ctx, "to", "email");
    } else {
      requireAddresses(ctx, "to", value.to);
    }
    if (value.cc != null) requireAddresses(ctx, "cc", value.cc);
    if (!value.subject) requireField(ctx, "subject", "email");
    return;
  }
  if (!value.target) requireField(ctx, "target", "slack");
  if (!value.channelId) requireField(ctx, "channelId", "slack");
}

var draftExternalMessageParameters = draftExternalMessageObjectSchema.superRefine(
  refineDraftExternalMessage
);

var checkSubagentParameters = external_exports.object({
  subagent_id: external_exports.string().trim().optional().describe(
    "The Agent ID of the subagent to inspect (from the Task tool result that dispatched it). Omit to list every subagent currently running."
  )
});

var messageSubagentParameters = external_exports.object({
  subagent_id: external_exports.string().trim().min(1).describe(
    "The Agent ID of the running subagent to message (from the Task tool result that dispatched it)."
  ),
  message: external_exports.string().trim().min(1).describe(
    "The instruction to inject. The subagent interrupts what it is doing, reads this, and continues from where it was with its context intact."
  )
});

var stopSubagentParameters = external_exports.object({
  subagent_id: external_exports.string().trim().min(1).describe(
    "The Agent ID of the running subagent to abort (from the Task tool result that dispatched it)."
  )
});

function isUnknownRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

var SEND_TO_AGENT_TARGET_ID_ALIASES = ["target", "agentId", "agent_id"];

var SEND_TO_AGENT_MESSAGE_ALIASES = ["content"];

var SEND_TO_AGENT_FAN_OUT_KEYS = ["target_ids", "targets"];

var SAND_SEND_TO_AGENT_TOOL_NAME = "SendToAgent";

var SEND_TO_AGENT_ALIAS_KEYS = /* @__PURE__ */ new Set([
  ...SEND_TO_AGENT_TARGET_ID_ALIASES,
  ...SEND_TO_AGENT_MESSAGE_ALIASES
]);

function normalizeSendToAgentArgs(value, ctx) {
  if (!isUnknownRecord2(value)) return value;
  const pick2 = (canonical, aliases) => value[canonical] !== void 0 ? value[canonical] : aliases.map((alias) => value[alias]).find((entry) => entry !== void 0);
  const targetId = pick2("target_id", SEND_TO_AGENT_TARGET_ID_ALIASES);
  const message = pick2("message", SEND_TO_AGENT_MESSAGE_ALIASES);
  if (targetId === void 0) {
    const fanOutKey = SEND_TO_AGENT_FAN_OUT_KEYS.find((key) => value[key] !== void 0);
    if (fanOutKey !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: [fanOutKey],
        message: `${SAND_SEND_TO_AGENT_TOOL_NAME} delivers to ONE recipient per call. Pass a single id as "target_id" (with "message") and call it once per recipient. Fan out to several agents only when the user explicitly asked you to contact them.`
      });
    }
  }
  return {
    ...Object.fromEntries(
      Object.entries(value).filter(([key]) => !SEND_TO_AGENT_ALIAS_KEYS.has(key))
    ),
    ...targetId === void 0 ? {} : { target_id: targetId },
    ...message === void 0 ? {} : { message }
  };
}

var sendToAgentParameters = external_exports.object({
  target_id: external_exports.string().trim().min(1).describe(
    "The id of the target \u2014 either another agent or a GROUP you belong to. Use an id from your teammates list, ListAgents, or ListGroups \u2014 not a name."
  ),
  message: external_exports.string().trim().min(1).describe(
    "What to say. Write it as if texting a teammate: lead with the point, keep it short."
  ),
  images: external_exports.array(
    external_exports.object({
      url: external_exports.string().trim().min(1).describe("file:// or https:// URL of the image."),
      alt: external_exports.string().trim().optional().describe(
        "Optional short description of this image, shown on hover and as its fullscreen caption."
      )
    })
  ).optional().describe(
    "Optional image(s) to send with the message \u2014 a screenshot, chart, or photo the other agent needs. Delivered with your message: a 1:1 recipient actually sees them (like an image the user sends), and they render with your text in the exchange. Not delivered to groups."
  ),
  priority: external_exports.boolean().optional().describe(
    "When true (1:1 only; ignored for groups), mark the message urgent: it jumps the recipient's queue and interrupts a routine or other background work, but never a user turn or another agent's message already in progress \u2014 it is delivered right after. Use for STOP / supersede / time-critical instructions. Default false: waits its turn, but still runs ahead of routines and other background work."
  )
}).superRefine((value, ctx) => {
  for (const [index, image2] of (value.images ?? []).entries()) {
    if (!isValidAttachmentUrl(image2.url)) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["images", index, "url"],
        message: "each images url must include a file:// or https:// scheme"
      });
    }
  }
});

var sendToAgentLenientParameters = external_exports.preprocess(normalizeSendToAgentArgs, sendToAgentParameters);

var SAND_LIST_SECTIONS_TOOL_NAME = "ListSections";

var createAgentParameters = external_exports.object({
  name: external_exports.string().trim().min(1).describe("A short, human-readable name for the new agent."),
  description: external_exports.string().trim().default("").describe(
    "The new agent's persona / instructions: what it is for and how it should behave. This becomes its profile and shapes its replies. Optional but strongly recommended."
  ),
  section_id: external_exports.string().trim().min(1).optional().describe(
    `Optional sidebar section id from ${SAND_LIST_SECTIONS_TOOL_NAME}. Omit it to leave the new agent unassigned.`
  )
});

var updateAgentParameters = external_exports.object({
  agent_id: external_exports.string().trim().min(1).describe("The id of the agent to update."),
  name: external_exports.string().trim().optional().describe("A new name for the agent. Omit to leave the name unchanged."),
  description: external_exports.string().trim().optional().describe("A new persona/description for the agent. Omit to leave it unchanged.")
});

var GROUP_MAX_MEMBERS2 = 6;

var createChannelParameters = external_exports.object({
  name: external_exports.string().trim().min(1).describe('A short, human-readable name for the channel (e.g. "Launch team").'),
  member_ids: external_exports.array(external_exports.string().trim().min(1)).min(1).describe(
    `The agent ids to seat in the channel, up to ${GROUP_MAX_MEMBERS2}. Use ids from your teammates list \u2014 not names \u2014 and never a channel id (channels cannot nest).`
  )
});

var updateChannelParameters = external_exports.object({
  channel_id: external_exports.string().trim().min(1).describe("The id of the channel to change."),
  add_member_ids: external_exports.array(external_exports.string().trim().min(1)).optional().describe("Agent ids to add to the channel. Ids that are not existing agents are ignored."),
  remove_member_ids: external_exports.array(external_exports.string().trim().min(1)).optional().describe("Agent ids to remove from the channel.")
});

var copyToBoxParameters = external_exports.object({
  computer_path: external_exports.string().trim().min(1).describe(
    "Absolute path of the file to pull, on the selected user's computer. Any file type and any size; copied verbatim, so binaries and large files are safe \u2014 unlike reading then re-writing it as text."
  ),
  box_path: external_exports.string().trim().min(1).optional().describe(
    "Where to put it inside your box. Absolute (e.g. /workspace/data.csv) or relative to /workspace. Omit to land it in /workspace/uploads under its original filename."
  )
});

var copyFromBoxParameters = external_exports.object({
  box_path: external_exports.string().trim().min(1).describe(
    "Path of the file in your box to push out. Absolute (e.g. /workspace/report.pdf) or relative to /workspace. Any file type and any size; copied verbatim. Expand any glob in Shell first and pass a concrete path."
  ),
  computer_path: external_exports.string().trim().min(1).optional().describe(
    "Destination path on the selected user's computer. Absolute, or relative to that computer's working directory. Omit to land it under its original filename in that directory."
  )
});

var RECALL_MEMORY_SCOPES = ["agent", "user", "all"];

var RECALL_MEMORY_MAX_LIMIT = 50;

var RECALL_MEMORY_DEFAULT_LIMIT = 20;

var recallMemoryParameters = external_exports.object({
  query: external_exports.string().trim().min(1).describe(
    "What to look for. Facts sharing distinctive words with the query rank first; when nothing overlaps (short identifiers like a ticket id or an acronym) a literal case-insensitive substring match is used instead."
  ),
  scope: external_exports.enum(RECALL_MEMORY_SCOPES).optional().catch(void 0).describe(
    'Which memory to search: "agent" is your own memory, "user" is the shared user memory every assistant of this user contributes to, "all" (default) is both.'
  ),
  limit: external_exports.number().int().min(1).max(RECALL_MEMORY_MAX_LIMIT).optional().catch(void 0).describe(
    `Maximum facts to return (default ${RECALL_MEMORY_DEFAULT_LIMIT}, max ${RECALL_MEMORY_MAX_LIMIT}).`
  )
});

var EVERY_PATTERN = /^@every\s+(\d+)\s*(s|m|h|d)(?:\/(\d+)\s*(s|m|h|d))?$/i;

function setsEqual(a, b2) {
  return a.size === b2.size && [...a].every((value) => b2.has(value));
}

var WEEKDAY_SET = /* @__PURE__ */ new Set([1, 2, 3, 4, 5]);

var WEEKEND_SET = /* @__PURE__ */ new Set([0, 6]);

function ascending(values) {
  return [...values].sort((a, b2) => a - b2);
}

function uniformStride(sorted) {
  const [first, second] = sorted;
  if (first === void 0 || second === void 0) return null;
  const stride = second - first;
  if (stride <= 0) return null;
  let previous = second;
  for (let index = 2; index < sorted.length; index++) {
    const value = sorted[index];
    if (value === void 0 || value - previous !== stride) return null;
    previous = value;
  }
  return stride;
}

function classifyCronDays(matcher) {
  const isMonthFull = matcher.month.size === 12;
  const isDomRestricted = matcher.isDayOfMonthRestricted && matcher.dayOfMonth.size < 31;
  const isDowRestricted = matcher.isDayOfWeekRestricted && matcher.dayOfWeek.size < 7;
  if (isDomRestricted && isDowRestricted) return null;
  if (isDowRestricted) {
    if (!isMonthFull) return null;
    if (setsEqual(matcher.dayOfWeek, WEEKDAY_SET)) return { kind: "weekdays" };
    if (setsEqual(matcher.dayOfWeek, WEEKEND_SET)) return { kind: "weekends" };
    const days = ascending(matcher.dayOfWeek);
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    if (firstDay === void 0 || lastDay === void 0) return null;
    if (days.length > 3) {
      if (uniformStride(days) !== 1) return null;
      return { kind: "weekday-range", first: firstDay, last: lastDay };
    }
    return { kind: "weekday-list", days };
  }
  if (isDomRestricted) {
    const days = ascending(matcher.dayOfMonth);
    if (isMonthFull) {
      if (days.length > 3) return null;
      return { kind: "month-days", days };
    }
    if (matcher.month.size === 1 && days.length === 1) {
      const [month] = matcher.month;
      const [day] = days;
      if (month === void 0 || day === void 0) return null;
      return { kind: "yearly-date", month, day };
    }
    return null;
  }
  if (!isMonthFull) return null;
  return { kind: "every-day" };
}

function minuteIntervalOf(sorted) {
  if (sorted[0] !== 0) return null;
  const stride = uniformStride(sorted);
  const last = sorted[sorted.length - 1];
  if (stride == null || last === void 0) return null;
  return last + stride > 59 ? stride : null;
}

function classifyCronTime(matcher) {
  const minutes = ascending(matcher.minute);
  const hours = ascending(matcher.hour);
  const firstMinute = minutes[0];
  const lastMinute = minutes[minutes.length - 1];
  const firstHour = hours[0];
  const lastHour = hours[hours.length - 1];
  if (firstMinute === void 0 || lastMinute === void 0) return null;
  if (firstHour === void 0 || lastHour === void 0) return null;
  const isHoursFull = hours.length === 24;
  if (minutes.length === 1) {
    const minute = firstMinute;
    if (isHoursFull) {
      return {
        kind: "interval",
        every: { kind: "every-hours", amount: 1, atMinute: minute },
        window: null
      };
    }
    if (hours.length === 1) {
      return { kind: "at-clock-times", times: [{ hour: firstHour, minute }] };
    }
    const stride = uniformStride(hours);
    if (stride != null) {
      if (firstHour === 0 && lastHour + stride > 23) {
        return {
          kind: "interval",
          every: { kind: "every-hours", amount: stride, atMinute: minute },
          window: null
        };
      }
      if (stride === 1 || hours.length > 3) {
        return {
          kind: "interval",
          every: { kind: "every-hours", amount: stride, atMinute: 0 },
          window: { from: { hour: firstHour, minute }, to: { hour: lastHour, minute } }
        };
      }
    }
    if (hours.length <= 3) {
      return { kind: "at-clock-times", times: hours.map((hour) => ({ hour, minute })) };
    }
    return null;
  }
  const minuteInterval = minuteIntervalOf(minutes);
  let every;
  if (minuteInterval != null) {
    every = { kind: "every-minutes", amount: minuteInterval };
  } else {
    if (minutes.length > 3) return null;
    if (!isHoursFull && hours.length === 1) {
      return {
        kind: "at-clock-times",
        times: minutes.map((minute) => ({ hour: firstHour, minute }))
      };
    }
    every = { kind: "hour-at-minutes", minutes };
  }
  if (isHoursFull) return { kind: "interval", every, window: null };
  const isContiguous = hours.length === 1 || uniformStride(hours) === 1;
  if (!isContiguous) return null;
  return {
    kind: "interval",
    every,
    window: {
      from: { hour: firstHour, minute: firstMinute },
      to: { hour: lastHour, minute: lastMinute }
    }
  };
}

var WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function joinWithAnd(parts) {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

var WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

function formatDayOfMonthOrdinal(day) {
  let suffix = "th";
  if (day % 100 < 11 || day % 100 > 13) {
    if (day % 10 === 1) {
      suffix = "st";
    } else if (day % 10 === 2) {
      suffix = "nd";
    } else if (day % 10 === 3) {
      suffix = "rd";
    }
  }
  return `${day}${suffix}`;
}

var MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

function englishCronDays(days) {
  switch (days.kind) {
    case "weekdays":
      return { lead: "Weekdays", on: " on weekdays" };
    case "weekends":
      return { lead: "Weekends", on: " on weekends" };
    case "weekday-range": {
      const range2 = `${WEEKDAYS_SHORT[days.first]}\u2013${WEEKDAYS_SHORT[days.last]}`;
      return { lead: range2, on: `, ${range2}` };
    }
    case "weekday-list": {
      const joined = joinWithAnd(
        days.days.map((day) => {
          const name17 = WEEKDAYS[day];
          invariant(name17 != null, "cron weekday index out of range");
          return name17;
        })
      );
      return { lead: `Every ${joined}`, on: ` on ${joined}` };
    }
    case "month-days": {
      const ordinals = joinWithAnd(days.days.map(formatDayOfMonthOrdinal));
      return {
        lead: `On the ${ordinals} of every month`,
        on: ` on the ${ordinals} of every month`
      };
    }
    case "yearly-date": {
      const date6 = `${MONTHS[days.month - 1]} ${days.day}`;
      return { lead: `Every ${date6}`, on: ` on ${date6}` };
    }
    case "every-day":
      return { lead: "Every day", on: null };
  }
}

function formatClock(hour, minute) {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function minuteOfHourToken(minute) {
  return `:${String(minute).padStart(2, "0")}`;
}

function englishEvery(every) {
  switch (every.kind) {
    case "every-minutes":
      return every.amount === 1 ? "Every minute" : `Every ${every.amount} minutes`;
    case "every-hours": {
      const base = every.amount === 1 ? "Every hour" : `Every ${every.amount} hours`;
      return every.atMinute === 0 ? base : `${base} at ${minuteOfHourToken(every.atMinute)}`;
    }
    case "hour-at-minutes":
      return `Every hour at ${joinWithAnd(every.minutes.map(minuteOfHourToken))}`;
  }
}

function describeCronMatcher(matcher) {
  const days = classifyCronDays(matcher);
  if (days == null) return null;
  const time4 = classifyCronTime(matcher);
  if (time4 == null) return null;
  const dayPhrase = englishCronDays(days);
  if (time4.kind === "at-clock-times") {
    const times = time4.times.map((entry) => formatClock(entry.hour, entry.minute));
    return `${dayPhrase.lead} at ${joinWithAnd(times)}`;
  }
  const on = dayPhrase.on ?? "";
  const window2 = time4.window == null ? "" : `, ${formatClock(time4.window.from.hour, time4.window.from.minute)} \u2013 ${formatClock(time4.window.to.hour, time4.window.to.minute)}`;
  return `${englishEvery(time4.every)}${on}${window2}`;
}

function describeSchedule(schedule) {
  const normalized = normalizeSchedule(schedule);
  const intervalMs = parseEveryIntervalMs(normalized);
  if (intervalMs != null) {
    const match2 = EVERY_PATTERN.exec(normalized);
    if (match2 == null) return normalized;
    const amount = match2[1] ?? "";
    const unitName = { s: "second", m: "minute", h: "hour", d: "day" }[match2[2]?.toLowerCase() ?? ""] ?? "";
    if (amount === "1") return `Every ${unitName}`;
    return `Every ${amount} ${unitName}s`;
  }
  const matcher = compileCronMatcher(normalized);
  if (matcher == null) return normalized;
  const prose = describeCronMatcher(matcher);
  if (prose == null) return normalized;
  return matcher.timeZone == null ? prose : `${prose} (${matcher.timeZone})`;
}

var TRIGGER_ANY_SCOPE = "*";

function describeSlackScope(channel) {
  if (channel === TRIGGER_ANY_SCOPE) return "anywhere on Slack";
  return `in ${channel}`;
}

function joinWithOr(parts) {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

function describeSlackListener(listener) {
  const scope = describeSlackScope(listener.channel);
  switch (listener.match.kind) {
    case "mention":
      return `When @mentioned ${scope}`;
    case "keyword":
      return `When "${listener.match.keyword}" is mentioned ${scope}`;
    case "reaction": {
      const emoji3 = listener.match.emoji ?? [];
      const names3 = joinWithOr(emoji3.map((name17) => `:${name17}:`));
      if (listener.match.bySelf === true) {
        return `When you react${emoji3.length > 0 ? ` ${names3}` : ""} ${scope}`;
      }
      return `On ${emoji3.length > 0 ? names3 : "a reaction"} ${scope}`;
    }
    case "message":
      return `On any message ${scope}`;
  }
}

var GITHUB_EVENT_PHRASES = [
  "a PR opens",
  "a PR is updated",
  "a PR merges",
  "a PR closes",
  "a review is requested",
  "a review approves a PR",
  "a review requests changes",
  "a review comments on a PR",
  "a PR comment lands",
  "an inline review comment lands",
  "a review thread is resolved",
  "a review thread is reopened",
  "an issue is assigned",
  "CI passes",
  "CI fails"
];

function githubEventPhrase(kind) {
  return GITHUB_EVENT_PHRASES[GITHUB_EVENT_KINDS.indexOf(kind)] ?? "";
}

function isGithubCiEventKind(kind) {
  return kind === "ci-passed" || kind === "ci-failed";
}

function describeGithubListener(listener) {
  const phrases = listener.events.map((kind) => {
    const phrase = githubEventPhrase(kind);
    return isGithubCiEventKind(kind) && listener.ciBranch != null ? `${phrase} on ${listener.ciBranch}` : phrase;
  });
  const base = `When ${joinWithOr(phrases)} in ${listener.repo}${listener.pr != null ? ` on PR #${listener.pr}` : ""}`;
  if (listener.userAllowlist == null || listener.userAllowlist.length === 0) {
    return base;
  }
  const logins = joinWithOr(
    listener.userAllowlist.map((login) => login.startsWith("@") ? login : `@${login}`)
  );
  return `${base} (by ${logins})`;
}

var ORIGIN_EVENT_PHRASES = {
  "pr-opened": "a PR opens",
  "pr-pushed": "a PR is updated",
  "pr-merged": "a PR merges",
  "review-requested": "a review is requested",
  "review-approved": "a review approves a PR",
  "review-changes-requested": "a review requests changes",
  "review-commented": "a review comments on a PR",
  "pr-comment": "a PR comment lands",
  "inline-review-comment": "an inline review comment lands",
  "review-thread-resolved": "a review thread is resolved",
  "review-thread-unresolved": "a review thread is reopened",
  "ci-passed": "CI passes",
  "ci-failed": "CI fails"
};

function describeOriginListener(listener) {
  const phrases = listener.events.map((kind) => ORIGIN_EVENT_PHRASES[kind]);
  const base = `When ${joinWithOr(phrases)} in ${listener.repo}${listener.pr != null ? ` on PR #${listener.pr}` : ""}`;
  if (listener.userAllowlist == null || listener.userAllowlist.length === 0) {
    return base;
  }
  return `${base} (by ${joinWithOr(listener.userAllowlist)})`;
}

var LINEAR_EVENT_PHRASES = {
  issueCreated: "a Linear issue is created",
  statusChanged: "a Linear issue changes status",
  endOfCycle: "a Linear cycle ends"
};

var SENTRY_EVENT_PHRASES = {
  issueCreated: "a Sentry issue is created",
  issueResolved: "a Sentry issue is resolved",
  issueAssigned: "a Sentry issue is assigned",
  issueArchived: "a Sentry issue is archived",
  issueUnresolved: "a Sentry issue becomes unresolved",
  issueAny: "a Sentry issue changes"
};

var PAGERDUTY_EVENT_PHRASES = {
  incidentTriggered: "a PagerDuty incident is triggered",
  incidentAcknowledged: "a PagerDuty incident is acknowledged",
  incidentResolved: "a PagerDuty incident is resolved",
  incidentEscalated: "a PagerDuty incident is escalated",
  incidentAny: "a PagerDuty incident changes"
};

function describeListener(listener) {
  switch (listener.type) {
    case "slack":
      return describeSlackListener(listener);
    case "github":
      return describeGithubListener(listener);
    case "origin":
      return describeOriginListener(listener);
    case "microsoftTeams":
      return listener.messageContains === "" ? "On a Microsoft Teams message" : `When a Microsoft Teams message matches "${listener.messageContains}"`;
    case "linear":
      return `When ${LINEAR_EVENT_PHRASES[listener.event.case]}`;
    case "sentry":
      return `When ${SENTRY_EVENT_PHRASES[listener.event.case]}`;
    case "pagerduty":
      return `When ${PAGERDUTY_EVENT_PHRASES[listener.event.case]}`;
    case "webhook":
      return "When a webhook fires";
  }
}

function triggerList(trigger2) {
  return trigger2.type === "group" ? trigger2.listeners : [trigger2];
}

function decapitalize(phrase) {
  const first = phrase[0];
  return first == null ? phrase : first.toLowerCase() + phrase.slice(1);
}

function describeTrigger(trigger2) {
  const describeMember = (member) => member.type === "cron" ? describeSchedule(member.schedule) : describeListener(member);
  const [first, ...rest] = triggerList(trigger2);
  return [
    describeMember(first),
    ...rest.map((member) => decapitalize(describeMember(member)))
  ].join(" or ");
}

const schemas={"update_state":sandUpdateStateParameters,"Computer":computerActionParameters,"SendToUser":sendMessageParametersWithCredentialRequest,"ReactToMessage":reactToMessageParameters,"SendFeedback":sendFeedbackParameters,"request_box_help":requestBoxHelpParameters,"DraftExternalMessage":draftExternalMessageParameters,"CheckSubagent":checkSubagentParameters,"MessageSubagent":messageSubagentParameters,"StopSubagent":stopSubagentParameters,"SendToAgent":sendToAgentLenientParameters,"CreateAgent":createAgentParameters,"UpdateAgent":updateAgentParameters,"CreateChannel":createChannelParameters,"UpdateChannel":updateChannelParameters,"CopyToBox":copyToBoxParameters,"CopyFromBox":copyFromBoxParameters,"RecallMemory":recallMemoryParameters};
// Explicit deployment extensions: connector secrets and personal environment scope.
// Keep the captured refinements for every other SendToUser field.
const localSecretSchema = sendMessageObjectSchemaWithCredentialRequest.shape.secret.unwrap().extend({
  name: sendMessageObjectSchemaWithCredentialRequest.shape.secret.unwrap().shape.name.optional(),
  connector: external_exports.string().trim().min(1).optional(),
  field: external_exports.string().trim().min(1).optional(),
  scope: external_exports.enum(["bot", "personal"]).optional(),
}).superRefine((secret, ctx) => {
  if (secret.connector ? !secret.field || secret.name : !secret.name || secret.field)
    ctx.addIssue({code: "custom", message: "Use either name for an environment secret or connector and field for a connector credential"});
});
// end_turn belongs to the invocation envelope in the captured host. Preserve it
// here because OpenTeam receives that envelope together with the message fields.
const adaptedSendSchema = sendMessageObjectSchemaWithCredentialRequest.extend({
  secret: localSecretSchema.optional(),
  end_turn: external_exports.boolean().optional(),
}).superRefine(refineSendMessage);
export function normalizeMainToolArguments(name:string, raw:unknown):Record<string,any>{return name === "SendToUser" ? adaptedSendSchema.parse(raw) : schemas[name] ? schemas[name].parse(raw) : raw as Record<string,any>;}
export { describeTrigger };
