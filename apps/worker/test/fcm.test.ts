import { describe, expect, test } from "bun:test";
import { fcmConfigurationIssues, fcmConfigurationStatus, fcmPayload, FcmClient } from "../src/fcm";

const token = "fcm-token_" + "A".repeat(40);
const device = { pushToken: token, notificationScope: "ab".repeat(32) };
const payload = {
  schemaVersion: 1 as const,
  kind: "message" as const,
  botId: "bot-1",
  channelId: "channel-1",
  runId: "run-1",
  title: "Research",
  body: "A new answer",
  badgeCount: 3,
  messageSequence: "12",
  notificationSequence: "12",
  threadMessageId: undefined,
};

describe("FCM delivery", () => {
  test("reports missing and malformed service-account configuration without exposing secrets", () => {
    expect(fcmConfigurationStatus({}).issues).toEqual([
      "OPENTEAM_FCM_PROJECT_ID is missing",
      "OPENTEAM_FCM_CLIENT_EMAIL is missing",
      "OPENTEAM_FCM_PRIVATE_KEY is missing",
    ]);
    expect(fcmConfigurationIssues({
      projectId: "BAD PROJECT", clientEmail: "owner@example.test", privateKey: "private-value",
    })).toEqual(["project ID format is invalid", "client email format is invalid", "private key must be a PEM service-account key"]);
  });

  test("builds a data-compatible Android payload without changing opaque token case", () => {
    const value = fcmPayload(device, payload, 3, "delivery-1");
    expect(value.message.token).toBe(token);
    expect(value.message.data).toMatchObject({ kind: "message", badgeCount: "3", messageSequence: "12" });
    expect(value.message.notification).toEqual({ title: "Research", body: "A new answer" });
  });

  test("encodes a badge sync as data so Android can merge the durable read marker", () => {
    const value = fcmPayload(device, {
      schemaVersion: 1,
      kind: "badge-sync",
      badgeCount: 4,
      readState: { channelId: "channel-1", lastReadSequence: "12", lastReadNotificationSequence: "9" },
    }, 4, "read-sync");
    expect(value.message.notification).toBeUndefined();
    expect(value.message.data).toMatchObject({ kind: "badge-sync", readState: JSON.stringify({
      channelId: "channel-1", lastReadSequence: "12", lastReadNotificationSequence: "9",
    }) });
  });

  test("uses an injected transport without requiring Firebase credentials", async () => {
    let request: { authority: string; headers: Record<string, string>; body: string } | undefined;
    const client = new FcmClient(
      { projectId: "project", clientEmail: "owner@project.iam.gserviceaccount.com", privateKey: "private-value" },
      async (authority, headers, body) => {
        request = { authority, headers, body };
        return { status: 200 };
      },
      "test-access-token",
    );
    await expect(client.send(device, payload, 0, "delivery-1")).resolves.toEqual({ status: 200 });
    expect(request?.authority).toBe("https://fcm.googleapis.com/v1/projects/project/messages:send");
    expect(request?.headers.authorization).toBe("Bearer test-access-token");
  });
});
