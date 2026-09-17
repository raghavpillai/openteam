import type { PluginCatalogItemView, PluginConnectionView } from "@openteam/contracts";

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
