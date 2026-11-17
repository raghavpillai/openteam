import { getAuthCredentialGeneration, getAuthSnapshot } from "../client/auth";
import { API_BASE } from "../client/http";
import { resolveConfiguredApiBase } from "../client/runtime-url";

/** A delayed preflight cannot borrow a later account's permission to update a server. */
export function captureServerUpdateConsent(): () => void {
  const generation = getAuthCredentialGeneration();
  const account = getAuthSnapshot();
  return () => {
    const current = getAuthSnapshot();
    if (
      generation !== getAuthCredentialGeneration() ||
      account.mode !== current.mode ||
      account.user?.id !== current.user?.id ||
      resolveConfiguredApiBase(window.location.href, localStorage, import.meta.env.VITE_OPENTEAM_API_URL) !== API_BASE
    ) {
      throw new Error("Your account or server changed. Review the update again before continuing.");
    }
  };
}
