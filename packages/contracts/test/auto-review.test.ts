import { expect, test } from "bun:test";
import {
  approvalCardLine,
  approvalCardPresentation,
  approvalSettledNote,
  parseAutoReviewSettingsUpdate,
  withSavedAllowRule,
} from "../src/auto-review";

test("settings keep at most 20 trimmed, distinct rules of up to 1,000 characters", () => {
  expect(parseAutoReviewSettingsUpdate({ enabled: false, allowRules: [" Emails to a@x.com ", "Emails to a@x.com", ""] })).toEqual({
    ok: true,
    value: { enabled: false, allowRules: ["Emails to a@x.com"] },
  });
  expect(parseAutoReviewSettingsUpdate({ askFirstRules: Array.from({ length: 21 }, (_, i) => `rule ${i}`) })).toMatchObject({ ok: false });
  expect(parseAutoReviewSettingsUpdate({ allowRules: ["x".repeat(1001)] })).toMatchObject({ ok: false });
  expect(parseAutoReviewSettingsUpdate({ enabled: "yes" })).toMatchObject({ ok: false });
  expect(parseAutoReviewSettingsUpdate({})).toMatchObject({ ok: false });
});

test("an Always allow answer adds the proposed rule or extends the one it replaces", () => {
  expect(withSavedAllowRule(["Emails to a@x.com"], "Emails to a@x.com or b@y.com", "Emails to a@x.com")).toEqual(["Emails to a@x.com or b@y.com"]);
  expect(withSavedAllowRule(["A"], "B")).toEqual(["A", "B"]);
  expect(withSavedAllowRule(["A"], "A")).toEqual(["A"]);
  expect(withSavedAllowRule(Array.from({ length: 20 }, (_, i) => `r${i}`), "new")).toBeNull();
});

test("cards read like the reference app's", () => {
  expect(
    approvalCardPresentation(
      {
        surface: "mcp",
        fingerprint: "x",
        summary: "ignored",
        summaryCopy: { kind: "mcp", params: { description: "Post the launch note in #eng", serverDisplayName: "Slack", action: "send" } },
        reason: "Post a message to #eng. Others will see it.",
        cautionNote: "shares_data",
        expiryPolicy: "park",
      },
      "Ada"
    )
  ).toEqual({
    title: "Allow Ada to send from Slack?",
    line: "Post the launch note in #eng with Slack.",
    source: "Slack",
    sourceIcon: "plug",
    caution: "This shares your data outside this chat",
  });
  expect(approvalCardLine("Save the routine “Digest” to run every weekday at 9:00: “Email me the summary”")).toEqual({
    line: "Save the routine “Digest” to run every weekday at 9:00.",
    quote: "Email me the summary",
  });
  expect(approvalCardPresentation({ surface: "host_shell", fingerprint: "x", summary: "s", summaryCopy: { kind: "shell", params: { surface: "host_shell" } }, reason: "r", expiryPolicy: "ttl" }, "").title).toBe(
    "Allow OpenTeam to run a command on your computer?"
  );
  expect(approvalSettledNote({ cardState: "denied" }, "Ada")).toBe("Ada won't do this");
  expect(approvalSettledNote({ cardState: "expired" }, "Ada")).toBe("No answer in time, so Ada didn't do this");
  expect(approvalSettledNote({ cardState: "always", savedRule: "Emails to a@x.com." }, "Ada")).toBe("Allowed from now on: Emails to a@x.com");
});
