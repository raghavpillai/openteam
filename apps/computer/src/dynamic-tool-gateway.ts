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
  /** Why a namespace is not ready and how to recover. */
  statusMessage?: string;
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
  kind: "first-party" | "mcp";
  namespaceStatus: DynamicNamespaceStatus;
  statusMessage?: string;
  tools: DynamicToolView[];
}

export interface DynamicLookupOptions {
  /** First-party tools this agent calls directly rather than through the cursor namespace. */
  directTools?: readonly string[];
  /** What this agent should do about a namespace that is not ready. */
  unavailableGuidance?: (namespace: DynamicNamespaceDefinition) => string;
}

/** A lookup that a fresh catalog could satisfy: the caller may refresh once and retry. */
export class DynamicLookupMiss extends Error {}

const MAX_PATTERN_LENGTH = 256;

const sanitizeDescription = (description: string): string =>
  description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

const descriptionSummary = (description: string): string => {
  const clean = sanitizeDescription(description);
  const suffix = "... [truncated]";
  return clean.length > 200 ? clean.slice(0, 200 - suffix.length) + suffix : clean;
};

const byName = <T extends { name: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => a.name.localeCompare(b.name));

/** The reference's sentence for a namespace whose tools cannot be used. */
export const namespaceUnavailableReason = (status: DynamicNamespaceStatus): string =>
  status === "needsAuth"
    ? "This MCP server requires authentication before its tools can be used."
    : status === "loading"
      ? "This MCP server is still loading; tools may not be available yet."
      : "This MCP server failed during live tool discovery. Its tools are unavailable until the connection is fixed.";

const namespaceError = (namespace: { namespaceStatus: DynamicNamespaceStatus; statusMessage?: string }) =>
  `${namespaceUnavailableReason(namespace.namespaceStatus)}${namespace.statusMessage ? ` ${namespace.statusMessage}` : ""}`;

export const dynamicToolKey = (namespace: string, toolName: string): string =>
  `${namespace}/${toolName}`;

