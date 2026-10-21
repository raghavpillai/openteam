import { ApiError } from "@openteam/contracts";

/** Account labels match case-insensitively, and new ones are stored lowercase, as in the reference. */
export const normalizeAccountLabel = (label: string): string => label.trim().toLowerCase();

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
  if (["GetPlugin", "InstallPlugin", "UninstallPlugin"].includes(action)) {
    // The reference accepts id and pluginId for plugin_id, and refuses conflicting spellings.
    const spellings = ["plugin_id", "pluginId", "id"].filter((key) => args[key] !== undefined);
    if (new Set(spellings.map((key) => args[key])).size > 1)
      throw new ApiError(400, "ambiguous_plugin_arguments", "Pass the plugin's id once, as plugin_id (from SearchPlugins).");
    if (spellings.length) args.plugin_id = args[spellings[0]!];
    delete args.pluginId;
    delete args.id;
  }
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
  if (action === "RenameMcpAccount" && typeof args.accountLabel === "string") args.accountLabel = normalizeAccountLabel(args.accountLabel);
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
