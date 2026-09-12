import { clientErrorMessage } from "./redaction";

/** Present auth failures consistently without exposing native bridge or storage diagnostics. */
export function authErrorMessage(cause: unknown, fallback: string): string {
  const message = clientErrorMessage(cause, fallback)
    .replace(/^Error invoking remote method ['"]openteam:auth:[^'"]+['"]:\s*(?:Error:\s*)?/, "")
    .trim();
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  if (
    code === "timeout" ||
    /^(?:TimeoutError: )?(?:The operation was aborted due to timeout|The operation timed out)\.?$/i.test(
      message
    )
  ) {
    return "The server took too long to respond. Please try again.";
  }
  if (/^(?:fetch failed|failed to fetch|network request failed)$/i.test(message)) {
    return "Could not reach this OpenTeam server. Check the address and your connection.";
  }
  if (
    /FunctionCallException|KeyChainException|ExpoSecureStore|Keychain unavailable|A required entitlement isn't present|QuotaExceededError/i.test(
      message
    )
  ) {
    return "OpenTeam could not access your saved sign-in. Restart the app and try again.";
  }
  if (
    /valid OpenTeam server URL|server URL must use HTTP or HTTPS|server URL is required/.test(
      message
    )
  ) {
    return "Enter a server address starting with http:// or https://, such as https://openteam.example.com.";
  }
  if (/endpoint without a query or fragment/.test(message)) {
    return "Use the server address without anything after ? or #.";
  }
  if (/endpoint without a username or password/.test(message)) {
    return "Remove the username and password from the server address. You’ll sign in on the next screen.";
  }
  if (/did not return an OpenTeam session token/.test(message)) {
    return "The server did not complete sign-in. Please try again or contact your server administrator.";
  }
  return message || fallback;
}
