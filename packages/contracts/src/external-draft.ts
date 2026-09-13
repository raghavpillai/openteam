export interface ExternalDraft {
  platform: "email" | "slack";
  providerIdentifier: string;
  body: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  replyToMessageId?: string;
  target?: string;
  channelId?: string;
  threadTs?: string;
}
export function parseExternalDraft(raw: unknown): ExternalDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("A draft object is required");
  const value = raw as Record<string, unknown>;
  if (!["email", "slack"].includes(String(value.platform)))
    throw new Error("Choose email or slack");
  const text = (key: string, required = false, maximum = 2000) => {
    if (value[key] === undefined && !required) return undefined;
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > maximum)
      throw new Error(`Invalid draft ${key}`);
    return value[key].trim();
  };
  const address = (input: unknown): string => {
    if (
      typeof input !== "string" ||
      !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.trim()) ||
      input.length > 320
    )
      throw new Error("Use plain email addresses");
    return input.trim();
  };
  const addresses = (key: string, required = false) => {
    if (value[key] === undefined && !required) return undefined;
    if (!Array.isArray(value[key]) || value[key].length > 100 || (required && !value[key].length))
      throw new Error(`Invalid draft ${key}`);
    return value[key].map(address);
  };
  const draft: ExternalDraft = {
    platform: value.platform as ExternalDraft["platform"],
    providerIdentifier: text("providerIdentifier", true, 256)!,
    body: text("body", true, 100_000)!,
  };
  for (const key of draft.platform === "email"
    ? ["target", "channelId", "threadTs"]
    : ["from", "to", "cc", "subject", "replyToMessageId"]) {
    if (
      value[key] !== undefined &&
      value[key] !== "" &&
      (!Array.isArray(value[key]) || value[key].length)
    )
      throw new Error(`${key} does not belong to ${draft.platform} drafts`);
  }
  if (draft.platform === "email")
    Object.assign(draft, {
      from: address(value.from),
      to: addresses("to", true),
      cc: addresses("cc"),
      subject: text("subject", true),
      replyToMessageId: text("replyToMessageId"),
    });
  else {
    Object.assign(draft, {
      target: text("target", true),
      channelId: text("channelId", true),
      threadTs: text("threadTs"),
    });
    if (!/^[CDGU][A-Z0-9]{8,}$/i.test(draft.channelId!))
      throw new Error("Use a resolved Slack channel or conversation ID");
    if (draft.threadTs && !/^\d+\.\d+$/.test(draft.threadTs))
      throw new Error("Invalid Slack thread timestamp");
  }
  return draft;
}

/** The user edits content and email recipients; account and thread route stay fixed. */
export function editExternalDraft(saved: ExternalDraft, edits: unknown): ExternalDraft {
  if (!edits || typeof edits !== "object" || Array.isArray(edits))
    throw new Error("Invalid draft edits");
  const allowed = saved.platform === "email" ? ["body", "to", "cc", "subject"] : ["body"];
  if (Object.keys(edits).some((key) => !allowed.includes(key)))
    throw new Error("The sending account and thread cannot be changed on a draft card");
  return parseExternalDraft({ ...saved, ...edits });
}

/** Preserve plain prose and line breaks; autolink only literal HTTP(S) URLs. */
export function externalDraftHtml(body: string): string {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
    );
  const prose = (text: string) => escape(text).replace(/\n/g, "<br>");
  const text = body.replace(/\r\n?/g, "\n");
  let result = "",
    offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    let url = match[0];
    while (
      /[.,;:!?]$/.test(url) ||
      (url.endsWith(")") && url.split("(").length < url.split(")").length)
    )
      url = url.slice(0, -1);
    result += `${prose(text.slice(offset, match.index))}<a href="${escape(url)}">${escape(url)}</a>`;
    offset = match.index! + url.length;
  }
  return `<div dir="auto">${result}${prose(text.slice(offset))}</div>`;
}
