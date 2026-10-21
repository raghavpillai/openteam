/** Auto-review, the reference's per-action safety check: the user's settings and rules,
 * and the approval card that holds a blocked action until the user answers. */
export const AUTO_REVIEW_RULE_MAX_ENTRIES = 20;
export const AUTO_REVIEW_RULE_MAX_CHARS = 1_000;
/** A card raised outside a live user turn expires after this; one in a live turn waits ("park"). */
export const AUTO_REVIEW_APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface AutoReviewSettings {
  enabled: boolean;
  /** "Allow rules": actions that match go ahead without asking unless an Ask first rule also matches. */
  allowRules: string[];
  /** "Ask first rules": actions that match always stop for approval; they win over Allow rules. */
  askFirstRules: string[];
}
/** The reference's production modes are server-side; its shipped app and prompt treat Auto-review as on. */
export const DEFAULT_AUTO_REVIEW_SETTINGS: AutoReviewSettings = { enabled: true, allowRules: [], askFirstRules: [] };

export const AUTO_REVIEW_SURFACES = ["host_shell", "box_shell", "mcp", "computer", "automation_write", "feedback"] as const;
export type AutoReviewSurface = (typeof AUTO_REVIEW_SURFACES)[number];
export type AutoReviewExpiryPolicy = "park" | "ttl";
export type ApprovalCardState = "pending" | "approved" | "always" | "denied" | "expired";
export type ApprovalDecision = "approved" | "always" | "denied";
export type ApprovalCautionNote = "cant_undo" | "security_settings" | "shares_data";
export type ApprovalMcpAction = "change" | "send" | "delete";
export interface AutoReviewAppliedRule {
  effect: "allow" | "ask_first";
  text: string;
}
export type ApprovalSummaryCopy =
  | {
      kind: "shell";
      params: { surface: "host_shell" | "box_shell"; description?: string; workingDirectory?: string };
    }
  | {
      kind: "mcp";
      params: {
        description?: string;
        serverDisplayName?: string;
        toolName?: string;
        destinationHint?: string;
        action?: ApprovalMcpAction;
      };
    };

/** What the runtime asks the server to show; the server adds the presentation and lifecycle. */
export interface ApprovalRequest {
  surface: AutoReviewSurface;
  fingerprint: string;
  summary: string;
  summaryCopy?: ApprovalSummaryCopy;
  reason: string;
  actionDescription?: string;
  command?: string;
  fullRequest?: string;
  proposedRule?: string;
  proposedRuleReplaces?: string;
  cautionNote?: ApprovalCautionNote;
  appliedRules?: AutoReviewAppliedRule[];
  expiryPolicy: AutoReviewExpiryPolicy;
}
export interface ApprovalPresentation {
  /** "Allow OpenTeam to run a command?" */
  title: string;
  /** The action in one line, ending with a period. */
  line: string;
  /** The quoted instruction of a routine or meeting card. */
  quote?: string;
  /** The source row: "Terminal", "Computer", the connector's name, or "Auto-review". */
  source: string;
  sourceIcon: "terminal" | "computer" | "plug" | "shield";
  caution?: string;
}
/** The card as stored in channel-message metadata (type "approval"). */
export interface ApprovalCard extends ApprovalRequest {
  type: "approval";
  presentation: ApprovalPresentation;
  cardState: ApprovalCardState;
  expiresAt: string | null;
  resolvedAt?: string;
  /** The Allow rule an "Always allow" answer saved. */
  savedRule?: string;
  /** Why a card expired: its time ran out, or the run holding the action stopped first. */
  retired?: "ttl" | "cancelled";
}

export function parseAutoReviewSettingsUpdate(raw: unknown): { ok: true; value: Partial<AutoReviewSettings> } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Send enabled, allowRules or askFirstRules" };
  const input = raw as Record<string, unknown>;
  const value: Partial<AutoReviewSettings> = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return { ok: false, message: "enabled must be a boolean" };
    value.enabled = input.enabled;
  }
  for (const key of ["allowRules", "askFirstRules"] as const) {
    if (input[key] === undefined) continue;
    const rules = input[key];
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string"))
      return { ok: false, message: `${key} must be a list of rules` };
    const cleaned = [...new Set((rules as string[]).map((rule) => rule.trim()).filter(Boolean))];
    if (cleaned.length > AUTO_REVIEW_RULE_MAX_ENTRIES)
      return { ok: false, message: `Keep at most ${AUTO_REVIEW_RULE_MAX_ENTRIES} rules in each list` };
    if (cleaned.some((rule) => rule.length > AUTO_REVIEW_RULE_MAX_CHARS))
      return { ok: false, message: `Keep each rule under ${AUTO_REVIEW_RULE_MAX_CHARS} characters` };
    value[key] = cleaned;
  }
  if (!Object.keys(value).length) return { ok: false, message: "Send enabled, allowRules or askFirstRules" };
  return { ok: true, value };
}

/** Adds or extends the Allow rule an "Always allow" answer saves. Null when the list is full. */
export function withSavedAllowRule(rules: readonly string[], rule: string, replaces?: string): string[] | null {
  const trimmed = rule.trim().slice(0, AUTO_REVIEW_RULE_MAX_CHARS);
  if (!trimmed) return [...rules];
  const index = replaces === undefined ? -1 : rules.indexOf(replaces);
  if (index >= 0) return [...rules.slice(0, index), trimmed, ...rules.slice(index + 1)].filter((entry, at, all) => all.indexOf(entry) === at);
  if (rules.includes(trimmed)) return [...rules];
  return rules.length >= AUTO_REVIEW_RULE_MAX_ENTRIES ? null : [...rules, trimmed];
}

