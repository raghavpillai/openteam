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
test("dismissed, expired and failed cards never claim success", () => {
  for (const cardState of ["dismissed", "expired", "fill_failed", "escalated"])
    expect(userFormOutcome(form, { cardState }).summary).not.toContain("Form submitted");
});

test("question drafts survive remounts, isolate scopes, clear after settlement and stay bounded", async () => {
  const { createWidgetDraftStore } = await import("../src/rich-messages");
  const store = createWidgetDraftStore(2);
  store.write("server-a:question", "My answer", new Set(["alpha"]));
  expect(store.read("server-a:question")).toEqual({ custom: "My answer", selected: ["alpha"] });
  expect(store.read("server-b:question").custom).toBe("");
  store.read("server-a:question").selected.push("mutated");
  expect(store.read("server-a:question").selected).toEqual(["alpha"]);
  store.write("second", "second", new Set());
  store.write("third", "third", new Set());
  expect(store.read("server-a:question").custom).toBe("");
  store.clear("third");
  expect(store.read("third").custom).toBe("");
});
