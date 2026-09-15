import type { CallDynamicToolInput, GetDynamicToolsInput } from "@openteam/contracts";
import { compileToolSearchPattern } from "@openteam/shell-jobs";
import { parseArgumentsLeniently } from "./dynamic-tool-argument-repair.js";

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

const descriptionSummary = (description: string): string => {
  const clean = description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const suffix = "... [truncated]";
  return clean.length > 200 ? clean.slice(0, 200 - suffix.length) + suffix : clean;
};

export const dynamicToolKey = (namespace: string, toolName: string): string =>
  `${namespace}/${toolName}`;

const searchPattern = (source: string | undefined): { test(text: string): boolean } | null => {
  if (!source) return null;
  if (source.length > 256) throw new Error("Tool search pattern must be at most 256 characters");
  try {
    return compileToolSearchPattern(source);
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

  const pattern = searchPattern(input.toolName ? undefined : input.pattern);
  const fullLookup = Boolean(input.namespace && (!input.pattern || input.toolName));
  const namespaces = catalog
    .filter((namespace) => !input.namespace || namespace.name === input.namespace)
    .map((namespace): DynamicNamespaceView | null => {
      const namespaceMatches = pattern?.test(namespace.name) ?? false;
      const tools = namespace.tools
        .filter((tool) => !input.toolName || tool.name === input.toolName)
        .filter((tool) => !pattern || namespaceMatches || pattern.test(tool.name))
        .map((tool) => {
          if (fullLookup) discoveredTools.add(dynamicToolKey(namespace.name, tool.name));
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

/** Model-facing reference envelope; internal discovery views remain useful to the UI. */
export function renderDynamicDiscovery(result: { namespaces: DynamicNamespaceView[] }, input: GetDynamicToolsInput): unknown {
  const tool = (t: DynamicToolView, full: boolean) => ({ tool: t.name, description: t.description, ...(full ? { inputSchema: t.inputSchema } : {}) });
  const namespace = (n: DynamicNamespaceView, full: boolean) => ({ namespace: n.name, ...(n.namespaceStatus === "ready" ? {} : { namespaceStatus: n.namespaceStatus }), namespaceDescription: n.description, tools: n.tools.map(t => tool(t, full)) });
  if (input.toolName) return tool(result.namespaces[0]!.tools[0]!, true);
  if (input.pattern) {
    const pattern = searchPattern(input.pattern)!;
    const matches = result.namespaces.flatMap(n => [
      ...(pattern.test(n.name) ? [{ namespace: n.name, description: n.description }] : []),
      ...n.tools.map(t => ({ namespace: n.name, tool: t.name, description: t.description, ...(n.namespaceStatus === "ready" || pattern.test(n.name) ? {} : { namespaceStatus: n.namespaceStatus }) }))
    ]).sort((a, b) => a.namespace.localeCompare(b.namespace) || ((a as any).tool ?? "").localeCompare((b as any).tool ?? ""));
    return { mode: "search", pattern: input.pattern, matches };
  }
  if (input.namespace) return { mode: "namespace", ...namespace(result.namespaces[0]!, true) };
  return { mode: "catalog", namespaces: [...result.namespaces].sort((a,b)=>a.name.localeCompare(b.name)).map(n => namespace(n, false)) };
}

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
    arguments: tool.decodeArguments(decodeDynamicArguments(input.arguments)),
  };
};

export function decodeDynamicArguments(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input === "string") {
    const repaired = parseArgumentsLeniently(input);
    if (!repaired) throw new Error("Tool arguments are invalid or have more than one possible interpretation");
    return repaired.args;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object");
  return input as Record<string, unknown>;
}
