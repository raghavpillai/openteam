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
  if (
    typeof link.sessionId !== "string" ||
    !link.sessionId ||
    link.sessionId.length > 128 ||
    typeof link.qrCodeDataUrl !== "string" ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(link.qrCodeDataUrl) ||
    link.qrCodeDataUrl.length > 70_000 ||
    typeof link.expiresAt !== "number" ||
    !Number.isSafeInteger(link.expiresAt) ||
    link.expiresAt <= Date.now() ||
    typeof link.instructions !== "string" ||
    link.instructions.length > 4000
  )
    return null;
  return {
    sessionId: link.sessionId,
    qrCodeDataUrl: link.qrCodeDataUrl,
    expiresAt: link.expiresAt,
    instructions: link.instructions,
  };
}
