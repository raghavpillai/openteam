import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "./generated/prisma/client";

export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  topic: string;
  privateKey: string;
}
export interface ApnsStatus {
  source: "database" | "environment";
  missing: string[];
  issue: string | null;
  topic: string;
  keyId?: string;
  teamId?: string;
  updatedAt?: string;
}

export function validateApnsConfiguration(input: unknown): ApnsConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Provide APNs keyId, teamId, topic and privateKey.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["keyId", "teamId", "topic", "privateKey"].includes(key)))
    throw new Error("Unknown APNs configuration field.");
  if (
    typeof value.keyId !== "string" ||
    !/^[A-Z0-9]{10}$/.test(value.keyId) ||
    typeof value.teamId !== "string" ||
    !/^[A-Z0-9]{10}$/.test(value.teamId)
  )
    throw new Error("APNs key ID and team ID must each contain 10 uppercase letters or digits.");
  if (typeof value.topic !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value.topic))
    throw new Error("The APNs topic must be a valid app bundle ID.");
  try {
    if (typeof value.privateKey !== "string" || value.privateKey.length > 16_384) throw new Error();
    const key = createPrivateKey(value.privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error();
    sign("sha256", Buffer.from("OpenTeam APNs configuration check"), {
      key,
      dsaEncoding: "ieee-p1363",
    });
  } catch {
    throw new Error("The APNs signing key must be a valid P-256 .p8 private key.");
  }
  return value as unknown as ApnsConfiguration;
}

export function apnsEnvironmentConfiguration(): ApnsConfiguration {
  const keyId = process.env.OPENTEAM_APNS_KEY_ID?.trim() ?? "";
  const teamId = process.env.OPENTEAM_APNS_TEAM_ID?.trim() ?? "";
  const topic = process.env.OPENTEAM_APNS_TOPIC?.trim() || "dev.openteam.mobile.swift";
  let privateKey = process.env.OPENTEAM_APNS_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  if (!privateKey && process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE) {
    try {
      privateKey = readFileSync(process.env.OPENTEAM_APNS_PRIVATE_KEY_FILE, "utf8");
    } catch {
      throw new Error("The APNs signing-key file could not be read");
    }
  }
  return { keyId, teamId, topic, privateKey };
}

/** Runtime lookup on every delivery; a broken saved setting never falls back to stale env keys. */
export class ApnsSettingsStore {
  constructor(
    private readonly prisma: Pick<PrismaClient, "apnsSettings">,
    private readonly secret: () => string | undefined = () => process.env.OPENTEAM_CONTROL_TOKEN,
    private readonly environment = apnsEnvironmentConfiguration
  ) {}
  private key() {
    const secret = this.secret();
    if (!secret || secret.length < 32)
      throw new Error(
        "APNs configuration requires an installation control token of at least 32 characters."
      );
    return createHash("sha256").update(`openteam-apns-v1:${secret}`).digest();
  }
  private aad(config: Pick<ApnsConfiguration, "keyId" | "teamId" | "topic">) {
    return Buffer.from(JSON.stringify(["global", config.keyId, config.teamId, config.topic]));
  }
  async save(input: unknown): Promise<ApnsStatus> {
    const config = validateApnsConfiguration(input);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(this.aad(config));
    const ciphertext = Buffer.concat([cipher.update(config.privateKey, "utf8"), cipher.final()]);
    const { privateKey: _privateKey, ...metadata } = config;
    const data = {
      ...metadata,
      encryptedPrivateKey: `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`,
    };
    const row = await this.prisma.apnsSettings.upsert({
      where: { id: "global" },
      create: { id: "global", ...data },
      update: data,
    });
    return {
      source: "database",
      missing: [],
      issue: null,
      ...metadata,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async load(): Promise<{
    config: ApnsConfiguration;
    source: ApnsStatus["source"];
    updatedAt?: string;
  }> {
    const row = await this.prisma.apnsSettings.findUnique({ where: { id: "global" } }).catch(() => {
      throw new Error(
        "APNs configuration could not be read; check database access and schema setup."
      );
    });
    if (!row) return { config: this.environment(), source: "environment" };
    try {
      if (!row.encryptedPrivateKey.startsWith("enc:v1:")) throw new Error();
      const bytes = Buffer.from(row.encryptedPrivateKey.slice(7), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
      decipher.setAAD(this.aad(row));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const privateKey = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      return {
        config: validateApnsConfiguration({
          keyId: row.keyId,
          teamId: row.teamId,
          topic: row.topic,
          privateKey,
        }),
        source: "database",
        updatedAt: row.updatedAt.toISOString(),
      };
    } catch {
      throw new Error(
        "Saved APNs configuration could not be decrypted or validated; import it again with openteam notifications configure."
      );
    }
  }
  async status(): Promise<ApnsStatus> {
    try {
      const { config, source, updatedAt } = await this.load();
      const missing = [
        !config.keyId && "OPENTEAM_APNS_KEY_ID",
        !config.teamId && "OPENTEAM_APNS_TEAM_ID",
        !config.privateKey && "OPENTEAM_APNS_PRIVATE_KEY",
      ].filter((key): key is string => Boolean(key));
      let issue: string | null = null;
      if (!missing.length) {
        if (!/^[A-Z0-9]{10}$/.test(config.keyId) || !/^[A-Z0-9]{10}$/.test(config.teamId))
          issue = "identifiers";
        else if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(config.topic)) issue = "topic";
        else {
          try {
            validateApnsConfiguration(config);
          } catch {
            issue = "signing-key";
          }
        }
      }
      return {
        source,
        updatedAt,
        missing,
        issue,
        topic: config.topic,
        keyId: config.keyId,
        teamId: config.teamId,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "The APNs signing-key file could not be read")
        return {
          source: "environment",
          missing: [],
          issue: "key-file",
          topic: process.env.OPENTEAM_APNS_TOPIC?.trim() || "dev.openteam.mobile.swift",
        };
      return { source: "database", missing: [], issue: "runtime-settings", topic: "" };
    }
  }
}
