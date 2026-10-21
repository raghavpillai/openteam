import type { ApprovalMcpAction, ApprovalSummaryCopy } from "@openteam/contracts/auto-review";

/** The reference's card summaries (sand-auto-review-summaries), with OpenTeam as the bot's name. */
export const SUMMARY_MAX_CHARS = 500;
export const COMMAND_MAX_CHARS = 4_000;

export const SECRET_VALUE_PATTERN = /^(?:bearer\s+|sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[^\s]*$/i;
export const SECRET_KEY_PATTERN = /(?:auth|credential|key|password|secret|signature|token)/i;

export function redactInlineSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`]+/gi, (rawUrl) => {
      try {
        const href = new URL(rawUrl).href.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
        const withoutHash = href.split("#")[0] ?? href;
        return withoutHash.split("?")[0] ?? withoutHash;
      } catch {
        return rawUrl;
      }
    })
    .replace(/((?:--)?(?:api[_-]?key|authorization|credential|password|secret|signature|token)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1…")
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer …")
    .replace(/\b(?:sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9+/_=-]+/gi, "…");
}

export function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function compactHeadAndTail(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  let omittedChars = normalized.length - maxChars;
  let omittedLabel = "";
  let available = 2;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    omittedLabel = `…[${omittedChars} chars omitted]…`;
    available = Math.max(2, maxChars - omittedLabel.length);
    const actualOmittedChars = normalized.length - available;
    if (actualOmittedChars === omittedChars) break;
    omittedChars = actualOmittedChars;
  }
  return `${normalized.slice(0, Math.ceil(available / 2))}${omittedLabel}${normalized.slice(-Math.floor(available / 2))}`;
}

const trimEnd = (value: string) => value.replace(/[.!?]+$/u, "");

export function describeShellAction(args: { surface: "host_shell" | "box_shell"; command: string; workingDirectory?: string; description?: string }) {
  const location = args.surface === "host_shell" ? "on your local computer" : "on OpenTeam's computer";
  const description = args.description?.replace(/\s+/g, " ").trim();
  const cwd = args.workingDirectory === undefined ? "" : ` from ${compact(args.workingDirectory, 100)}`;
  const summary = description
    ? compact(`${trimEnd(description)} ${location}${cwd}`, 340)
    : compact(`${args.surface === "host_shell" ? "Run a command on your local computer" : "Run a command on OpenTeam's computer"}${cwd}`, 340);
  const head = description ? compact(trimEnd(description), 220) : undefined;
  const workingDirectory = args.workingDirectory === undefined ? undefined : compact(args.workingDirectory, 100);
  const summaryCopy: ApprovalSummaryCopy = {
    kind: "shell",
    params: { surface: args.surface, ...(head ? { description: head } : {}), ...(workingDirectory ? { workingDirectory } : {}) },
  };
  return { summary, summaryCopy };
}

function redactMcpValue(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined && SECRET_KEY_PATTERN.test(key)) return "…";
  if (typeof value === "string") {
    const redacted = redactInlineSecrets(value);
    return SECRET_VALUE_PATTERN.test(redacted) ? "…" : compactHeadAndTail(redacted, 160);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const selected = value.length <= 6 ? value : [...value.slice(0, 3), `${value.length - 6} items omitted`, ...value.slice(-3)];
    return selected.map((entry) => redactMcpValue(entry, undefined, depth + 1));
  }
  const all = Object.entries(value);
  const entries = all.length <= 12 ? all : [...all.slice(0, 6), ["…", `${all.length - 12} fields omitted`], ...all.slice(-6)];
  return Object.fromEntries(entries.map(([entryKey, entry]) => [compact(entryKey, 60), redactMcpValue(entry, entryKey, depth + 1)]));
}

function redactMcpSecrets(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY_PATTERN.test(key)) return "…";
  if (typeof value === "string") {
    const redacted = redactInlineSecrets(value);
    return SECRET_VALUE_PATTERN.test(redacted) ? "…" : redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactMcpSecrets(entry));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactMcpSecrets(entry, entryKey)]));
}

/** The card's command line for an MCP call. */
export function summarizeMcpAction(args: { serverDisplayName: string; toolName: string; mcpArguments?: Record<string, unknown> }) {
  const details = compactHeadAndTail(JSON.stringify(redactMcpValue(args.mcpArguments ?? {})), 300);
  return `Use ${compact(args.serverDisplayName, 80) || "a connected service"} tool ${compact(args.toolName, 80) || "action"} with ${details}`;
}

/** "View the full request" for an MCP call. */
export function mcpRawRequest(args: { serverDisplayName: string; toolName: string; mcpArguments?: Record<string, unknown> }) {
  return `${args.serverDisplayName || "MCP"} ${args.toolName}\n${JSON.stringify(redactMcpSecrets(args.mcpArguments ?? {}), null, 2)}`;
}

const MCP_DESTINATION_KEYS = new Set(["channel", "channel_id", "channelid", "path", "page", "page_id", "pageid", "repo", "repository", "title", "name", "url"]);
const MCP_ACTION_VERBS: Record<string, ApprovalMcpAction> = {
  delete: "delete", remove: "delete", trash: "delete", destroy: "delete", purge: "delete",
  send: "send", post: "send", reply: "send", forward: "send", publish: "send",
  create: "change", update: "change", edit: "change", add: "change", set: "change", move: "change", rename: "change",
  write: "change", upload: "change", insert: "change", patch: "change", cancel: "change",
};
const MCP_EFFECT_ACTIONS: Record<string, ApprovalMcpAction | "use"> = {
  destructive_data_loss: "delete",
  outbound_or_binding_external_effect: "send",
  data_or_credential_exfiltration: "send",
  host_compromise_or_persistence: "use",
};
const MCP_ACTION_RANK = { use: 0, change: 1, send: 2, delete: 3 } as const;

const nameWords = (name: string) =>
  compact(name, 80).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim().toLowerCase().split(/\s+/).filter(Boolean);

function withoutServerPrefix(words: string[], server: string) {
  let spelled = "";
  for (const [index, word] of words.entries()) {
    spelled += word;
    if (spelled === server) return words.slice(index + 1);
    if (!server.startsWith(spelled)) break;
  }
  return words;
}

function mcpAction(args: { serverDisplayName: string; toolName: string; blockedEffect?: string; readOnlyHint?: boolean }) {
  const leadingVerb = withoutServerPrefix(nameWords(args.toolName), nameWords(args.serverDisplayName).join(""))[0];
  const named = leadingVerb !== undefined && Object.hasOwn(MCP_ACTION_VERBS, leadingVerb) ? MCP_ACTION_VERBS[leadingVerb] : undefined;
  const candidates: Array<ApprovalMcpAction | "use"> = [
    named ?? "use",
    args.blockedEffect === undefined ? "use" : MCP_EFFECT_ACTIONS[args.blockedEffect] ?? "use",
    args.readOnlyHint === false ? "change" : "use",
  ];
  return candidates.reduce((top, action) => (MCP_ACTION_RANK[action] > MCP_ACTION_RANK[top] ? action : top));
}

function humanizeToolAction(toolName: string) {
  const words = nameWords(toolName);
  if (!words.length) return undefined;
  if (words.length === 2 && /^(send|create|update|delete|post|write|read|add|remove|open|close|list|search|fetch|get|set|upload|download|invite|share)$/.test(words[0] ?? "") && !/s$/i.test(words[1] ?? ""))
    return `${words[0]} ${/^[aeiou]/i.test(words[1] ?? "") ? "an" : "a"} ${words[1]}`;
  return words.join(" ");
}

function destinationHint(mcpArguments?: Record<string, unknown>) {
  for (const [rawKey, value] of Object.entries(mcpArguments ?? {})) {
    if (typeof value !== "string") continue;
    const key = rawKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!MCP_DESTINATION_KEYS.has(key) || SECRET_KEY_PATTERN.test(rawKey)) continue;
    const redacted = redactInlineSecrets(value).replace(/\s+/g, " ").trim();
    if (!redacted || redacted.length > 80 || SECRET_VALUE_PATTERN.test(redacted)) continue;
    return compact(redacted, 60);
  }
  return undefined;
}

export function describeMcpAction(args: {
  serverDisplayName: string;
  toolName: string;
  mcpArguments?: Record<string, unknown>;
  description?: string;
  readOnlyHint?: boolean;
  blockedEffect?: string;
}) {
  const description = args.description?.replace(/\s+/g, " ").trim();
  const server = compact(args.serverDisplayName, 80);
  let summary: string;
  if (description) {
    const head = trimEnd(description);
    summary = server && !head.toLowerCase().includes(server.toLowerCase()) ? compact(`${head} with ${server}`, 340) : compact(head, 340);
  } else {
    const action = humanizeToolAction(args.toolName);
    const hint = destinationHint(args.mcpArguments);
    if (!server && action === undefined) summary = "Use a connected service";
    else if (action === undefined) summary = server ? `Use ${server}` : "Use a connected service";
    else {
      const base = server ? `Use ${server} to ${action}` : `Use a connected service to ${action}`;
      summary = hint === undefined || base.toLowerCase().includes(hint.toLowerCase()) ? base : `${base} to ${hint}`;
    }
  }
  const head = description ? compact(trimEnd(description), 240) : undefined;
  const toolName = head === undefined ? compact(args.toolName, 80) || undefined : undefined;
  const hint = head === undefined ? destinationHint(args.mcpArguments) : undefined;
  const action = mcpAction(args);
  const summaryCopy: ApprovalSummaryCopy = {
    kind: "mcp",
    params: {
      ...(head ? { description: head } : {}),
      ...(server ? { serverDisplayName: server } : {}),
      ...(toolName ? { toolName } : {}),
      ...(hint ? { destinationHint: hint } : {}),
      ...(action === "use" ? {} : { action }),
    },
  };
  return { summary, summaryCopy };
}

export function summarizeRoutineWrite(args: { operation: "create" | "update"; name: string; triggerDescription: string; prompt: string; isEnabled?: boolean }) {
  const name = compact(args.name, 80) || "a routine";
  const instruction = compactHeadAndTail(redactInlineSecrets(args.prompt), 240);
  const when = compact(args.triggerDescription, 120) || "on a trigger";
  const verb = args.operation === "create" ? "Save" : "Change";
  const paused = args.isEnabled === false ? " (paused)" : "";
  return `${verb} the routine “${name}”${paused} to run ${when.toLowerCase()}: “${instruction}”`;
}

export function summarizeTypedText(text: string) {
  const redacted = redactInlineSecrets(text);
  const normalized = compactHeadAndTail(redacted, 80);
  const looksSensitive =
    redacted !== text ||
    SECRET_VALUE_PATTERN.test(text.trim()) ||
    /(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]/i.test(text) ||
    (/^[A-Za-z0-9+/_=-]{24,}$/.test(text.trim()) && !text.trim().includes(" "));
  return looksSensitive || !normalized ? `Type ${text.length} characters` : `Type ${text.length} characters (“${normalized}”)`;
}

export interface ComputerExactAction {
  action: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  key?: string;
  modifiers?: string;
}

const heldGesture = (base: string, modifiers?: string) => {
  const gesture = modifiers === undefined ? base : `${modifiers}-${base}`;
  return `${gesture.charAt(0).toUpperCase()}${gesture.slice(1)}`;
};
const point = (preposition: string, x?: number, y?: number) => (x === undefined || y === undefined ? "" : ` ${preposition} (${x}, ${y})`);

export function summarizeComputerAction(action: ComputerExactAction, description?: string) {
  const withPurpose = (summary: string) => (description === undefined ? summary : `${summary} to ${description.slice(0, 160)}`);
  if (action.action === "click") return withPurpose(`${heldGesture("click", action.modifiers)}${point("at", action.x, action.y)} on OpenTeam's computer`);
  if (action.action === "drag")
    return withPurpose(`${heldGesture("drag", action.modifiers)}${point("from", action.x, action.y)}${point("to", action.x2, action.y2)} on OpenTeam's computer`);
  if (action.action === "type") return `${summarizeTypedText(action.text ?? "")} on OpenTeam's computer`;
  return `Press ${action.key?.slice(0, 80) ?? "a key"} on OpenTeam's computer`;
}

