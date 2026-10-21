import {
  describeInstalled,
  describeInstalledList,
  describePluginDetail,
  describePluginSummary,
} from "./reference-formatters";

type Row = Record<string, any>;
const server = (c: Row) => ({
  serverIdentifier: c.server_id ?? c.id,
  name: c.name,
  status: c.status === "needs_auth" ? "needsAuth" : c.status,
  accountKey: c.account_label ?? c.alias ?? "default",
  transport: c.transport,
  toolCount: c.toolCount,
  disabledToolCount:c.disabledToolCount,
  ...(c.pluginKey && !c.pluginKey.startsWith("custom-mcp-") ? { pluginId: c.pluginKey } : {}),
  statusDetail: c.statusMessage,
  customInstructions: c.customInstructions ?? "",
});
const plugin = (p: Row, installed = p.installed, connections: Row[] = []) => ({
  pluginId: p.plugin_id ?? p.key,
  displayName: p.name,
  description: p.description ?? "",
  isInstalled: installed,
  category: p.category ?? "custom",
  connectorCount: p.connectorCount ?? p.connections?.length ?? connections.length,
  skills: p.skills ?? [],
  fields: (p.setupFields ?? []).map((f: Row) => ({
    ...f,
    isRequired: f.required,
    isSecret: f.secret,
  })),
  servers: connections.map(server),
});

/** The plugin id a call names; GetPlugin, InstallPlugin and UninstallPlugin accept the reference's aliases. */
const pluginId = (args: Row) => args.plugin_id ?? args.pluginKey ?? args.pluginId ?? args.id;
const noPlugin = (id: unknown) => `No plugin with id "${id}". Ids come from SearchPlugins. Run it and use the id it lists.`;

/** Receipts only: authorization URLs, setup secrets and private configuration never become tool text. */
export function renderPluginResult(name: string, r: Row, args: Row): string | undefined {
  const listing = () => describeInstalledList((r.connections ?? []).map(server));
  if (name === "SearchPlugins") {
    const query = (args.query ?? "").trim(),
      rows = r.plugins ?? [];
    if (!rows.length)
      return query
        ? `No plugins match "${query}". Try different words, or search with no query to list everything.`
        : "The plugin catalog is empty or unavailable right now. Try again shortly.";
    return [
      query
        ? `${rows.length} plugin(s) matching "${query}" (best first):`
        : `${rows.length} plugin(s) available:`,
      ...rows.map((p: Row) => describePluginSummary(plugin(p), (r.connections ?? []).map(server))),
    ].join("\n");
  }
  if (name === "GetPlugin")
    return r.plugin
      ? describePluginDetail(plugin(r.plugin, r.installed, r.connections), "omitted")
      : noPlugin(pluginId(args));
  if (name === "GetMcpServerStatus") {
    const id = typeof args.server_id === "string" ? args.server_id.trim() : "";
    if (!id) return listing();
    const rows = (r.connections ?? []).map(server);
    return rows.length
      ? rows.map(describeInstalled).join("\n")
      : `No installed MCP server "${id}". Omit server_id to list every server with its identifier.`;
  }
  if (
    ![
      "InstallPlugin",
      "UninstallPlugin",
      "AddMcpServer",
      "UninstallMcpServer",
      "AuthenticateMcpServer",
      "RestartMcpServers",
      "RemoveMcpAccount",
      "RenameMcpAccount",
      "SetMcpInstructions",
    ].includes(name)
  )
    return undefined;
  if (r.error)
    return `${name}: the operation failed. Check GetMcpServerStatus and the connection's setup screen before retrying.`;
  if (!r.completed || r.actionResult == null)
    return `${name}: its operation result is unavailable. Check the current status before relying on it.`;
  const outcome = r.actionResult;
  if (name === "InstallPlugin") {
    const detail = r.detail;
    if (!detail?.installed)
      return `The install request for "${detail?.plugin?.name ?? pluginId(args)}" completed, but the plugin does not read as installed yet. Re-check with GetPlugin before relying on it.`;
    return `Installed ${detail.plugin.name} (plugin ${detail.plugin.plugin_id}).\n${describePluginDetail(plugin(detail.plugin, true, detail.connections), "live")}`;
  }
  if (name === "UninstallPlugin" && outcome.uninstalled)
    return `Uninstalled ${outcome.pluginName ?? pluginId(args)} (plugin ${pluginId(args)}). Its install record and every connector it added are gone, and the user is signed out of those connectors.`;
  if (name === "UninstallMcpServer" && outcome.uninstalled)
    return `Removed MCP server ${outcome.name ? `${outcome.name} (${args.server_id})` : args.server_id}.\n${listing()}`;
  if (name === "AddMcpServer") return `Added "${args.name}".\n${listing()}`;
  if (name === "RestartMcpServers") {
    const failures = (outcome.servers ?? []).filter((s: Row) => s.error);
    return [
      failures.length
        ? `${failures.length} MCP server(s) failed to restart:`
        : "Restarted MCP servers.",
      ...failures.map((s: Row) => `${s.connectionId}: ${s.error}`),
      listing(),
    ].join("\n");
  }
  if (name === "SetMcpInstructions")
    return `${String(args.instructions ?? "").trim() ? "Updated" : "Cleared"} custom instructions for MCP server ${args.server_id}.\n${listing()}`;
  if (name === "RemoveMcpAccount" && outcome.removed)
    return `Removed account "${args.account_label}" from MCP server ${args.server_id}.\n${listing()}`;
  if (name === "RenameMcpAccount")
    return `Renamed account "${args.account_label}" to "${args.new_account_label}" on MCP server ${args.server_id}.\n${listing()}`;
  if (name === "AuthenticateMcpServer" && outcome.requiresUserAction === true) {
    // Only expose the OpenTeam setup link, never a provider authorization URL.
    const setupUrl = `openteam://app/v1/plugin/add?id=${encodeURIComponent(outcome.pluginId)}`;
    return [
      `Sign-in requires user action for account ${JSON.stringify(outcome.accountLabel)} on MCP server ${args.server_id}. No new provider sign-in has been started.`,
      `Share this link with the user: [Open connection settings](${setupUrl}).`,
      outcome.instructions,
      listing(),
    ].join("\n");
  }
  if (name === "AuthenticateMcpServer")
    return `${outcome.status === "ready" ? "Authenticated" : "Authentication requested for"} MCP server ${args.server_id}.\n${listing()}`;
  return `${name} completed.\n${listing()}`;
}
