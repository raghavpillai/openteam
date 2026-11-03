// Task dispatch texts the parent sees and the notes added to a worker's task, as the reference words them.

const OPENTABLE_DISPATCH_NOTES =
  "OpenTable notes, for checking open tables or booking on OpenTable. Skip them for any other job, and follow the task above where it says otherwise. The URL the task gives sets the party size and time, so read the times on that page. Use the page's date, time, or party controls only if those controls show something else, and only once. The time buttons' hidden labels can name a different party size, so trust the party control. A search covers the whole city even when the term names a neighborhood, so choose results by the neighborhood on each card. Never build other OpenTable URLs. If the tab crashes or goes blank without an error code, open the same URL once more. If the times are still loading, wait once, then take one snapshot; do not snapshot a loading page again and again. Access Denied, a challenge page, or a blocked response will not clear on reload, so stop and report it with the URL. On an availability check, never click a time, because that holds the table. Before completing a booking, check that the details page shows the requested party size. A page that asks for a password, a code, or a card number ends the task, so report its URL. If the requested time is gone, report the nearest open times on that page. On an availability check, report as soon as the requested date's times are on screen.";
const RESY_DISPATCH_NOTES =
  "Resy notes, for checking open tables or booking on Resy. Skip them for any other job, and follow the task above where it says otherwise. The URL the task gives sets the date and party size, so read the times on that page. Use the page's date or party controls only if it shows something else, and only once. Never build other Resy URLs. The times load after the page itself, so wait once for them, then take one snapshot; do not snapshot a loading page again and again. If no time appears, report what the page shows instead, such as a sold-out message or a Notify option. If the tab crashes or goes blank without an error code, open the same URL once more. Access Denied or a bot check will not clear on reload, so stop and report it with the URL. On an availability check, do not click a time or Notify. A page that asks for a password, a code, or a card number ends the task, so report its URL. On an availability check, report as soon as the times are on screen.";
// The reference's tailnet note needs its own tailnet browser launcher, which this computer does not have.
const SITE_DISPATCH_NOTES = [
  { mention: /\bopentable\b/i, text: OPENTABLE_DISPATCH_NOTES },
  { mention: /\bresy\b/i, text: RESY_DISPATCH_NOTES },
];

/** A computerUse task that names one of these sites carries the site's notes after it. */
export const withSiteDispatchNotes = (task: string): string => {
  const notes = SITE_DISPATCH_NOTES.filter((note) => note.mention.test(task) && !task.includes(note.text)).map((note) => note.text);
  return notes.length ? [task, ...notes].join("\n\n") : task;
};

export const withoutSiteDispatchNotes = (task: string): string =>
  SITE_DISPATCH_NOTES.reduce((text, note) => text.replaceAll(note.text, ""), task);

// A plugin agent's task is its template, then the parent's own words after this line.
const PLUGIN_AGENT_TASK_MARKER = "\n\nTask from the parent:\n";

/** A background task's title is the opening of what the parent asked, cut to 80 characters. */
export const subagentTitle = (prompt: string): string => {
  const asked = prompt.includes(PLUGIN_AGENT_TASK_MARKER) ? prompt.slice(prompt.lastIndexOf(PLUGIN_AGENT_TASK_MARKER) + PLUGIN_AGENT_TASK_MARKER.length) : prompt;
  const line = withoutSiteDispatchNotes(asked).replace(/\s+/g, " ").trim();
  if (!line) return "Background task";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
};

const SUBAGENT_TYPES = ["executor", "videoReview", "watchVideo", "computerUse", "knowledgeWork"] as const;
type DispatchType = (typeof SUBAGENT_TYPES)[number];

/** The reference matches a subagent type by its letters alone, so computer_use and ComputerUseAgent name computerUse. */
export const normalizeSubagentTypeName = (name: string): string => {
  const normalized = name.trim().toLowerCase().replace(/[-_]/g, "").replace(/(?<=.)(subagenttype|subagent|agent|mode|type)$/, "");
  return normalized === "mediareview" ? "videoreview" : normalized;
};

/** The subagent type a spelling names, or the spelling itself when it names none. */
export const canonicalSubagentType = (name: string): string =>
  SUBAGENT_TYPES.find((type) => normalizeSubagentTypeName(type) === normalizeSubagentTypeName(name)) ?? name;

/** Task arguments with subagent_type spelled as its type is named. */
export const withCanonicalSubagentType = (args: unknown): unknown =>
  args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).subagent_type === "string"
    ? { ...args, subagent_type: canonicalSubagentType((args as Record<string, string>).subagent_type!) }
    : args;

const IDENTIFIER_SHAPED = /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/;

// The reference's reasons for withholding each of the parent's tools from a Task child, limited to
// tools the parent has here and the child lacks. Tools a child holds, here or in the reference, are not listed.
const TALK = "Only the parent talks to the user; a Task subagent reports back in its final message.";
const CONNECTORS = "Installing or changing connectors and plugins is the user's call, made through the parent.";
const WAKE_PARENT = "Only an automation run wakes its parent; every other agent reports back in its final message.";
const CONNECTOR_CHANGES = ["SearchPlugins", "GetPlugin", "GetMcpServerStatus", "UninstallPlugin", "UninstallMcpServer", "RestartMcpServers", "RenameMcpAccount", "RemoveMcpAccount", "SetMcpInstructions"];
const MESSAGES_READS = ["FindContacts", "FindIMessageChats", "ChatItems", "SearchIMessages", "FetchIMessageAttachment", "CheckIMessagePermissions"];
const STATE_WRITES = ["UpdateMemory", "UpdateRoutine", "UpdateSkill", "UpdateProfile", "UpdateAvatar"];
const TEAM_CHANGES = ["ListSections", "CreateAgent", "UpdateAgent", "CreateChannel", "UpdateChannel", "DisconnectChannel", "CreateBotShareJson"];
const HISTORY = ["RecallMemory", "ReadTranscript", "ReadAgentActivity"];
const FAN_OUT = ["TodoWrite", "CheckSubagent", "MessageSubagent", "StopSubagent"];
const AS_THE_USER = ["SendToAgent", "SendIMessage"];
const USER_FACING = ["SendToUser", "ReactToMessage", "InstallPlugin", "AddMcpServer", "AuthenticateMcpServer", "RequestCookieOriginApproval", "DraftExternalMessage"];

