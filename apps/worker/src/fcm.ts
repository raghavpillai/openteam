import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  agentNotificationDeliveryPolicy,
  truncateNotificationText,
  type PushNotificationPayload,
} from "@openteam/contracts";

export interface FcmDevice {
  pushToken: string;
  notificationScope?: string | null;
}

export interface FcmResult {
  status: number;
  reason?: string;
}

export interface FcmConfiguration {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export type FcmTransport = (
  authority: string,
  headers: Record<string, string>,
  body: string
) => Promise<FcmResult>;

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function fcmPayload(
  device: FcmDevice,
  payload: PushNotificationPayload,
  badgeCount: number,
  deliveryKey: string
) {
  if (!/^[A-Za-z0-9:_-]{20,4096}$/.test(device.pushToken)) {
    throw new Error("Incomplete FCM device registration");
  }
  const data: Record<string, string> = {
    schemaVersion: String(payload.schemaVersion),
    kind: payload.kind,
    notificationScope: device.notificationScope ?? "",
    badgeCount: String(Math.max(0, Math.floor(badgeCount))),
  };
  if (payload.kind !== "badge-sync") {
    Object.assign(data, {
      channelId: payload.channelId,
      botId: payload.botId,
      title: truncateNotificationText(payload.title, 80),
      body: truncateNotificationText(payload.body, 140),
    });
    if (payload.messageSequence) data.messageSequence = payload.messageSequence;
    if (payload.notificationSequence) data.notificationSequence = payload.notificationSequence;
    if (payload.threadMessageId) data.threadMessageId = payload.threadMessageId;
    if (payload.sender) data.sender = JSON.stringify(payload.sender);
  } else {
    data.readState = JSON.stringify(payload.readState ?? null);
  }
  const message: Record<string, unknown> = {
    token: device.pushToken,
    data,
    android: {
      priority: payload.kind === "badge-sync" ? "NORMAL" : "HIGH",
      collapseKey: createHash("sha256").update(deliveryKey).digest("hex"),
      ...(payload.kind === "badge-sync" ? {} : {
        notification: {
          channelId: "agent",
          sound: agentNotificationDeliveryPolicy(payload.kind).sound ?? "default",
        },
      }),
    },
  };
  if (payload.kind !== "badge-sync") {
    message.notification = {
      title: truncateNotificationText(payload.title, 80),
      body: truncateNotificationText(payload.body, 140),
    };
  }
  return { message };
}

export const fcmAuthenticationModeFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env
): FcmConfiguration | undefined => {
  const projectId = environment.OPENTEAM_FCM_PROJECT_ID?.trim();
  const clientEmail = environment.OPENTEAM_FCM_CLIENT_EMAIL?.trim();
  const privateKey = environment.OPENTEAM_FCM_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  return projectId && clientEmail && privateKey ? { projectId, clientEmail, privateKey } : undefined;
};

export const fcmConfigurationIssues = (configuration: FcmConfiguration | undefined): string[] => {
  if (!configuration) return [
    "OPENTEAM_FCM_PROJECT_ID is missing",
    "OPENTEAM_FCM_CLIENT_EMAIL is missing",
    "OPENTEAM_FCM_PRIVATE_KEY is missing",
  ];
  const issues: string[] = [];
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(configuration.projectId)) issues.push("project ID format is invalid");
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(configuration.clientEmail)) issues.push("client email format is invalid");
  if (!configuration.privateKey.includes("BEGIN PRIVATE KEY") || !configuration.privateKey.includes("END PRIVATE KEY")) {
    issues.push("private key must be a PEM service-account key");
  } else {
    try { createPrivateKey(configuration.privateKey); } catch { issues.push("private key is not parseable"); }
  }
  return issues;
};

export const fcmConfigurationStatus = (
  environment: NodeJS.ProcessEnv = process.env
) => {
  const raw = {
    projectId: environment.OPENTEAM_FCM_PROJECT_ID?.trim(),
    clientEmail: environment.OPENTEAM_FCM_CLIENT_EMAIL?.trim(),
    privateKey: environment.OPENTEAM_FCM_PRIVATE_KEY?.replace(/\\n/g, "\n").trim(),
  };
  const missing = [
    !raw.projectId ? "OPENTEAM_FCM_PROJECT_ID is missing" : null,
    !raw.clientEmail ? "OPENTEAM_FCM_CLIENT_EMAIL is missing" : null,
    !raw.privateKey ? "OPENTEAM_FCM_PRIVATE_KEY is missing" : null,
  ].filter((issue): issue is string => issue !== null);
  const configuration = missing.length === 0 ? raw as FcmConfiguration : undefined;
  const issues = configuration ? fcmConfigurationIssues(configuration) : missing;
  return { configured: issues.length === 0, issues };
};

export class FcmClient {
  private accessToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly configuration: FcmConfiguration | (() => FcmConfiguration | undefined) = fcmAuthenticationModeFromEnvironment,
    private readonly transport?: FcmTransport,
    private readonly injectedAccessToken?: string
  ) {}

  async send(device: FcmDevice, payload: PushNotificationPayload, badgeCount: number, deliveryKey: string): Promise<FcmResult> {
    const config = typeof this.configuration === "function" ? this.configuration() : this.configuration;
    if (!config) throw new Error("FCM configuration is missing");
    const issues = fcmConfigurationIssues(config).filter((issue) =>
      !this.injectedAccessToken || !issue.includes("private key")
    );
    if (issues.length > 0) throw new Error(`FCM configuration invalid: ${issues.join("; ")}`);
    const body = JSON.stringify(fcmPayload(device, payload, badgeCount, deliveryKey));
    const authority = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${await this.authorization(config)}`,
    };
    return (this.transport ?? this.request.bind(this))(authority, headers, body);
  }

  private async authorization(config: FcmConfiguration): Promise<string> {
    if (this.injectedAccessToken) return this.injectedAccessToken;
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const key = createPrivateKey(config.privateKey);
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${signature}`,
    });
    if (!response.ok) throw new Error(`FCM OAuth token request failed (${response.status})`);
    const value = await response.json() as { access_token?: string; expires_in?: number };
    if (!value.access_token) throw new Error("FCM OAuth token response did not include an access token");
    this.accessToken = { value: value.access_token, expiresAt: Date.now() + (value.expires_in ?? 3600) * 1000 };
    return value.access_token;
  }

  private async request(authority: string, headers: Record<string, string>, body: string): Promise<FcmResult> {
    const response = await fetch(authority, { method: "POST", headers, body });
    const text = await response.text();
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> } };
      reason = parsed.error?.details?.find((detail) => detail.errorCode)?.errorCode
        ?? parsed.error?.status ?? parsed.error?.message;
    } catch {}
    return { status: response.status, reason };
  }
}
