import { oauthCallbackMode, MANUAL_OAUTH_REDIRECT } from "../../plugins/oauth-callback";
import { createToolValidator } from "@openteam/plugin-sdk/json-schema";
import type { PluginConnectionView, PluginDynamicNamespace } from "@openteam/contracts";
import { ApiError } from "@openteam/contracts";
import type { Prisma } from "@openteam/db";
import type { PluginDefinition, PluginToolDefinition } from "../../plugins/catalog";
import { toJson } from "../service-utils";
import { pluginIconUrl, substituteConfiguration, fieldsForConnector, validateValues, type ConfigValue } from "@openteam/plugin-sdk";

export function runtimeConfiguration(connection: {
  configuration: Prisma.JsonValue;
  credentials?: Prisma.JsonValue;
}): JsonObject {
  const config = jsonObject(connection.configuration);
  const credentials = jsonObject(connection.credentials);
  const values = { ...jsonObject(config.values), ...jsonObject(credentials.values) } as Record<
    string,
    ConfigValue
  >;
  const resolved = jsonObject(
    substituteConfiguration(
      {
        ...config,
        ...(credentials.headers ? { headers: credentials.headers } : {}),
        ...(credentials.env ? { env: credentials.env } : {}),
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      },
      values
    )
  );
  for (const key of ["clientId", "clientSecret", "scope"])
    if (values[key] !== undefined) resolved[key] = values[key];
  for (const key of ["headers", "env"])
    if (resolved[key])
      resolved[key] = Object.fromEntries(
        Object.entries(jsonObject(resolved[key])).map(([name, value]) => [name, String(value)])
      );
  if (Array.isArray(resolved.args)) resolved.args = resolved.args.map(String);
  return resolved;
}

export function runtimeEndpoint(connection: {
  endpoint: string | null;
  configuration: Prisma.JsonValue;
  credentials?: Prisma.JsonValue;
}): string | null {
  const config = jsonObject(connection.configuration);
  const credentials = jsonObject(connection.credentials);
  const values = { ...jsonObject(config.values), ...jsonObject(credentials.values) } as Record<
    string,
    ConfigValue
  >;
  const endpoint = substituteConfiguration(connection.endpoint, values);
  return typeof endpoint === "string" ? endpoint : null;
}

export function redactConnectionSecrets(
  value: unknown,
  connection: { configuration: Prisma.JsonValue; credentials: Prisma.JsonValue }
): unknown {
  const values: string[] = [];
  const collect = (entry: unknown) => {
    if (typeof entry === "string" && entry.length >= 4) values.push(entry);
    else if (Array.isArray(entry)) entry.forEach(collect);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(collect);
  };
  collect(connection.credentials);
  const config = jsonObject(connection.configuration);
  collect(config.clientSecret);
  collect(config.headers);
  collect(config.env);
  const scrub = (entry: unknown): unknown =>
    typeof entry === "string"
      ? values.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), entry)
      : Array.isArray(entry)
        ? entry.map(scrub)
        : entry && typeof entry === "object"
          ? Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, scrub(nested)]))
          : entry;
  return scrub(redact(value));
}

export type JsonObject = Record<string, unknown>;

export const jsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

