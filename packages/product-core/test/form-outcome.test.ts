import { expect, test } from "bun:test";
import { userFormOutcome } from "../src/rich-messages";
const form = {
  title: "Sign in",
  instruction: "Fixture",
  fields: [{ id: "password", label: "Password", type: "password" as const }],
};
test("partial and uncertain forms show actionable status without values, snapshots or unknown fields", () => {
  const outcome = userFormOutcome(form, {
    cardState: "submitted",
    formReceipt: {
      fields: [
        { id: "password", status: "held", value: "private" },
        { id: "private", status: "filled" },
      ],
      snapshot: "private",
    },
  });
  expect(outcome.fields).toEqual([
    { id: "password", label: "Password", status: "Held for recovery" },
  ]);
  expect(outcome.summary).toContain("recover held fields");
  expect(JSON.stringify(outcome)).not.toContain("private");
  expect(
    userFormOutcome(form, { cardState: "submitted", formReceipt: { interrupted: true } }).summary
  ).toContain("interrupted");
  expect(
    userFormOutcome(form, {
      cardState: "submitted",
      formReceipt: { submitAttempted: true, submitSucceeded: false },
    }).summary
  ).toContain("pressing Enter failed");
});
