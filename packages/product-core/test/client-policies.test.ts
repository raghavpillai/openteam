import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, RoutineView } from "@openteam/contracts";
import {
  classifyDurableSendError,
  durableSendStatusLabel,
  durableSendRenderKey,
  formatOfflineDeliveryLabel,
  formatOfflineDeliveryTimestamp,
  messageDeliveryAcceptance,
  routineScheduleEditMode,
  routineSchedulePatch,
} from "../src";

const acceptedMessage: ChannelMessageView = {
  id: "message-1",
  clientId: "client-1",
  sequence: "1",
  channelId: "channel-1",
  sender: "user",
  senderBotId: null,
  sourceRunId: null,
  content: "hello",
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
};

const routine = (overrides: Partial<RoutineView> = {}): RoutineView => ({
  id: "routine-1",
  folder: "routines/routine-1",
  ownerId: "bot-1",
  ownerKind: "bot",
  botId: "bot-1",
  channelId: "channel-1",
  name: "Daily brief",
  prompt: "Summarize the day",
  schedule: "0 9 * * *",
  schedules: ["0 9 * * *"],
  scheduleKind: "cron",
  cronExpression: "0 9 * * *",
  intervalSeconds: null,
  timezone: "America/New_York",
  timezoneMode: "fixed",
  enabled: true,
  revision: 2,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  latestExecution: null,
  triggerPresentation: null,
  ...overrides,
});

describe("shared client presentation and editing policy", () => {;

  test("never flattens event or composite schedules from a simple client", () => {
    const event = routine({ scheduleKind: "event", schedule: "event:github", schedules: [] });
    const composite = routine({
      schedules: ["0 9 * * *", "0 17 * * *"],
      trigger: { type: "group", operator: "any", children: [] },
    });
    expect(routineScheduleEditMode(null)).toBe("editable");
    expect(routineScheduleEditMode(event)).toBe("event");
    expect(routineScheduleEditMode(composite)).toBe("composite");
    expect(routineSchedulePatch(event, "0 8 * * *")).toEqual({});
    expect(routineSchedulePatch(composite, "0 8 * * *")).toEqual({});
    expect(routineSchedulePatch(routine(), " 0 8 * * * ")).toEqual({ schedule: "0 8 * * *" });
  });

  test("shares durable transport classification and delivery-status mapping", () => {
    expect(classifyDurableSendError({ code: "offline", status: 0 })).toBe("offline");
    expect(classifyDurableSendError({ status: 503 })).toBe("ambiguous");
    expect(classifyDurableSendError({ status: 400 })).toBe("fatal");
    expect(classifyDurableSendError(new Error("connection lost"))).toBe("ambiguous");
    expect(
      messageDeliveryAcceptance({
        clientId: "client-1",
        status: "accepted",
        acceptedAtMs: null,
        message: acceptedMessage,
      })
    ).toEqual({
      status: "accepted",
      acceptedAtMs: Date.parse(acceptedMessage.createdAt),
      message: acceptedMessage,
    });
    expect(
      messageDeliveryAcceptance({
        clientId: "client-2",
        status: "accepted",
        acceptedAtMs: null,
        message: null,
      })
    ).toEqual({ status: "unknown_durability" });
    expect(formatOfflineDeliveryTimestamp(Date.parse(acceptedMessage.createdAt), "en-US")).not.toBe(
      ""
    );
    expect(durableSendStatusLabel("queued", true)).toBe("Will send when reconnected");
    expect(durableSendStatusLabel("failed")).toBe("Failed to send");
    expect(durableSendRenderKey({ nonce: "client-1" })).toBe("optimistic:client-1");
    expect(formatOfflineDeliveryLabel(Date.parse(acceptedMessage.createdAt), "en-US")).toStartWith(
      "Sent while offline · "
    );
  });

});
