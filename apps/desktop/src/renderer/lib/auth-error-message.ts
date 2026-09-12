import { clientErrorMessage } from "@openteam/product-core/redaction";

/** Electron wraps rejected IPC calls; that transport detail is not useful in the sign-in form. */
export function authErrorMessage(cause: unknown, fallback: string): string {
  const message = clientErrorMessage(cause, fallback)
    .replace(/^Error invoking remote method ['"]openteam:auth:[^'"]+['"]:\s*(?:Error:\s*)?/, "")
    .trim();
  if (/^(?:fetch failed|failed to fetch|network request failed)$/i.test(message)) {
    return "Could not reach this OpenTeam server. Check the address and your connection.";
  }
  if (
    /^(?:TimeoutError: )?(?:The operation was aborted due to timeout|The operation timed out)\.?$/i.test(
      message
    )
  ) {
    return "The server took too long to respond. Please try again.";
  }
  return message || fallback;
}
