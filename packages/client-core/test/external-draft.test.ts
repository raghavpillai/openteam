import { expect, test } from "bun:test";
import type { ExternalDraft } from "@openteam/contracts/external-draft";
import { externalDraftReviewEdits, externalDraftReviewFields, externalDraftReviewState, mergeExternalDraftReviewFields } from "../src/external-draft";

test("review edits normalize recipients while preserving the verified account and route", () => {
  const draft: ExternalDraft = {
    platform: "email",
    providerIdentifier: "gmail-fixture",
    from: "sender@example.com",
    to: ["old@example.com"],
    subject: "Original",
    body: "Original",
    replyToMessageId: "thread-fixture",
  };
  const fields = {
    body: "Edited",
    subject: "Updated",
    to: " first@example.com, ,second@example.com ",
    cc: "",
  };
  expect(externalDraftReviewEdits(draft, "send", fields)).toEqual({
    body: "Edited",
    subject: "Updated",
    to: ["first@example.com", "second@example.com"],
    cc: [],
  });
  expect(() => externalDraftReviewEdits(draft, "send", { ...fields, to: "" })).toThrow(
    "Invalid draft to"
  );
  expect(externalDraftReviewEdits(draft, "send", { ...fields, from: "Alias@Example.com" }, ["alias@example.com"])).toMatchObject({ from: "Alias@Example.com" });
  expect(() => externalDraftReviewEdits(draft, "send", { ...fields, from: "other@example.com" }, ["alias@example.com"])).toThrow(
    "verified addresses"
  );
  expect(externalDraftReviewEdits(draft, "cancel", { ...fields, to: "" })).toBeUndefined();
  expect(draft.to).toEqual(["old@example.com"]);
});

test("Slack reviews send only the edited body", () => {
  const draft: ExternalDraft = {
    platform: "slack",
    providerIdentifier: "slack-fixture",
    target: "general",
    channelId: "C12345678",
    threadTs: "123.456",
    body: "Original",
  };
  expect(
    externalDraftReviewEdits(draft, "send", {
      body: "Edited",
      subject: "ignored",
      to: "ignored",
      cc: "ignored",
    })
  ).toEqual({ body: "Edited" });
});

test("another device updates untouched review fields without replacing local edits", () => {
  const previous = externalDraftReviewFields({ platform: "email", providerIdentifier: "fixture", from: "me@example.com", to: ["ann@example.com"], cc: [], subject: "Original", body: "Original body" });
  const local = { ...previous, body: "Unsaved local body", cc: "local-copy@example.com" };
  const remote = { ...previous, from: "alias@example.com", to: "remote@example.com", subject: "Remote subject", body: "Remote body", cc: "remote-copy@example.com" };
  const merged = mergeExternalDraftReviewFields(previous, local, remote);
  expect(merged).toEqual({ ...remote, body: local.body, cc: local.cc });
  const later = { ...remote, to: "later@example.com", body: "Later remote body" };
  // Continue following pristine fields through later snapshots, while a local
  // field that now matches the last saved version becomes pristine again.
  expect(mergeExternalDraftReviewFields(remote, { ...merged, body: remote.body }, later))
    .toEqual({ ...later, cc: local.cc });
  expect(mergeExternalDraftReviewFields(remote, merged, remote)).toBe(merged);
});

test("terminal review outcomes cannot be undone by late responses or events", () => {
  expect(externalDraftReviewState("pending", "sending")).toBe("sending");
  expect(externalDraftReviewState("sending", "pending")).toBe("pending");
  for (const terminal of ["sent", "dismissed", "unknown", "failed", "draft-created"]) {
    expect(externalDraftReviewState("pending", terminal)).toBe(terminal);
    expect(externalDraftReviewState("sending", terminal)).toBe(terminal);
    for (const stale of ["pending", "sending", "sent", "dismissed", "unknown", "failed"])
      expect(externalDraftReviewState(terminal, stale)).toBe(terminal);
  }
});
