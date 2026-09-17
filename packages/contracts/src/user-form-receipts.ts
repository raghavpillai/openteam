import { buildUserFormSubmittedAck, buildUserFormDismissedAck } from "./reference-form-results";
import type { UserFormReceipt } from "./review-cards";

export function formatUserFormReceipt(receipt: UserFormReceipt): string {
  if (receipt.status === "escalated") return `The user chose to complete ${receipt.title ? `“${receipt.title}”` : "the form"} on the screen instead. Nothing was filled and no secret values were returned.`;
  if (receipt.title && !receipt.interrupted) {
    const form = { title: receipt.title, domain: receipt.domain, submitAfterFill: receipt.requestedSubmit,
      fields: receipt.fields.map(field => ({id:field.id,type:receipt.fieldTypes?.[field.id] ?? "text"})) };
    if (receipt.status === "dismissed") return buildUserFormDismissedAck(form);
    const held = receipt.fields.filter(field => field.status === "held").map(field => field.id);
    return buildUserFormSubmittedAck(form, receipt.fields.map(field => ({id:field.id,filled:field.status === "filled",fillFailed:["held","dropped","unknown"].includes(field.status)})), receipt.domainMismatch,
      {attempted:receipt.submitAttempted,succeeded:receipt.submitSucceeded}, receipt.fillFailureKinds,
      receipt.pageMoved ? {...receipt.pageMoved,valueScrubbedFreshSnapshot:receipt.snapshot} : undefined,
      held.length ? {fieldIds:held,valueScrubbedFreshSnapshot:receipt.snapshot} : undefined);
  }
  return [
    `User form ${receipt.formId}: ${receipt.status}. No submitted values are returned.`,
    ...(receipt.interrupted
      ? [
          "The host was interrupted during this fill. Some values or the Enter press may have reached the page. Inspect the browser before retrying; the host will not automatically repeat the action.",
        ]
      : []),
    ...receipt.fields.map((field) => `- ${field.id}: ${field.status.toUpperCase()}`),
    ...(receipt.heldUntil
      ? [
          `Held values expire at ${receipt.heldUntil}. Use remap_user_form_targets only for HELD fields; omitted fields are discarded.`,
        ]
      : []),
    ...(receipt.submitAttempted
      ? [`Enter-submit: ${receipt.submitSucceeded ? "succeeded" : "failed"}.`]
      : []),
    ...(receipt.snapshot ? [receipt.snapshot] : []),
  ].join("\n");
}
