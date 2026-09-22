import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@openteam/contracts";

export interface PluginOAuthDesktopContext {
  redirectUrl: string;
  sessionId: string | null;
  mode?: "desktop" | "manual";
}

export const MANUAL_OAUTH_REDIRECT = "http://127.0.0.1:42813/callback";

/** Auto follows the deployment address, never the provider's HTTPS authorization endpoint. */
export function oauthCallbackMode(
  publicUrl: string,
  config: Record<string, unknown>
): "server" | "manual" | "desktop" {
  if (["server", "manual", "desktop"].includes(String(config.oauthCallbackMode)))
    return config.oauthCallbackMode as "server" | "manual" | "desktop";
  return new URL(publicUrl).protocol === "https:" ? "server" : "manual";
}

/** Parse a user-pasted response without fetching the URL or exposing it to an agent. */
export function parseManualCallback(value: string, expectedRedirect: string) {
  const expected = new URL(expectedRedirect);
  let candidate = value.trim();
  // Safari can copy the address-bar text without its http:// prefix. Only restore
  // the scheme for our exact expected loopback authority and callback path.
  if (candidate.startsWith(`${expected.host}${expected.pathname}?`)) {
    candidate = `${expected.protocol}//${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidManualCallback();
  }
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    ["state", "code", "error", "iss"].some((key) => url.searchParams.getAll(key).length > 1)
  )
    throw invalidManualCallback();
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const iss = url.searchParams.get("iss") ?? undefined;
  if (
    !state ||
    state.length > 4096 ||
    Boolean(code) === Boolean(error) ||
    (code?.length ?? 0) > 8192 ||
    (error?.length ?? 0) > 1000 ||
    (iss?.length ?? 0) > 2000
  )
    throw invalidManualCallback();
  return { state, code, error, iss };
}

const invalidManualCallback = () =>
  new ApiError(
    400,
    "plugin_oauth_callback_invalid",
    "Paste the complete callback URL from the browser address bar, including code and state."
  );

/** The server never fetches this address; it is a callback on the signing-in desktop. */
export function validateDesktopCallback(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidCallback();
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  ) {
    throw invalidCallback();
  }
  return url.href;
}

const invalidCallback = () =>
  new ApiError(
    400,
    "plugin_oauth_redirect_invalid",
    "Use a desktop loopback callback on 127.0.0.1 with an explicit port."
  );

export function equalOAuthState(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
