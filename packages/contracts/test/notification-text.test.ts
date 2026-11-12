import { describe, expect, test } from "bun:test";
import {
  agentNotificationPresentation,
} from "../src";

describe("notification text", () => {
  test("defines one exact presentation and delivery policy for every agent notification type", () => {
    expect(
      agentNotificationPresentation({
        kind: "message",
        botName: "  Probe  ",
        body: "  Finished\nthe   command  ",
      })
    ).toEqual({ title: "Probe", body: "Finished the command", sound: "default" });
    expect(agentNotificationPresentation({ kind: "message", botName: "Probe" })).toEqual({
      title: "Probe",
      body: "Open OpenTeam to see what it did.",
      sound: "default",
    });
    expect(agentNotificationPresentation({ kind: "reaction", botName: "" })).toEqual({
      title: "OpenTeam",
      body: "Reacted to your message.",
      sound: "default",
    });
  });

});
