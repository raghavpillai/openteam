import { ApiError } from "@openteam/contracts";

/** Keep compatibility aliases out of account selection. Conflicting spellings
 * are refused instead of silently routing to a different account. */
export function pluginToolArguments(action: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "invalid_plugin_arguments", "Plugin arguments must be an object");
  const args = { ...value } as Record<string, unknown>;
  const alias = (canonical: string, legacy: string) => {
    if (
      args[canonical] !== undefined &&
      args[legacy] !== undefined &&
      args[canonical] !== args[legacy]
    )
      throw new ApiError(
        400,
        "ambiguous_plugin_arguments",
        `Conflicting ${canonical} and ${legacy}`
      );
    if (args[legacy] !== undefined) args[canonical] = args[legacy];
    delete args[legacy];
  };
  alias("pluginKey", "plugin_id");
  alias("forceReauth", "force_reauth");
  if (action === "RenameMcpAccount") alias("accountLabel", "new_account_label");
  if (typeof args.account_label === "string") {
    // The reference accepts the displayed account="work" spelling verbatim.
    const quoted = /^(?:account=)?"(.*)"$/.exec(args.account_label);
    if (quoted) {
      try { args.account_label = JSON.parse(`"${quoted[1]}"`); }
      catch { throw new ApiError(400, "invalid_account_label", "Invalid quoted account label"); }
    }
  }
  if (action === "AddMcpServer" && args.auth !== undefined && typeof args.auth !== "string") {
    const auth = args.auth as Record<string, unknown> | null;
    if (
      !auth ||
      Array.isArray(auth) ||
      typeof auth !== "object" ||
      Object.keys(auth).some((key) => !["CLIENT_ID", "CLIENT_SECRET", "scopes"].includes(key)) ||
      typeof auth.CLIENT_ID !== "string" ||
      !auth.CLIENT_ID.trim() ||
      (auth.CLIENT_SECRET !== undefined && typeof auth.CLIENT_SECRET !== "string") ||
      (auth.scopes !== undefined &&
        (!Array.isArray(auth.scopes) || auth.scopes.some((scope) => typeof scope !== "string"))) ||
      typeof args.url !== "string" ||
      !args.url.trim() ||
      args.command !== undefined
    )
      throw new ApiError(
        400,
        "mcp_oauth_invalid",
        "OAuth settings require a remote URL, CLIENT_ID, optional CLIENT_SECRET, and a string array of scopes"
      );
  }
  return args;
}
