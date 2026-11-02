import { emailBodyHtmlTag, unwrapHardWrappedEmailBody } from "@openteam/plugin-sdk/email-body";
import { parseExternalDraft, type ExternalDraft } from "./external-draft";

// The reference's DraftExternalMessage body checks (draft-external-message-schema.ts).
const SLACK_DRAFT_SYNTAX_PROBLEMS = ["slack_link", "bullet", "fence_text"] as const;
type SlackSyntaxProblem = (typeof SLACK_DRAFT_SYNTAX_PROBLEMS)[number];
const FENCE_OPENING = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const SLACK_LINK = /<https?:\/\/[^\s|>]+\|[^>]*>/i;
const SLACK_BULLET = /^\s*•/;
const FENCE_AFTER_TEXT = /\S.*?(?<!`)(`{3,})(?!`)(?=\S|$)/;
const CLOSE_AFTER_TEXT = /^(.*[^`\s])\s*(`{3,})$/;
const CLOSE_BEFORE_TEXT = /^(`{3,})([^`].*)$/;
const SLACK_SYNTAX_FIXES: Record<SlackSyntaxProblem, string> = {
  slack_link: "write each link as [label](url), not <url|label>",
  bullet: 'start each list item with "- ", not •',
  fence_text:
    "put each ``` of a code block on its own line, with nothing after the opening one but an optional language name",
};

function readFenceLine(trimmed: string, fence: { char: string; length: number }) {
  const run = /^(`+|~+)$/.exec(trimmed)?.[1];
  if (run !== undefined && run.startsWith(fence.char) && run.length >= fence.length) return "closed";
  if (fence.char !== "`") return "code";
  const after = CLOSE_AFTER_TEXT.exec(trimmed);
  if (after && after[2]!.length >= fence.length) return "closed_with_text";
  const before = CLOSE_BEFORE_TEXT.exec(trimmed);
  if (before && before[1]!.length >= fence.length) return "closed_with_text";
  return "code";
}

/** Slack's own markup in a body that is sent as standard markdown and converted for Slack. */
export function slackBodyProblems(body: string): Set<SlackSyntaxProblem> {
  const problems = new Set<SlackSyntaxProblem>();
  let fence: { char: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const state = readFenceLine(line.trim(), fence);
      if (state === "closed_with_text") problems.add("fence_text");
      if (state !== "code") fence = undefined;
      continue;
    }
    const opening = FENCE_OPENING.exec(line);
    if (opening && !(opening[1]!.startsWith("`") && opening[2]!.includes("`"))) {
      if (/\s/.test(opening[2]!.trim())) problems.add("fence_text");
      fence = { char: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const prose = line.replace(INLINE_CODE, "").trimEnd();
    if (SLACK_LINK.test(prose)) problems.add("slack_link");
    if (SLACK_BULLET.test(line.replace(INLINE_CODE, "x"))) problems.add("bullet");
    const strayFence = FENCE_AFTER_TEXT.exec(prose);
    if (strayFence) {
      problems.add("fence_text");
      fence = { char: "`", length: strayFence[1]!.length };
    }
  }
  return problems;
}

/** Why the model's body can't go on a card as written, or undefined when it can. */
export function draftBodyRefusal(draft: { platform?: unknown; body?: unknown }): string | undefined {
  if (typeof draft.body !== "string") return undefined;
  if (draft.platform === "email") {
    const tag = emailBodyHtmlTag(draft.body);
    // The reference ends with "If the user asked for formatting, put the HTML version in
    // htmlBody."; OpenTeam drafts have no htmlBody.
    return tag
      ? `body is plain text, so ${tag} would reach the recipient as literal text. Nothing was drafted. Rewrite body as plain text: blank lines between paragraphs, "- " before list items.`
      : undefined;
  }
  if (draft.platform !== "slack") return undefined;
  const problems = slackBodyProblems(draft.body);
  if (!problems.size) return undefined;
  const fixes = SLACK_DRAFT_SYNTAX_PROBLEMS.filter((problem) => problems.has(problem)).map(
    (problem) => SLACK_SYNTAX_FIXES[problem]
  );
  return `body is standard markdown that is converted for Slack, so Slack's own syntax in it would not render as written. Nothing was drafted. Fix body and call this tool again: ${fixes.join("; ")}.`;
}

/** The body check as a zod refinement, for the captured argument schema. */
export function refineDraftBody(
  value: { platform?: unknown; body?: unknown },
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void }
) {
  const message = draftBodyRefusal(value);
  if (message) ctx.addIssue({ code: "custom", path: ["body"], message });
}

/**
 * DraftExternalMessage as the model calls it: the body checks, then the hard-wrap unwrap the
 * reference applies to an email draft before its card shows. User edits on the card go through
 * parseExternalDraft alone and are never rewritten.
 */
export function parseDraftExternalMessage(raw: unknown): ExternalDraft {
  const draft = parseExternalDraft(raw);
  const refusal = draftBodyRefusal(draft);
  if (refusal) throw new Error(refusal);
  return draft.platform === "email" ? { ...draft, body: unwrapHardWrappedEmailBody(draft.body) } : draft;
}
