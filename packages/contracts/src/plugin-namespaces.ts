import { fileTransferCapabilities } from "@openteam/plugin-sdk";
import type { PluginDynamicNamespace } from "./index";
import { getDefaultMcpCustomInstruction } from "./reference-formatters";

export interface NamespaceConnection {
  id: string;
  name: string;
  alias: string;
  connectorKey: string;
  status: string;
  statusMessage: string | null;
  instructions: string | null;
  toolSnapshot: unknown;
  installation: { pluginKey: string };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const namespaceStatus = (status: string): PluginDynamicNamespace["namespaceStatus"] =>
  status === "ready" ? "ready" : status === "needs_auth" ? "needsAuth" : status === "error" ? "error" : "loading";

/** The service and account a namespace belongs to, e.g. `Gmail (work)`. */
export const connectionDisplayName = (connection: Pick<NamespaceConnection, "name" | "alias">): string =>
  `${connection.name} (${connection.alias})`;

/** One shape for the turn-start catalog and every mid-turn refresh. */
export function pluginDynamicNamespaces(
  connections: readonly NamespaceConnection[],
  namespaces: ReadonlyMap<string, string>
): PluginDynamicNamespace[] {
  return connections.map((connection) => ({
    name: namespaces.get(connection.id)!,
    description: connectionDisplayName(connection),
    namespaceStatus: namespaceStatus(connection.status),
    ...(connection.status !== "ready" && connection.statusMessage
      ? { statusMessage: connection.statusMessage.slice(0, 500) }
      : {}),
    fileTransfers: fileTransferCapabilities(connection.installation.pluginKey),
    tools: Array.isArray(connection.toolSnapshot)
      ? connection.toolSnapshot.flatMap((candidate) => {
          const tool = record(candidate);
          if (typeof tool.name !== "string") return [];
          return [{
            connectionId: connection.id,
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: record(tool.inputSchema),
            source: `${connection.installation.pluginKey}/${connection.connectorKey}`,
            ...(tool.risk === "read" ? { readOnly: true } : {}),
          }];
        })
      : [],
  }));
}

/** The reference's always-follow section for saved connector instructions, from connected accounts only. */
export function connectorCustomInstructionsSection(
  connections: readonly NamespaceConnection[],
  namespaces: ReadonlyMap<string, string>
): string {
  const entries = connections
    .filter((connection) => connection.status === "ready")
    .flatMap((connection) => {
      const instructions = connection.instructions?.trim() || getDefaultMcpCustomInstruction(connection.name);
      return instructions ? [`- ${connectionDisplayName(connection)}, namespace ${namespaces.get(connection.id)}: ${instructions}`] : [];
    })
    .sort((a, b) => a.localeCompare(b));
  return entries.length
    ? [
        "## Connector custom instructions",
        "Custom instructions are configured for some connected tools (MCP connectors). Always follow the matching instruction whenever you use that connector's tools, even before your first call to it:",
        ...entries,
      ].join("\n")
    : "";
}
