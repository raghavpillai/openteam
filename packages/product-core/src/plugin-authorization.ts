import type { PluginCatalogItemView, PluginConnectionView } from "@openteam/contracts";

export function pluginProviderSetupDescription(pluginKey: string, description: string): string {
  return ["gmail", "google-calendar", "google-drive"].includes(pluginKey)
    ? "Set up your Google Cloud project once, then sign in. Choose the client type in the steps below to match your sign-in method."
    : description;
}

/** Older bundled Google manifests assumed a web client for every sign-in method. */
export function pluginProviderSetupSteps(pluginKey: string, callbackMode: string, steps: string[]): string[] {
  if (!["gmail", "google-calendar", "google-drive"].includes(pluginKey)) return steps;
  return [
    ...steps.slice(0, 2),
    callbackMode === "server"
      ? "Create a Web application OAuth client in Google Cloud. Add the exact callback address shown in Sign-in setup as an authorized redirect URI."
      : "Create a Desktop app OAuth client in Google Cloud. That is Google’s client type name; it does not require the OpenTeam desktop app unless you choose the desktop listener method.",
    "Copy the client ID and client secret into OpenTeam’s setup fields and save. These come from Google Cloud; they are not your Google password.",
    callbackMode === "desktop"
      ? "Finish signing in in the OpenTeam desktop app. The connected account will then work on your iPhone too."
      : "Sign in on this device and follow the on-screen steps. When the account says Connected, choose which bots may use it.",
  ];
}

/** Dynamic OAuth registration can start before a client has been registered. */
export function pluginNeedsSetup(
  connection: Pick<PluginConnectionView, "auth" | "configured">,
  plugin?: Pick<PluginCatalogItemView, "setup" | "setupFields"> | null
): boolean {
  return (
    !connection.configured &&
    (connection.auth !== "oauth" ||
      plugin?.setup?.kind === "oauth_client" ||
      Boolean(plugin?.setupFields.some((field) => field.required)))
  );
}

/** Owner-visible OAuth handoff metadata, never provider tokens or client secrets. */
export function pluginAuthorization(
  connection: {
    status: string;
    authorizationUrl: string | null;
    authorizationExpiresAt?: string | null;
  },
  now = Date.now()
): { url: string; state: string; expired: boolean } | null {
  if (connection.status !== "needs_auth" || !connection.authorizationUrl) return null;
  try {
    const url = new URL(connection.authorizationUrl);
    const state = url.searchParams.get("state");
    if (!["https:", "http:"].includes(url.protocol) || !state) return null;
    const expires = connection.authorizationExpiresAt
      ? Date.parse(connection.authorizationExpiresAt)
      : Infinity;
    return {
      url: url.href,
      state,
      expired: (!Number.isFinite(expires) && expires !== Infinity) || expires <= now,
    };
  } catch {
    return null;
  }
}