export const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(jsonObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const toolSnapshot = (value: unknown): PluginToolDefinition[] =>
  Array.isArray(value)
    ? value.filter(
        (tool): tool is PluginToolDefinition =>
          Boolean(tool) &&
          typeof tool === "object" &&
          typeof (tool as { name?: unknown }).name === "string" &&
          typeof (tool as { description?: unknown }).description === "string"
      )
    : [];

export const publicTools = (value: unknown) =>
  toolSnapshot(value).map(({ name, description, risk, defaultDecision }) => ({
    name,
    description,
    risk,
    defaultDecision,
  }));

export const statusForRuntime = (status: string): PluginDynamicNamespace["namespaceStatus"] => {
  if (status === "ready") return "ready";
  if (status === "needs_auth") return "needsAuth";
  if (status === "error") return "error";
  return "loading";
};

export const normalizedConnectorKey = (value: string): string =>
  value.trim().toLowerCase().replaceAll("_", "-");

export const channelDeliveryTool = (
  tools: readonly PluginToolDefinition[]
): PluginToolDefinition | null =>
  [...tools]
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      if (
        ["conversations_add_message", "chat_postmessage", "send_message", "post_message"].includes(
          name
        )
      )
        score += 100;
      if (/(?:send|post|add).*(?:message)/.test(name)) score += 30;
      if (/(?:send|post).*(?:message)/.test(description)) score += 10;
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.tool ?? null;

export const channelDeliveryArguments = (
  tool: PluginToolDefinition,
  chat: string,
  content: string
): Record<string, unknown> => {
  const schema = jsonObject(tool.inputSchema);
  const properties = jsonObject(schema.properties);
  const args: Record<string, unknown> = {};
  const channelField = [
    "channel_id",
    "channelId",
    "channel",
    "conversation_id",
    "conversationId",
    "conversation",
    "chat_id",
    "chatId",
    "chat",
    "recipient",
  ].find((field) => field in properties);
  const contentField = ["content", "message", "text", "body", "markdown"].find(
    (field) => field in properties
  );
  if (!channelField || !contentField) {
    throw new ApiError(
      409,
      "connected_channel_tool_incompatible",
      `The connector's ${tool.name} tool does not expose channel and message fields`
    );
  }
  args[channelField] = chat;
  const contentSchema = jsonObject(properties[contentField]);
  if (contentSchema.type === "array") {
    const item = jsonObject(contentSchema.items);
    args[contentField] = item.type === "object" ? [{ type: "text", text: content }] : [content];
  } else {
    args[contentField] = content;
  }
  return args;
};

export const namespaceName = (pluginKey: string, alias: string): string =>
  `${pluginKey.replaceAll("-", "_")}_${alias.replace(/[^A-Za-z0-9_]+/g, "_")}`;

export const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, nested]) => [
      key,
      /token|secret|password|authorization|api.?key/i.test(key) ? "[redacted]" : redact(nested),
    ])
  );
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const boundPluginResult = (
  value: unknown,
  depth = 0,
  budget = { remaining: 200_000 }
): unknown => {
  if (budget.remaining <= 0) return "[result limit reached]";
  budget.remaining -= 20;
  if (depth >= 8) return "[nested value omitted]";
  if (typeof value === "string") {
    const limit = Math.max(0, Math.min(100_000, budget.remaining));
    budget.remaining -= Math.min(value.length, limit);
    return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, 100)) {
      if (budget.remaining <= 0) break;
      items.push(boundPluginResult(item, depth + 1, budget));
    }
    if (value.length > 100) items.push(`[${value.length - 100} items omitted]`);
    return items;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as JsonObject).slice(0, 200);
  const object: JsonObject = {};
  for (const [key, nested] of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining -= key.length;
    object[key.slice(0, 1000)] = boundPluginResult(nested, depth + 1, budget);
  }
  if (Object.keys(value as JsonObject).length > entries.length) {
    object._openteamOmitted = "Additional object fields were omitted";
  }
  return object;
};

export const validateJsonSchema = (
  schema: Readonly<Record<string, unknown>>,
  value: unknown
): void => {
  let validator;
  try {
    validator = createToolValidator(schema);
  } catch {
    throw new ApiError(
      409,
      "plugin_schema_invalid",
      "The provider returned an invalid tool schema. Refresh its tools or contact the plugin author."
    );
  }
  const result = validator(value);
  if (!result.valid)
    throw new ApiError(
      400,
      "plugin_arguments_invalid",
      `Invalid tool arguments: ${result.errorMessage}`
    );
};

export const manifestJson = (plugin: PluginDefinition) => toJson(plugin);