const reasons = (groups: ReadonlyArray<readonly [string, readonly string[]]>): ReadonlyMap<string, string> =>
  new Map(groups.flatMap(([reason, tools]) => tools.map((tool) => [tool, reason] as const)));

const TASK_CHILD_REASONS = reasons([
  [TALK, [...USER_FACING, "RequestUserForm", "RemapUserFormTargets"]],
  ["The parent puts the memory a task needs into the task; Task subagents don't search it.", HISTORY],
  ["Creating or changing bots, channels, and team sharing is the parent's call, made with the user.", TEAM_CHANGES],
  ["Memory, routines, tasks, and the bot's profile change only through the parent, which owns the conversation.", STATE_WRITES],
  ["Task subagents don't start subagents of their own; the parent fans work out.", FAN_OUT],
  ["Messages under the user's name need approval that only the parent can collect.", AS_THE_USER],
  [CONNECTORS, CONNECTOR_CHANGES],
  ["The parent passes along the facts a task needs; Task subagents don't browse the user's private messages.", MESSAGES_READS],
  [WAKE_PARENT, ["WakeParent"]],
]);

// computerUse holds no in-chat form here, so RequestUserForm is not one of its reference reasons.
const COMPUTER_USE_REASONS = reasons([
  ["computerUse reports to the parent that dispatched it, never to the user.", [...USER_FACING, "RemapUserFormTargets"]],
  ["computerUse acts on the page in front of it; the parent passes any memory it needs.", HISTORY],
  ["Creating or changing bots, channels, and team sharing is the parent's call.", TEAM_CHANGES],
  ["Memory, routines, tasks, and the bot's profile change only through the parent.", STATE_WRITES],
  ["A box driver reads untrusted pages, so it stays on the box and can't move data or work off it.", ["ListMachines", "UploadFile", "DownloadFile", "CopyToBox", "CopyFromBox"]],
  ["computerUse doesn't start subagents; the parent fans work out.", FAN_OUT],
  ["computerUse never acts toward other people as the user; the parent does, with approval.", AS_THE_USER],
  [CONNECTORS, CONNECTOR_CHANGES],
  ["computerUse works on the page in front of it; the parent passes any facts it needs.", MESSAGES_READS],
  ["computerUse browses in the box browser it drives; search and fetch belong to the parent.", ["WebFetch", "WebSearch"]],
  [WAKE_PARENT, ["WakeParent"]],
]);

const MEDIA_REVIEW_REASONS = reasons([
  ["Media review is a single review pass over the media it is handed and holds no tools.", [
    ...USER_FACING, "RequestUserForm", "RemapUserFormTargets", ...HISTORY, ...TEAM_CHANGES, ...STATE_WRITES, ...FAN_OUT, ...AS_THE_USER,
    ...CONNECTOR_CHANGES, ...MESSAGES_READS, "WakeParent",
    "ListMachines", "AwaitShell", "UploadFile", "DownloadFile", "WebFetch", "WebSearch", "CopyToBox", "CopyFromBox",
  ]],
]);

const PARENT_ONLY_TOOLS: Record<DispatchType, ReadonlyMap<string, string>> = {
  executor: TASK_CHILD_REASONS,
  knowledgeWork: TASK_CHILD_REASONS,
  computerUse: COMPUTER_USE_REASONS,
  videoReview: MEDIA_REVIEW_REASONS,
  watchVideo: MEDIA_REVIEW_REASONS,
};

/** The parent's tools a Task child of this type lacks, with the reason; for a resume of unknown type, those every child lacks. */
export const parentOnlyToolsFor = (subagentType: string | undefined): ReadonlyMap<string, string> => {
  if (subagentType !== undefined) return PARENT_ONLY_TOOLS[canonicalSubagentType(subagentType) as DispatchType] ?? new Map();
  return new Map([...PARENT_ONLY_TOOLS.executor].filter(([tool]) => SUBAGENT_TYPES.every((type) => PARENT_ONLY_TOOLS[type].has(tool))));
};

const namesTool = (prompt: string, name: string) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(prompt);

/**
 * The reminder a Task result carries when its prompt names tools the child lacks, so the parent does
 * those steps itself. subagentType is undefined for a resume that does not name one.
 */
export const parentOnlyDispatchNotice = (input: { subagentType: string | undefined; prompt: string }): string | undefined => {
  const tools = [...parentOnlyToolsFor(input.subagentType)]
    .filter(([name]) => IDENTIFIER_SHAPED.test(name) && namesTool(input.prompt, name))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!tools.length) return undefined;
  const subagent = input.subagentType === undefined ? "the resumed subagent" : `the ${canonicalSubagentType(input.subagentType)} subagent`;
  return [
    "<system_reminder>",
    `This dispatch names ${tools.map(([name]) => name).join(", ")}, which ${subagent} does not have, so it cannot do those steps.`,
    ...tools.map(([name, reason]) => `- ${name}: ${reason}`),
    "If the task needs them, do those steps yourself in this turn, before you end it. The subagent still runs and reports back on the rest.",
    "</system_reminder>",
  ].join("\n");
};
