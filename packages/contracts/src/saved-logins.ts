export interface CredentialProviderConnection {
  account: string;
  vault: string;
  broker?: boolean;
  vaultName?: string;
  alwaysAllow?: boolean;
  permissionRevision?: number;
  generation?: number;
  lifecycleState?: string;
  expiresAt?: string | null;
  itemCount?: number;
  lastSuccessfulSyncAt?: string | null;
  lastSyncErrorCode?: string | null;
}

export const ONEPASSWORD_ERRORS = {
  cancelled: "1Password setup was cancelled.",
  timeout: "1Password did not respond in time. Unlock it and try again.",
  denied: "The request was not approved in 1Password. Retry when you are ready to approve it.",
  "integration-off": "Enable desktop CLI integration in 1Password and unlock the app, then retry.",
  permission:
    "This account cannot perform the requested operation. Check service-account creation and Manage Vault permissions in 1Password.",
  "service-account-limit":
    "This account reached its service-account limit. Revoke an unused service account in 1Password, then retry.",
  conflict:
    "More than one vault has that name, or the requested object already exists. Choose an unambiguous vault name.",
  "launcher-error":
    "The private 1Password launcher failed verification. Update or rebuild OpenTeam and try again.",
  "op-error":
    "The 1Password operation failed. Check desktop integration, permissions and connectivity, then retry.",
  "completion-pending":
    "The service account was created, but registration could not be confirmed. Retry connection completion before starting another setup.",
  "delivery-indeterminate":
    "The previous setup may have created a service account. Review it in 1Password before restarting setup.",
} as const;
export type OnePasswordErrorCode = keyof typeof ONEPASSWORD_ERRORS;
export const onePasswordError = (code: OnePasswordErrorCode) =>
  new Error(`1Password [${code}]: ${ONEPASSWORD_ERRORS[code]}`);
export function onePasswordErrorCode(error: unknown): OnePasswordErrorCode | undefined {
  const code =
    error instanceof Error ? /1Password \[([a-z-]+)\]:/.exec(error.message)?.[1] : undefined;
  return code && Object.hasOwn(ONEPASSWORD_ERRORS, code)
    ? (code as OnePasswordErrorCode)
    : undefined;
}
/** Electron may prefix IPC errors. Only render a known static message, never raw provider text. */
export function onePasswordErrorMessage(error: unknown, fallback: string): string {
  const code = onePasswordErrorCode(error);
  return code ? ONEPASSWORD_ERRORS[code] : fallback;
}
