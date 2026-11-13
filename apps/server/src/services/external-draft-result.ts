import { ApiError } from "@openteam/contracts";

const unreadable = (): never => {
  throw new ApiError(409, "draft_unavailable", "The connector returned an unreadable result");
};
const incomplete = (): never => {
  throw new ApiError(409, "draft_unavailable", "The connector did not confirm the complete reviewed send");
};
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const plainId = /^[A-Za-z0-9_-]{1,200}$/;

/** Decode connector records without turning a rejected JSON value into an ID. */
export function connectorRecord(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    // Preserve opaque IDs exactly, including digit-only and exponent-looking
    // strings. JSON's literal booleans/null must still be decoded and rejected.
    if (plainId.test(raw) && !["false", "null", "true"].includes(raw)) return { id: raw };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return unreadable();
    }
    return connectorRecord(parsed);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length)
    return unreadable();
  const result = raw as Record<string, any>;
  if (result.isError || result.error || result.ok === false)
    throw new ApiError(409, "draft_unavailable", "The connector did not complete the operation");

  const structured = has(result, "structuredContent"), content = has(result, "content");
  if (structured && (!result.structuredContent || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)))
    return unreadable();
  if (content && !Array.isArray(result.content)) return unreadable();
  if (structured) return connectorRecord(result.structuredContent);
  if (content) {
    const texts: string[] = [];
    for (const part of result.content) {
      if (!part || typeof part !== "object" || typeof part.type !== "string") return unreadable();
      if (part.type === "text") {
        if (typeof part.text !== "string") return unreadable();
        texts.push(part.text);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(texts.join("\n"));
    } catch {
      return unreadable();
    }
    return connectorRecord(parsed);
  }
  if (Object.keys(result).every(key => ["isError", "_meta", "annotations"].includes(key)))
    return unreadable();
  return result;
}

/** Reviewed email has known Gmail/SMTP success receipts. Managed Slack replies
 * remain opaque; their server's successful nonmetadata records stay compatible. */
export function reviewedSendResult(
  raw: unknown,
  platform: "email" | "slack",
  expectedRecipients?: readonly string[]
): Record<string, any> {
  const result = connectorRecord(raw);
  if (platform === "slack") return result;
  if (has(result, "accepted") || has(result, "rejected")) {
    if (!Array.isArray(result.accepted) || !result.accepted.length ||
        !result.accepted.every((address: unknown) => typeof address === "string" && !!address.trim()) ||
        !Array.isArray(result.rejected) || result.rejected.length)
      return incomplete();
    const accepted = new Set<string>(result.accepted.map((address: string) => address.trim().toLowerCase()));
    if (expectedRecipients?.some(address => !accepted.has(address.trim().toLowerCase())))
      return incomplete();
    return result;
  }
  if (typeof result.id === "string" && result.id.trim()) return result;
  return incomplete();
}
