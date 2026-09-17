import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import {
  agentNotificationDeliveryPolicy,
  truncateNotificationText,
  type PushNotificationPayload,
} from "@openteam/contracts";

export interface ApnsDevice {
  pushToken: string;
  apnsTopic: string | null;
  apnsEnvironment: string | null;
  notificationScope: string | null;
}
export interface ApnsResult {
  status: number;
  reason?: string;
}
export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  topic: string;
  privateKey: string;
}
export type ApnsTransport = (
  authority: string,
  headers: Record<string, string>,
  body: string
) => Promise<ApnsResult>;

export function apnsPayload(
  device: ApnsDevice,
  payload: PushNotificationPayload,
  badgeCount: number
) {
  const badge = Math.max(0, Math.floor(badgeCount));
  if (payload.kind === "badge-sync") {
    // A real background push has no alert, sound or badge in aps. The receiver
    // applies the badge after fetching the authoritative cross-device read state.
    return {
      aps: { "content-available": 1 },
      data: {
        schemaVersion: 1,
        kind: payload.kind,
        notificationScope: device.notificationScope,
        badgeCount: badge,
        readState: payload.readState,
      },
    };
  }
  return {
    aps: {
      alert: {
        title: truncateNotificationText(payload.title, 80),
        body: truncateNotificationText(payload.body, 140),
      },
      badge,
      sound: agentNotificationDeliveryPolicy(payload.kind).sound ?? undefined,
      "content-available": 1,
      "mutable-content": 1,
      "thread-id": payload.channelId,
    },
    data: {
      schemaVersion: 1,
      kind: payload.kind,
      notificationScope: device.notificationScope,
      channelId: payload.channelId,
      botId: payload.botId,
      messageSequence: payload.messageSequence,
      notificationSequence: payload.notificationSequence,
      sender: payload.sender
        ? {
            name: truncateNotificationText(payload.sender.name, 80),
            icon: payload.sender.icon,
            color: payload.sender.color,
          }
        : undefined,
      badgeCount: badge,
    },
  };
}

export class ApnsClient {
  private token: { value: string; created: number } | undefined;
  private sessions = new Map<string, ClientHttp2Session>();
  constructor(
    private readonly configuration?: ApnsConfiguration,
    private readonly transport?: ApnsTransport
  ) {}

  private config(): ApnsConfiguration {
    if (this.configuration) return this.configuration;
    const keyId = process.env.OPENTEAM_APNS_KEY_ID?.trim();
    const teamId = process.env.OPENTEAM_APNS_TEAM_ID?.trim();
    const topic = process.env.OPENTEAM_APNS_TOPIC?.trim() || "dev.openteam.mobile.swift";
    let privateKey = process.env.OPENTEAM_APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!privateKey && process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE) {
      try {
        privateKey = readFileSync(process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE, "utf8");
      } catch {
        throw new Error("The APNs signing-key file could not be read");
      }
    }
    if (!keyId || !teamId || !privateKey)
      throw new Error(
        "Native iOS push needs OPENTEAM_APNS_KEY_ID, OPENTEAM_APNS_TEAM_ID and an APNs signing key"
      );
    return { keyId, teamId, topic, privateKey };
  }
  private authorization(config: ApnsConfiguration): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now - this.token.created < 50 * 60 && now >= this.token.created)
      return this.token.value;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: now })}`;
    try {
      const key = createPrivateKey(config.privateKey);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
        throw new Error();
      const signature = sign("sha256", Buffer.from(unsigned), {
        key,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      this.token = { value: `${unsigned}.${signature}`, created: now };
      return this.token.value;
    } catch {
      throw new Error("The APNs signing key must be a valid P-256 .p8 private key");
    }
  }
  async send(
    device: ApnsDevice,
    payload: PushNotificationPayload,
    badgeCount: number,
    deliveryKey: string
  ): Promise<ApnsResult> {
    const config = this.config();
    if (device.apnsTopic !== config.topic)
      throw new Error("The native app bundle ID does not match OPENTEAM_APNS_TOPIC");
    if (
      !["development", "production"].includes(device.apnsEnvironment ?? "") ||
      !/^(?:[a-f0-9]{2}){32,100}$/i.test(device.pushToken) ||
      !device.notificationScope
    ) {
      throw new Error("Incomplete APNs device registration");
    }
    const content = apnsPayload(device, payload, badgeCount);
    // Bound Unicode-heavy previews by bytes as well as graphemes. Keep the
    // routing/read identities intact; an oversized title is never sent to APNs.
    let body = JSON.stringify(content);
    if (Buffer.byteLength(body) > 4096 && payload.kind !== "badge-sync" && "alert" in content.aps) {
      content.aps.alert = {
        title: truncateNotificationText(payload.title, 30),
        body: "Open OpenTeam to view this message.",
      };
      if ("sender" in content.data && content.data.sender)
        content.data.sender.name = content.aps.alert.title;
      body = JSON.stringify(content);
    }
    if (Buffer.byteLength(body) > 4096)
      throw new Error("APNs notification exceeds the payload size limit");
    const authority =
      device.apnsEnvironment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    const collapse =
      payload.kind === "badge-sync" ? `read:${device.notificationScope}` : deliveryKey;
    const headers = {
      ":method": "POST",
      ":path": "/3/device/" + device.pushToken.toLowerCase(),
      "content-type": "application/json",
      authorization: "bearer " + this.authorization(config),
      "apns-topic": config.topic,
      "apns-push-type": payload.kind === "badge-sync" ? "background" : "alert",
      "apns-priority": payload.kind === "badge-sync" ? "5" : "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
      "apns-collapse-id": createHash("sha256").update(collapse).digest("hex"),
    };
    const result = await (this.transport ?? this.request.bind(this))(authority, headers, body);
    if (result.reason === "ExpiredProviderToken") this.token = undefined;
    return result;
  }
  private request(
    authority: string,
    headers: Record<string, string>,
    body: string
  ): Promise<ApnsResult> {
    let session = this.sessions.get(authority);
    if (!session || session.closed || session.destroyed) {
      session = connect(authority);
      this.sessions.set(authority, session);
      const current = session;
      session.on("error", () => {
        if (this.sessions.get(authority) === current) this.sessions.delete(authority);
      });
      session.on("goaway", () => {
        if (this.sessions.get(authority) === current) this.sessions.delete(authority);
        current.close();
      });
      session.setTimeout(30_000, () => current.close());
      session.unref();
    }
    return new Promise((resolve, reject) => {
      const request = session.request(headers);
      let status = 0,
        text = "";
      const timeout = setTimeout(() => {
        request.close();
        reject(new Error("APNs request timed out"));
      }, 10_000);
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk) => {
        if (text.length < 8192) text += chunk;
      });
      request.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to APNs"));
      });
      request.on("end", () => {
        clearTimeout(timeout);
        let reason: string | undefined;
        try {
          const value = JSON.parse(text);
          if (typeof value.reason === "string") reason = value.reason.slice(0, 100);
        } catch {}
        resolve({ status, reason });
      });
      request.end(body);
    });
  }
  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
