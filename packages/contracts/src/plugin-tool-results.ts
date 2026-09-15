import {
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
      ...rows.map((p: Row) => describePluginSummary(plugin(p))),
    ].join("\n");
  }
  if (name === "GetPlugin")
    return r.plugin
      ? describePluginDetail(plugin(r.plugin, r.installed, r.connections))
      : `No plugin with id "${args.plugin_id}". Ids come from SearchPlugins — run it and use the id it lists.`;
  if (name === "GetMcpServerStatus") return listing();
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
  if (r.status === "declined" || r.status === "cancelled")
    return `${name} was ${r.status} by the user. No change was made.`;
  if (!r.completed || r.actionResult == null)
    return `${name}: ${r.status === "accepted" ? "the approval was accepted, but its operation result is unavailable. Check the current status before relying on it" : "waiting for user confirmation"}.`;
  const outcome = r.actionResult;
  if (name === "InstallPlugin") {
    const detail = r.detail;
    if (!detail?.installed)
      return `The install request for "${args.plugin_id}" completed, but the plugin does not read as installed yet. Re-check with GetPlugin before relying on it.`;
    return `Installed ${detail.plugin.name} (plugin ${detail.plugin.plugin_id}).\n${describePluginDetail(plugin(detail.plugin, true, detail.connections))}`;
  }
  if (name === "UninstallPlugin" && outcome.uninstalled)
    return `Uninstalled ${outcome.pluginName ?? args.plugin_id} (plugin ${args.plugin_id}) — its install record and every connector it added are gone.`;
  if (name === "UninstallMcpServer" && outcome.uninstalled)
    return `Removed MCP server ${args.server_id}.\n${listing()}`;
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
    return `${args.instructions ? "Updated" : "Cleared"} custom instructions for MCP server ${args.server_id}.\n${listing()}`;
  if (name === "RemoveMcpAccount" && outcome.removed)
    return `Removed account "${args.account_label}" from MCP server ${args.server_id}.\n${listing()}`;
  if (name === "RenameMcpAccount")
    return `Renamed account "${args.account_label}" to "${args.new_account_label}" on MCP server ${args.server_id}.\n${listing()}`;
  if (name === "AuthenticateMcpServer")
    return `${outcome.status === "ready" ? "Authenticated" : "Authentication requested for"} MCP server ${args.server_id}.\n${listing()}`;
  return `${name} completed.\n${listing()}`;
}