const searchPattern = (source: string | undefined): { test(text: string): boolean } | null => {
  if (!source) return null;
  try {
    return compileToolSearchPattern(source);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const namespaceNotFound = (catalog: readonly DynamicNamespaceDefinition[], name: string) => {
  const names = catalog.map((namespace) => namespace.name).sort();
  return new DynamicLookupMiss(names.length
    ? `namespace "${name}" not found. Available namespaces: ${names.join(", ")}`
    : `namespace "${name}" not found.`);
};

/** Return only tools in the caller's effective catalog. A namespace that is not ready shows no tools. */
export const discoverDynamicTools = (
  catalog: readonly DynamicNamespaceDefinition[],
  input: GetDynamicToolsInput,
  options: DynamicLookupOptions = {}
): { namespaces: DynamicNamespaceView[] } => {
  if (input.toolName && !input.namespace) throw new Error("toolName requires namespace to be set.");
  if (input.pattern && input.pattern.length > MAX_PATTERN_LENGTH)
    throw new Error(`pattern cannot exceed ${MAX_PATTERN_LENGTH} characters.`);
  if (input.namespace && !catalog.some((namespace) => namespace.name === input.namespace))
    throw namespaceNotFound(catalog, input.namespace);

  const pattern = searchPattern(input.toolName ? undefined : input.pattern);
  const fullLookup = Boolean(input.namespace && (!input.pattern || input.toolName));
  const namespaces = catalog
    .filter((namespace) => !input.namespace || namespace.name === input.namespace)
    .map((namespace): DynamicNamespaceView | null => {
      const namespaceMatches = pattern?.test(namespace.name) ?? false;
      const firstParty = namespace.kind === "first-party";
      const tools = (namespace.namespaceStatus === "ready" ? namespace.tools : [])
        .filter((tool) => !input.toolName || tool.name === input.toolName)
        .filter((tool) => !pattern || namespaceMatches || pattern.test(tool.name))
        .map((tool) => ({
          name: tool.name,
          // Full lookups keep a first-party description verbatim; connector text is whitespace-collapsed.
          description: !fullLookup ? descriptionSummary(tool.description) : firstParty ? tool.description.trim() : sanitizeDescription(tool.description),
          inputSchema: tool.inputSchema,
          source: tool.source,
        }));
      if (pattern && !namespaceMatches && tools.length === 0) return null;
      return {
        name: namespace.name,
        description: namespace.description,
        kind: namespace.kind,
        namespaceStatus: namespace.namespaceStatus,
        ...(namespace.namespaceStatus !== "ready" && namespace.statusMessage
          ? { statusMessage: namespace.statusMessage }
          : {}),
        tools: byName(tools),
      };
    })
    .filter((namespace): namespace is DynamicNamespaceView => namespace !== null);

  if (input.toolName && !namespaces[0]?.tools.length) {
    const namespace = catalog.find((candidate) => candidate.name === input.namespace)!;
    if (namespace.namespaceStatus !== "ready") throw new Error(namespaceError(namespace));
    if (namespace.kind === "first-party" && options.directTools?.includes(input.toolName))
      throw new Error(`Tool "${input.toolName}" is already available directly and is not part of dynamic namespace "${namespace.name}". Invoke "${input.toolName}" directly instead of using dynamic tool discovery or invocation.`);
    const message = `Tool "${input.toolName}" not found in namespace "${input.namespace}".`;
    throw namespace.kind === "mcp" ? new DynamicLookupMiss(message) : new Error(message);
  }
  return { namespaces };
};

/** Model-facing reference envelope; internal discovery views remain useful to the UI. */
export function renderDynamicDiscovery(result: { namespaces: DynamicNamespaceView[] }, input: GetDynamicToolsInput): unknown {
  const tool = (t: DynamicToolView, full: boolean) => ({ tool: t.name, description: t.description, ...(full ? { inputSchema: t.inputSchema } : {}) });
  // Connector namespaces always state their status; the first-party one never does.
  const status = (n: DynamicNamespaceView) => n.kind === "first-party" ? {} : {
    namespaceStatus: n.namespaceStatus,
    ...(n.namespaceStatus === "ready" ? {} : { namespaceError: namespaceError(n) }),
  };
  const describe = (n: DynamicNamespaceView, full: boolean) => {
    const text = full ? (n.kind === "first-party" ? n.description.trim() : sanitizeDescription(n.description)) : descriptionSummary(n.description);
    return text ? { namespaceDescription: text } : {};
  };
  const namespace = (n: DynamicNamespaceView, full: boolean) => ({ namespace: n.name, ...status(n), ...describe(n, full), tools: n.tools.map(t => tool(t, full)) });
  if (input.toolName) return tool(result.namespaces[0]!.tools[0]!, true);
  if (input.pattern) {
    const pattern = searchPattern(input.pattern)!;
    const matches = result.namespaces.flatMap(n => [
      ...(pattern.test(n.name) ? [{ namespace: n.name, ...(descriptionSummary(n.description) ? { description: descriptionSummary(n.description) } : {}), ...status(n) }] : []),
      ...n.tools.map(t => ({ namespace: n.name, tool: t.name, description: t.description, ...(n.namespaceStatus === "ready" || pattern.test(n.name) ? {} : status(n)) }))
    ]).sort((a, b) => a.namespace.localeCompare(b.namespace) || ((a as any).tool ?? "").localeCompare((b as any).tool ?? ""));
    return { mode: "search", pattern: input.pattern, matches };
  }
  if (input.namespace) return { mode: "namespace", ...namespace(result.namespaces[0]!, true) };
  return { mode: "catalog", namespaces: byName(result.namespaces).map(n => namespace(n, false)) };
}

/**
 * Resolve and validate every invocation against the current catalog. A tool
 * runs without a prior schema lookup, as in the reference; its own argument
 * validation still rejects malformed calls.
 */
export const resolveDynamicTool = <Tool extends DynamicToolDefinition>(
  catalog: readonly DynamicNamespaceDefinition<Tool>[],
  input: CallDynamicToolInput,
  options: DynamicLookupOptions = {}
): {
  namespace: DynamicNamespaceDefinition<Tool>;
  tool: Tool;
  arguments: unknown;
} => {
  const namespace = catalog.find((candidate) => candidate.name === input.namespace);
  if (!namespace) {
    const names = catalog.filter((candidate) => candidate.kind === "mcp").map((candidate) => candidate.name).sort();
    throw new DynamicLookupMiss(`MCP server does not exist: ${input.namespace}.${names.length ? ` Available servers: ${names.join(", ")}` : ""}`);
  }
  if (namespace.namespaceStatus !== "ready") {
    const guidance = options.unavailableGuidance?.(namespace);
    throw new Error(`${namespaceError(namespace)}${guidance ? ` ${guidance}` : ""}`);
  }
  const tool = namespace.tools.find((candidate) => candidate.name === input.toolName);
  if (!tool) {
    if (namespace.kind !== "first-party")
      throw new DynamicLookupMiss(`Tool ${input.toolName} was not found. Use GetDynamicTools to discover available servers and their tools.`);
    const names = namespace.tools.map((candidate) => candidate.name);
    throw new Error(names.length
      ? `Built-in tool "${input.toolName}" not found in namespace "${namespace.name}". Available tools: ${names.join(", ")}. Use GetDynamicTools to discover their schemas.`
      : `No built-in tools are available in namespace "${namespace.name}".`);
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
    if (!repaired) throw new Error("Failed to parse arguments string as JSON object. Re-issue the call with `arguments` as a JSON object literal rather than a quoted string.");
    return repaired.args;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object");
  return input as Record<string, unknown>;
}
