import type { JsonObject } from "./cdp-connection";

export interface BrowserCookie extends JsonObject {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  session?: boolean;
  partitionKey?: JsonObject;
  partitionKeyOpaque?: boolean;
}

export const cookieKey = (cookie: BrowserCookie): string =>
  [cookie.name, cookie.domain, cookie.path, JSON.stringify(cookie.partitionKey ?? null)].join("\0");

export const cookieParameter = (cookie: BrowserCookie): JsonObject => {
  const result: JsonObject = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
  };
  for (const key of [
    "secure",
    "httpOnly",
    "sameSite",
    "priority",
    "sameParty",
    "sourceScheme",
    "sourcePort",
  ]) {
    if (cookie[key] !== undefined) result[key] = cookie[key];
  }
  if (typeof cookie.expires === "number" && cookie.expires > 0) result.expires = cookie.expires;
  if (cookie.partitionKey && !cookie.partitionKeyOpaque) result.partitionKey = cookie.partitionKey;
  return result;
};

export const asCookie = (value: unknown): BrowserCookie | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as JsonObject;
  if (
    typeof raw.name !== "string" ||
    typeof raw.value !== "string" ||
    typeof raw.domain !== "string" ||
    typeof raw.path !== "string"
  ) {
    return null;
  }
  return raw as BrowserCookie;
};

export const cookieMap = (values: unknown[]): Map<string, BrowserCookie> => {
  const result = new Map<string, BrowserCookie>();
  for (const value of values) {
    const cookie = asCookie(value);
    if (cookie) result.set(cookieKey(cookie), cookie);
  }
  return result;
};