const ACTION_TITLES: Record<ApprovalMcpAction | "use", (bot: string, server: string) => string> = {
  delete: (bot, server) => `Allow ${bot} to delete from ${server}?`,
  send: (bot, server) => `Allow ${bot} to send from ${server}?`,
  change: (bot, server) => `Allow ${bot} to make changes in ${server}?`,
  use: (bot, server) => `Allow ${bot} to use ${server}?`,
};

/** The card's title, as the reference app words it per surface. */
export function approvalCardTitle(surface: AutoReviewSurface, summaryCopy: ApprovalSummaryCopy | undefined, botName: string): string {
  const bot = botName.trim() || "OpenTeam";
  switch (surface) {
    case "host_shell":
      return `Allow ${bot} to run a command on your computer?`;
    case "box_shell":
      return `Allow ${bot} to run a command?`;
    case "mcp": {
      const server = summaryCopy?.kind === "mcp" ? summaryCopy.params.serverDisplayName : undefined;
      return server === undefined
        ? `Allow ${bot} to use a connected app?`
        : ACTION_TITLES[(summaryCopy as Extract<ApprovalSummaryCopy, { kind: "mcp" }>).params.action ?? "use"](bot, server);
    }
    case "computer":
      return `Allow ${bot} to use its computer?`;
    case "automation_write":
      return `Allow ${bot} to save a routine?`;
    case "feedback":
      return `Allow ${bot} to send feedback?`;
  }
}

function summaryText(summary: string, copy: ApprovalSummaryCopy | undefined): string {
  if (copy === undefined) return summary;
  if (copy.kind === "shell") {
    const { description, surface, workingDirectory } = copy.params;
    const where = surface === "host_shell" ? "your local computer" : "OpenTeam's computer";
    if (description !== undefined && workingDirectory !== undefined) return `${description} on ${where} from ${workingDirectory}`;
    if (description !== undefined) return `${description} on ${where}`;
    return workingDirectory === undefined ? `Run a command on ${where}` : `Run a command on ${where} from ${workingDirectory}`;
  }
  const { description, destinationHint, serverDisplayName, toolName } = copy.params;
  if (description !== undefined)
    return serverDisplayName === undefined || description.toLowerCase().includes(serverDisplayName.toLowerCase())
      ? description
      : `${description} with ${serverDisplayName}`;
  if (toolName !== undefined && serverDisplayName !== undefined)
    return destinationHint === undefined ? `Use ${serverDisplayName} tool ${toolName}` : `Use ${serverDisplayName} tool ${toolName} for ${destinationHint}`;
  if (toolName !== undefined)
    return destinationHint === undefined ? `Use connected service tool ${toolName}` : `Use connected service tool ${toolName} for ${destinationHint}`;
  return serverDisplayName === undefined ? "Use a connected service" : `Use ${serverDisplayName}`;
}

const QUOTED = /^(.*?):\s*[“"](.*)[”"]$/su;
const OMITTED = /\S*(?:…|\.\.\.)\[\d+ chars? omitted\](?:…|\.\.\.)\S*/gu;
const TRAILING = /[.!?…。！？]+$/u;

/** The action line and, for "Save the routine …: “…”" summaries, the quoted instruction. */
export function approvalCardLine(summary: string, copy?: ApprovalSummaryCopy): { line: string; quote?: string } {
  const text = summaryText(summary, copy);
  const capitalized = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  const match = QUOTED.exec(capitalized.trim());
  const head = match?.[1]?.trim();
  const quote = match?.[2]?.replace(OMITTED, " … (shortened) ").replace(/\s+/g, " ").trim();
  const line = head && quote ? head : capitalized.trim();
  return { line: `${line.replace(TRAILING, "")}.`, ...(head && quote ? { quote } : {}) };
}

export const APPROVAL_CAUTION_TEXT: Record<ApprovalCautionNote, string> = {
  cant_undo: "This can't be undone",
  security_settings: "This changes sign-in or security settings",
  shares_data: "This shares your data outside this chat",
};

export function approvalCardPresentation(request: ApprovalRequest, botName: string): ApprovalPresentation {
  const server = request.summaryCopy?.kind === "mcp" ? request.summaryCopy.params.serverDisplayName : undefined;
  const source =
    request.surface === "host_shell" || request.surface === "box_shell"
      ? { source: "Terminal", sourceIcon: "terminal" as const }
      : request.surface === "computer"
        ? { source: "Computer", sourceIcon: "computer" as const }
        : request.surface === "mcp" && server !== undefined
          ? { source: server, sourceIcon: "plug" as const }
          : { source: "Auto-review", sourceIcon: "shield" as const };
  return {
    title: approvalCardTitle(request.surface, request.summaryCopy, botName),
    ...approvalCardLine(request.summary, request.summaryCopy),
    ...source,
    ...(request.cautionNote ? { caution: APPROVAL_CAUTION_TEXT[request.cautionNote] } : {}),
  };
}

/** The settled status chip. */
export function approvalStatusLabel(state: ApprovalCardState): string | undefined {
  switch (state) {
    case "approved":
      return "Allowed once";
    case "always":
      return "Always allowed";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "pending":
      return undefined;
  }
}

/** The line under a settled card. */
export function approvalSettledNote(card: Pick<ApprovalCard, "cardState" | "savedRule">, botName: string): string | undefined {
  const bot = botName.trim() || "OpenTeam";
  switch (card.cardState) {
    case "always":
      return card.savedRule === undefined ? "Saved to Custom Rules" : `Allowed from now on: ${card.savedRule.replace(TRAILING, "")}`;
    case "denied":
      return `${bot} won't do this`;
    case "expired":
      return `No answer in time, so ${bot} didn't do this`;
    default:
      return undefined;
  }
}
