export interface CredentialProviderConnection {
  account: string;
  vault: string;
  vaultName?: string;
  generation?: number;
  lifecycleState?: string;
  itemCount?: number;
  lastSuccessfulSyncAt?: string | null;
  lastSyncErrorCode?: string | null;
}

export const ONEPASSWORD_ERRORS = {
  cancelled: "1Password setup was cancelled.",
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
