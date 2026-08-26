import type { CallDynamicToolInput, GetDynamicToolsInput } from "@openbot/contracts";

export type DynamicNamespaceStatus = "ready" | "needsAuth" | "error" | "loading";

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  source: string;
  decodeArguments: (input: unknown) => unknown;
}

export interface DynamicNamespaceDefinition<
  Tool extends DynamicToolDefinition = DynamicToolDefinition,
> {
  name: string;
  description: string;
  kind: "first-party" | "mcp";
  namespaceStatus: DynamicNamespaceStatus;
  tools: readonly Tool[];
}

export interface DynamicToolView {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  source: string;
}

export interface DynamicNamespaceView {
  name: string;
  description: string;
  namespaceStatus: DynamicNamespaceStatus;
  tools: DynamicToolView[];
}

const descriptionSummary = (description: string): string =>
  description.length > 200 ? `${description.slice(0, 200)}... [truncated]` : description;

export const dynamicToolKey = (namespace: string, toolName: string): string =>
  `${namespace}/${toolName}`;

const searchPattern = (source: string | undefined): RegExp | null => {
  if (!source) return null;
  try {
    return new RegExp(source, "i");
  } catch (error) {
    throw new Error(
      `Invalid tool search pattern: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Return only tools in the caller's effective catalog and record discovery
 * receipts for the exact namespace/tool pairs included in the response.
 */
export const discoverDynamicTools = (
  catalog: readonly DynamicNamespaceDefinition[],
  discoveredTools: Set<string>,
  input: GetDynamicToolsInput
): { namespaces: DynamicNamespaceView[] } => {
  if (input.toolName && !input.namespace) {
    throw new Error("toolName requires namespace");
  }

  const pattern = searchPattern(input.pattern);
  const fullLookup = Boolean(input.namespace && !input.pattern);
  const namespaces = catalog
    .filter((namespace) => !input.namespace || namespace.name === input.namespace)
    .map((namespace): DynamicNamespaceView | null => {
      const namespaceMatches = pattern?.test(namespace.name) ?? false;
      const tools = namespace.tools
        .filter((tool) => !input.toolName || tool.name === input.toolName)
        .filter((tool) => !pattern || namespaceMatches || pattern.test(tool.name))
        .map((tool) => {
          discoveredTools.add(dynamicToolKey(namespace.name, tool.name));
          return {
            name: tool.name,
            description: fullLookup ? tool.description : descriptionSummary(tool.description),
            inputSchema: tool.inputSchema,
            source: tool.source,
          };
        });

      if (pattern && !namespaceMatches && tools.length === 0) return null;
      if (input.toolName && tools.length === 0) return null;
      return {
        name: namespace.name,
        description: namespace.description,
        namespaceStatus: namespace.namespaceStatus,
        tools,
      };
    })
    .filter((namespace): namespace is DynamicNamespaceView => namespace !== null);

  if (input.namespace && namespaces.length === 0) {
    throw new Error(
      `Dynamic namespace or tool not found: ${input.namespace}${input.toolName ? `/${input.toolName}` : ""}`
    );
  }

  return { namespaces };
};

/**
 * Re-resolve and validate every invocation. A prior discovery receipt is only
 * evidence that the model saw the schema; it is never authorization by itself.
 */
export const resolveDynamicTool = <Tool extends DynamicToolDefinition>(
  catalog: readonly DynamicNamespaceDefinition<Tool>[],
  discoveredTools: ReadonlySet<string>,
  input: CallDynamicToolInput
): {
  namespace: DynamicNamespaceDefinition<Tool>;
  tool: Tool;
  arguments: unknown;
} => {
  const key = dynamicToolKey(input.namespace, input.toolName);
  const namespace = catalog.find((candidate) => candidate.name === input.namespace);
  const tool = namespace?.tools.find((candidate) => candidate.name === input.toolName);

  if (!namespace || !tool) throw new Error(`Unknown dynamic tool: ${key}`);
  if (namespace.namespaceStatus !== "ready") {
    throw new Error(
      `Dynamic namespace ${namespace.name} is unavailable (${namespace.namespaceStatus})`
    );
  }
  if (!discoveredTools.has(key)) {
    throw new Error(`Call GetDynamicTools for ${key} before invoking it`);
  }
  if (namespace.kind === "first-party" && input.mcpDetails !== undefined) {
    throw new Error(`mcpDetails must be omitted for first-party namespace ${namespace.name}`);
  }

  return {
    namespace,
    tool,
    arguments: tool.decodeArguments(input.arguments ?? {}),
  };
};
