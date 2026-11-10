import type { PluginDeviceLink } from "@openteam/plugin-sdk";
import { definitionFromManifest, jsonObject } from "./values";

export function deviceLinkDefinition(connection: {
  connectorKey: string;
  installation: { manifest: any };
}): PluginDeviceLink | undefined {
  return definitionFromManifest(connection.installation.manifest)?.connections.find(
    (c) => c.key === connection.connectorKey
  )?.deviceLink;
}

/** MCP lifecycle results stay host-only. Reject tool errors and malformed envelopes. */
export function deviceLinkResult(result: unknown): Record<string, any> {
  const envelope = jsonObject(result);
  if (envelope.isError === true) throw new Error("Device linking failed. Reconnect to try again.");
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  if (content.length !== 1 || content[0]?.type !== "text" || typeof content[0]?.text !== "string")
    throw new Error("Invalid device linking response.");
  const value = JSON.parse(content[0].text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid device linking response.");
  return value;
}

export function publicDeviceLink(credentials: unknown) {
  const link = jsonObject(jsonObject(credentials).deviceLink);
  const deadline = link.sessionExpiresAt ?? link.expiresAt;
  const generation = link.challengeGeneration;
  const dynamic = link.sessionExpiresAt !== undefined || link.challengeGeneration !== undefined;
  if (
    typeof link.sessionId !== "string" ||
    !link.sessionId ||
    link.sessionId.length > 128 ||
    (!(dynamic && link.qrCodeDataUrl === null) &&
      (typeof link.qrCodeDataUrl !== "string" ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(link.qrCodeDataUrl) ||
        link.qrCodeDataUrl.length > 70_000)) ||
    typeof link.expiresAt !== "number" ||
    !Number.isSafeInteger(link.expiresAt) ||
    link.expiresAt <= 0 ||
    typeof deadline !== "number" ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    link.expiresAt > deadline ||
    (generation !== undefined &&
      (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)) ||
    typeof link.instructions !== "string" ||
    link.instructions.length > 4000
  )
    return null;
  return {
    sessionId: link.sessionId,
    qrCodeDataUrl: link.expiresAt > Date.now() ? link.qrCodeDataUrl : null,
    expiresAt: link.expiresAt,
    instructions: link.instructions,
    ...(link.sessionExpiresAt !== undefined ? { sessionExpiresAt: deadline } : {}),
    ...(typeof generation === "number" ? { challengeGeneration: generation } : {}),
  };
}

/** Dynamic approvals require a session identifier; legacy static providers may omit it. */
export function deviceLinkStatusMatches(link: Record<string, any>, status: Record<string, any>) {
  if (!link.sessionId) return true;
  if (status.sessionId !== undefined) return status.sessionId === link.sessionId;
  return link.sessionExpiresAt === undefined && link.challengeGeneration === undefined;
}

/** Challenge rotation never creates a session or extends its fixed approval deadline. */
export function deviceLinkChallenge(link: Record<string, any>, status: Record<string, any>) {
  if (!Object.hasOwn(status, "challenge")) return;
  if (status.sessionId !== link.sessionId) return;
  const challenge = jsonObject(status.challenge);
  const generation = challenge.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
    throw new Error("Connector returned an invalid device linking challenge.");
  if (generation <= (link.challengeGeneration ?? 0)) return;
  const next = {
    ...link,
    sessionExpiresAt: link.sessionExpiresAt ?? link.expiresAt,
    challengeGeneration: generation,
    qrCodeDataUrl: challenge.qrCodeDataUrl,
    expiresAt: challenge.expiresAt,
  };
  if (!publicDeviceLink({ deviceLink: next }))
    throw new Error("Connector returned an invalid device linking challenge.");
  return next;
}

/** Clear temporary approval/recovery state while retaining provider credentials. */
export function clearDeviceLinkState(credentials: unknown) {
  return Object.fromEntries(
    Object.entries(jsonObject(credentials)).filter(
      ([key]) => key !== "deviceLink" && key !== "deviceRecoveryPending"
    )
  );
}
