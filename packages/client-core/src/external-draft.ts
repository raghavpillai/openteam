import { editExternalDraft, type ExternalDraft } from "@openteam/contracts/external-draft";

export type ExternalDraftReviewAction = "send" | "cancel" | "refresh" | "approval";

export interface ExternalDraftReviewFields {
  body: string;
  subject: string;
  to: string;
  cc: string;
  from: string;
}

export function externalDraftReviewFields(draft: ExternalDraft): ExternalDraftReviewFields {
  return { body: draft.body, subject: draft.subject ?? "", to: draft.to?.join(", ") ?? "",
    cc: draft.cc?.join(", ") ?? "", from: draft.from ?? "" };
}

/** Follow another device's saved edits without replacing this device's unsaved fields. */
export function mergeExternalDraftReviewFields(
  previous: ExternalDraftReviewFields,
  local: ExternalDraftReviewFields,
  incoming: ExternalDraftReviewFields
): ExternalDraftReviewFields {
  let next = local;
  for (const key of Object.keys(local) as Array<keyof ExternalDraftReviewFields>)
    if (local[key] === previous[key] && local[key] !== incoming[key])
      next = { ...next, [key]: incoming[key] };
  return next;
}

/** A late response or event cannot restore controls on an already settled card. */
export function externalDraftReviewState(current: string, incoming: string): string {
  return current === "pending" || current === "sending" ? incoming : current;
}

/** Normalize the editable fields identically on desktop and mobile. Routing is immutable. */
export function externalDraftReviewEdits(
  draft: ExternalDraft,
  action: ExternalDraftReviewAction,
  fields: { body: string; subject: string; to: string; cc: string; from?: string },
  sendingAddresses: string[] = []
) {
  if (action !== "send" && action !== "approval") return undefined;
  const recipients = (text: string) =>
    text
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const edits = {
    body: fields.body,
    ...(draft.platform === "email"
      ? {
          subject: fields.subject,
          to: recipients(fields.to),
          cc: recipients(fields.cc),
          ...(fields.from && fields.from.toLowerCase() !== draft.from?.toLowerCase() ? { from: fields.from } : {}),
        }
      : {}),
  };
  editExternalDraft(draft, edits, sendingAddresses);
  return edits;
}