export const substituteValues = (value: unknown, values: Record<string, string>): unknown => {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z][A-Z0-9_]*)\}/g,
      (placeholder, key: string) => values[key] ?? placeholder
    );
  }
  if (Array.isArray(value)) return value.map((item) => substituteValues(item, values));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, nested]) => [
      key,
      substituteValues(nested, values),
    ])
  );
};

export const hasPlaceholder = (value: unknown): boolean =>
  typeof value === "string"
    ? /\$\{(?!PLUGIN_ROOT\})[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
    : Array.isArray(value)
      ? value.some(hasPlaceholder)
      : Boolean(value && typeof value === "object" && Object.values(value).some(hasPlaceholder));

export const definitionFromManifest = (value: unknown): PluginDefinition | undefined => {
  const manifest = jsonObject(value);
  if (
    typeof manifest.key !== "string" ||
    typeof manifest.name !== "string" ||
    !Array.isArray(manifest.connections) ||
    !Array.isArray(manifest.skills)
  ) {
    return undefined;
  }
  return manifest as unknown as PluginDefinition;
};

export const catalogView = (
  plugin: PluginDefinition,
  installed: boolean,
  iconFallback?: PluginDefinition
) => ({
  key: plugin.key,
  version: plugin.version,
  name: plugin.name,
  description: plugin.description,
  publisher: plugin.publisher,
  category: plugin.category,
  featured: plugin.featured,
  components: plugin.components,
  skills: plugin.skills.map(({ name, description }) => ({ name, description })),
  installed,
  homepageUrl: plugin.homepageUrl ?? null,
  sourceUrl: plugin.sourceUrl ?? null,
  sourceRevision: plugin.sourceRevision ?? null,
  // Older installed snapshots can use the catalog artwork without updating their package.
  logoUrl: pluginIconUrl(plugin) ?? (iconFallback ? pluginIconUrl(iconFallback) : null),
  installationSteps: plugin.installationSteps ?? ["Install the plugin from the registry.", ...(plugin.connections.length ? ["Complete any provider setup, then connect your account.", "Confirm the connection is ready and enable access for the Bots that need it."] : ["Enable the plugin for the Bots that need it."])],
  setupFields: plugin.setupFields ?? [],
  setup: plugin.setup ?? null,
  connections: plugin.connections.map(
    ({ endpoint: _endpoint, configuration: _configuration, ...connection }) => ({
      ...connection,
      tools: publicTools(connection.tools),
    })
  ),
});

export function validAlias(value: string): string {
  const alias = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,78}[A-Za-z0-9]$/.test(alias)) {
    throw new ApiError(
      400,
      "connection_alias_invalid",
      "Account alias must be 2–80 letters, numbers, spaces, dots, dashes, or underscores"
    );
  }
  return alias;
}

export function connectionConfigured(connection: {
  authType: string;
  configuration: unknown;
  credentials: unknown;
  connectorKey?: string;
}, plugin?: PluginDefinition): boolean {
  const configuration = runtimeConfiguration({ configuration: connection.configuration as Prisma.JsonValue, credentials: connection.credentials as Prisma.JsonValue });
  if (hasPlaceholder(configuration)) return false;
  if (plugin && connection.connectorKey) {
    const credentials = jsonObject(connection.credentials);
    const values = { ...jsonObject(configuration.values), ...jsonObject(credentials.values), ...configuration, ...(credentials.bearerToken ? { token: credentials.bearerToken } : {}) };
    const fields = fieldsForConnector(plugin, connection.connectorKey);
    try { validateValues(fields, Object.fromEntries(Object.entries(values).filter(([key]) => fields.some(field => field.key === key)))); } catch { return false; }
    if (connection.authType === "oauth" && plugin.connections.find(c => c.key === connection.connectorKey)?.oauth?.registration !== "manual") return true;
  }
  if (connection.authType === "none") return true;
  const credentials = jsonObject(connection.credentials);
  if (connection.authType === "token") {
    return (
      typeof credentials.bearerToken === "string" ||
      Object.keys(stringRecord(configuration.headers)).length > 0
    );
  }
  const oauth = jsonObject(credentials.oauth);
  return (
    (typeof configuration.clientId === "string" && configuration.clientId.trim().length > 0) ||
    typeof jsonObject(oauth.clientInformation).client_id === "string" ||
    Object.keys(jsonObject(oauth.tokens)).length > 0
  );
}

