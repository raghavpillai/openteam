import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import type { AgentNotificationPayload } from "@openteam/contracts";
import { ApnsClient, apnsPayload, type ApnsTransport } from "../src/apns";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = {
  keyId: "QAKEY",
  teamId: "QATEAM",
  topic: "dev.openteam.mobile.swift",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const device = {
  pushToken: "a".repeat(64),
  apnsTopic: config.topic,
  apnsEnvironment: "development",
  notificationScope: "b".repeat(64),
};
const alert: AgentNotificationPayload = {
  schemaVersion: 1,
  kind: "message",
  title: "Our robot",
  body: "Reply ready",
  channelId: "channel",
  botId: "bot",
  runId: "run",
  badgeCount: 2,
  messageSequence: "9007199254740993",
  notificationSequence: "24",
  sender: { name: "Our robot", icon: "chip", color: "#ff6600" },
};

describe("native APNs delivery", () => {
  test("signs a verifiable ES256 token and sends sandbox alerts with read identity", async () => {
    const transport: ApnsTransport = async (authority, headers, body) => {
      expect(authority).toBe("https://api.sandbox.push.apple.com");
      expect(headers).toMatchObject({
        "apns-topic": config.topic,
        "apns-priority": "10",
        "apns-push-type": "alert",
        ":path": "/3/device/" + device.pushToken,
      });
      const jwt = headers.authorization!.slice(7).split(".");
      expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: "QAKEY",
      });
      expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss).toBe("QATEAM");
      expect(
        verify(
          "sha256",
          Buffer.from(jwt.slice(0, 2).join(".")),
          { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(jwt[2]!, "base64url")
        )
      ).toBe(true);
      const payload = JSON.parse(body);
      expect(payload.aps).toMatchObject({
        alert: { title: "Our robot", body: "Reply ready" },
        badge: 3,
        "mutable-content": 1,
        "thread-id": "channel",
      });
      expect(payload.aps.sound).toBe("default");
      expect(payload.data).toMatchObject({
        notificationScope: device.notificationScope,
        messageSequence: "9007199254740993",
        notificationSequence: "24",
        sender: alert.sender,
      });
      return { status: 200 };
    };
    expect(await new ApnsClient(config, transport).send(device, alert, 3, "delivery")).toEqual({
      status: 200,
    });
  });
  test("desktop reads use production background delivery without a visible alert or stale badge", async () => {
    const transport: ApnsTransport = async (authority, headers, body) => {
      expect(authority).toBe("https://api.push.apple.com");
      expect(headers["apns-priority"]).toBe("5");
      expect(headers["apns-push-type"]).toBe("background");
      const value = JSON.parse(body);
      expect(value.aps).toEqual({ "content-available": 1 });
      expect(value.data.readState.lastReadNotificationSequence).toBe("24");
      expect(value.data.badgeCount).toBe(0);
      return { status: 200 };
    };
    await new ApnsClient(config, transport).send(
      { ...device, apnsEnvironment: "production" },
      {
        schemaVersion: 1,
        kind: "badge-sync",
        badgeCount: 99,
        readState: {
          channelId: "channel",
          lastReadSequence: alert.messageSequence!,
          lastReadNotificationSequence: "24",
        },
      },
      0,
      "read"
    );
  });
  test("coalesces reads across channels but keeps separate message deliveries", async () => {
    const ids: string[] = [];
    const client = new ApnsClient(config, async (_, headers) => {
      ids.push(headers["apns-collapse-id"]!);
      return { status: 200 };
    });
    for (const key of ["a", "b"])
      await client.send(device, { schemaVersion: 1, kind: "badge-sync", badgeCount: 0 }, 0, key);
    for (const key of ["a", "b", "b"]) await client.send(device, alert, 1, key);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[3]);
    expect(ids[3]).toBe(ids[4]);
    expect(ids.every((id) => Buffer.byteLength(id) <= 64)).toBe(true);
  });
  test("bounds UTF-8 payloads while preserving routing and sound policy", async () => {
    const heavy = "👨‍👩‍👧‍👦".repeat(500);
    const client = new ApnsClient(config, async (_, __, body) => {
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
      const value = JSON.parse(body);
      expect(value.data.channelId).toBe("channel");
      expect(value.aps.sound).toBe("default");
      return { status: 200 };
    });
    await client.send(
      device,
      {
        ...alert,
        kind: "reaction",
        title: heavy,
        body: heavy,
        sender: { ...alert.sender!, name: heavy },
      },
      1,
      "large"
    );
  });
  test("carries thread and exact message identity only when the alert has them", () => {
    const data = (extra: Partial<AgentNotificationPayload> = {}) => apnsPayload(device, { ...alert, ...extra }, 2).data as Record<string, unknown>;
    expect(data({ threadMessageId: "reply-1" }).threadMessageId).toBe("reply-1");
    // Alerts outside the newest history page open the exact message.
    expect(data({ messageId: "older-message" })).toMatchObject({ messageId: "older-message", messageSequence: alert.messageSequence });
    expect(data().threadMessageId).toBeUndefined();
    expect(data().messageId).toBeUndefined();
  });
  test("rejects a mismatched app, invalid environment, token or signing key without sending", async () => {
    let requests = 0;
    const transport: ApnsTransport = async () => {
      requests++;
      return { status: 200 };
    };
    for (const invalid of [
      { ...device, apnsTopic: "another.app" },
      { ...device, apnsEnvironment: "unknown" },
      { ...device, pushToken: "zz".repeat(32) },
      { ...device, notificationScope: null },
    ]) {
      await expect(
        new ApnsClient(config, transport).send(invalid, alert, 1, "invalid")
      ).rejects.toThrow();
    }
    await expect(
      new ApnsClient({ ...config, privateKey: "invalid-private-key" }, transport).send(
        device,
        alert,
        1,
        "invalid-key"
      )
    ).rejects.toThrow("P-256");
    expect(requests).toBe(0);
  });
});
