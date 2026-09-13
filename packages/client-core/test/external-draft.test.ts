import { expect, test } from "bun:test";
import type { ExternalDraft } from "@openteam/contracts/external-draft";
import { externalDraftReviewEdits } from "../src/external-draft";

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
  expect(() => externalDraftReviewEdits(draft, "save", { ...fields, to: "" })).toThrow(
    "Invalid draft to"
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
