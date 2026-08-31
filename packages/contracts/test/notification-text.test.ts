import { describe, expect, test } from "bun:test";
import {
  agentNotificationPresentation,
  notificationGraphemes,
  notificationMessageInputReason,
  notificationMessagePreview,
  truncateNotificationText,
} from "../src";

describe("notification text", () => {
  test("defines one exact presentation and delivery policy for every agent notification type", () => {
    expect(
      agentNotificationPresentation({
        kind: "agent-needs-input",
        botName: "  Probe  ",
        body: "  Approve\nthis   command  ",
      })
    ).toEqual({
      title: "Probe needs you",
      body: "Approve this command",
      sound: "default",
      urgency: "critical",
    });
    expect(agentNotificationPresentation({ kind: "agent-needs-input", botName: "Probe" })).toEqual({
      title: "Probe needs you",
      body: "Waiting for your input.",
      sound: "default",
      urgency: "critical",
    });
    expect(
      agentNotificationPresentation({ kind: "agent-done", botName: "Probe", body: "Finished" })
    ).toEqual({
      title: "Probe",
      body: "Finished",
      sound: null,
      urgency: "normal",
    });
    expect(agentNotificationPresentation({ kind: "agent-done", botName: "Probe" })).toEqual({
      title: "Probe",
      body: "Open OpenBot to see what it did.",
      sound: null,
      urgency: "normal",
    });
  });

  test("keeps extended grapheme clusters intact at the 140-character boundary", () => {
    const family = "👨‍👩‍👧‍👦";
    const value = truncateNotificationText(family.repeat(145));
    expect(notificationGraphemes(value)).toHaveLength(140);
    expect(value.endsWith("…")).toBe(true);
    expect(value.slice(0, -1)).toBe(family.repeat(139));
  });

  test("provides useful structured fallbacks for attachment-only messages", () => {
    expect(
      notificationMessagePreview({
        content: "",
        metadata: {
          attachments: [
            { kind: "image", mimeType: "image/png" },
            { kind: "image", mimeType: "image/jpeg" },
          ],
        },
      })
    ).toBe("Sent 2 images.");
    expect(notificationMessagePreview({ content: "", metadata: { type: "secret_request" } })).toBe(
      "Waiting for your input."
    );
  });

  test("classifies interactive and secret messages as needs-input reasons", () => {
    expect(
      notificationMessageInputReason({
        content: "Deploy to production?",
        metadata: { type: "widget" },
      })
    ).toBe("Deploy to production?");
    expect(
      notificationMessageInputReason({ content: "", metadata: { type: "secret-request" } })
    ).toBe("Waiting for your input.");
    expect(
      notificationMessageInputReason({ content: "Finished", metadata: { type: "text" } })
    ).toBeNull();
  });
});