export function computerCardTarget(actions: ComputerExactAction[]) {
  const input = (action: ComputerExactAction) =>
    action.action === "click" || action.action === "drag"
      ? heldGesture(action.action, action.modifiers)
      : action.action === "type"
        ? summarizeTypedText(action.text ?? "")
        : `Press ${action.key?.slice(0, 40) ?? "a key"}`;
  return `${actions.map(input).map((part, index) => (index === 0 ? part : `${part.charAt(0).toLowerCase()}${part.slice(1)}`)).join(", then ")} on OpenTeam's computer`.slice(0, SUMMARY_MAX_CHARS);
}

export interface BrowserExactAction {
  op: string;
  url?: string;
  text?: string;
  value?: string;
  values?: string[];
  key?: string;
  code?: string;
  tabsAction?: string;
  tabIndex?: number;
  element?: string;
}

export function summarizeBrowserAction(args: BrowserExactAction & { targetPageUrl?: string }) {
  const element = args.element?.replace(/\s+/g, " ").trim();
  const target = element ? `“${compact(element, 160)}”` : "an element";
  const page = args.targetPageUrl ? ` on ${compactHeadAndTail(redactInlineSecrets(args.targetPageUrl), 120)}` : "";
  const summarize = (action: string) => compact(`${action}${page} in OpenTeam's browser`, 340);
  switch (args.op) {
    case "navigate":
      return compact(`Open “${redactInlineSecrets(args.url ?? "")}” in OpenTeam's browser`, 340);
    case "click":
      return summarize(`Click ${target}`);
    case "type":
      return summarize(summarizeTypedText(args.text ?? ""));
    case "fill":
      return summarize(summarizeTypedText(args.value ?? ""));
    case "select_option":
      return summarize(`Select “${redactInlineSecrets((args.values ?? []).join(", "))}” in ${target}`);
    case "press_key":
      return summarize(`Press ${args.key?.slice(0, 80) ?? "a key"}`);
    case "drag":
      return summarize(`Drag ${target}`);
    case "run_code": {
      const lines = (args.code ?? "").trim().split("\n").length;
      return summarize(lines === 1 ? "Run a 1-line script" : `Run a ${lines}-line script`);
    }
    case "tabs":
      if (args.tabsAction === "new" && args.url)
        return compact(`Open “${redactInlineSecrets(args.url)}” in a new tab in OpenTeam's browser`, 340);
      return summarize(args.tabsAction === "close" ? `Close tab${args.tabIndex !== undefined ? ` ${args.tabIndex}` : ""}` : "Open a new tab");
    default:
      return compact(`Browser ${args.op} on OpenTeam's computer`, 340);
  }
}
