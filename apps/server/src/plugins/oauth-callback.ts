import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@openteam/contracts";

export interface PluginOAuthDesktopContext {
  redirectUrl: string;
  sessionId: string | null;
}

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