export function connectionSetupPhase(connection: Parameters<typeof connectionConfigured>[0] & { status: string }, plugin?: PluginDefinition): NonNullable<PluginConnectionView["setupPhase"]> {
  if (!connectionConfigured(connection, plugin)) return "provider_setup_required";
  if (connection.status === "ready") return "connected";
  if (connection.status === "error") return "validation_failed";
  if (typeof jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl === "string") return "authorization_pending";
  return connection.authType === "oauth" ? "ready_to_authorize" : "ready_to_connect";
}

export function connectionCallbackMode(publicUrl: string, connection: { configuration: unknown; credentials: unknown }): NonNullable<PluginConnectionView["oauthCallbackMode"]> {
  const oauth = jsonObject(jsonObject(connection.credentials).oauth);
  if (typeof oauth.authorizationUrl === "string") {
    return oauth.callbackMode === "manual" || oauth.callbackMode === "desktop" ? oauth.callbackMode : "server";
  }
  return oauthCallbackMode(publicUrl, jsonObject(connection.configuration));
}

export function oauthRedirectUrl(publicUrl: string, _connectionId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/v0/plugin-oauth/callback`;
}

export function connectionView(
  publicUrl: string,
  pluginKey: string,
  connection: {
    id: string;
    connectorKey: string;
    name: string;
    alias: string;
    transport: string;
    authType: string;
    status: string;
    statusMessage: string | null;
    instructions: string;
    configuration: Prisma.JsonValue;
    credentials: Prisma.JsonValue;
    toolSnapshot: Prisma.JsonValue;
    updatedAt: Date;
  },
  plugin?: PluginDefinition
): PluginConnectionView {
  return {
    id: connection.id,
    revision: connection.updatedAt.toISOString(),
    pluginKey,
    connectorKey: connection.connectorKey,
    name: connection.name,
    alias: connection.alias,
    transport: connection.transport as PluginConnectionView["transport"],
    auth: connection.authType as PluginConnectionView["auth"],
    status: connection.status as PluginConnectionView["status"],
    statusMessage: connection.statusMessage,
    instructions: connection.instructions,
    authorizationUrl:
      typeof jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl === "string"
        ? String(jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl)
        : null,
    authorizationExpiresAt: oauthAuthorizationExpiry(connection.credentials),
    oauthRedirectUrl:
      connection.authType === "oauth" ? (oauthCallbackMode(publicUrl, jsonObject(connection.configuration)) === "manual" ? MANUAL_OAUTH_REDIRECT : oauthRedirectUrl(publicUrl, connection.id)) : null,
    oauthCallbackMode: connectionCallbackMode(publicUrl, connection),
    setupPhase: connectionSetupPhase(connection, plugin),
    oauthLoopbackPort: Number(jsonObject(connection.configuration).oauthLoopbackPort ?? 0),
    canAuthenticate: connection.authType === "oauth" || connection.authType === "token",
    configured: connectionConfigured(connection, plugin),
    command:
      typeof jsonObject(connection.configuration).command === "string"
        ? String(jsonObject(connection.configuration).command)
        : null,
    tools: publicTools(connection.toolSnapshot),
  };
}

export function oauthAuthorizationExpiry(credentials: Prisma.JsonValue): string | null {
  const oauth = jsonObject(jsonObject(credentials).oauth);
  return typeof oauth.authorizationUrl === "string" && typeof oauth.stateCreatedAt === "number"
    ? new Date(oauth.stateCreatedAt + 15 * 60_000).toISOString()
    : null;
}
