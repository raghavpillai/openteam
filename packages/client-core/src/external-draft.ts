import { editExternalDraft, type ExternalDraft } from "@openteam/contracts/external-draft";

export type ExternalDraftReviewAction = "save" | "send" | "cancel" | "refresh";

/** Normalize the editable fields identically on desktop and mobile. Routing is immutable. */
export function externalDraftReviewEdits(
  draft: ExternalDraft,
  action: ExternalDraftReviewAction,
  fields: { body: string; subject: string; to: string; cc: string }
) {
  if (action !== "save" && action !== "send") return undefined;
  const recipients = (text: string) =>
    text
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const edits = {
    body: fields.body,
    ...(draft.platform === "email"
      ? { subject: fields.subject, to: recipients(fields.to), cc: recipients(fields.cc) }
      : {}),
  };
  editExternalDraft(draft, edits);
  return edits;
}
