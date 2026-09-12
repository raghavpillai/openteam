import type { PluginConnectionView, PluginDynamicNamespace } from "@openteam/contracts";
import { ApiError } from "@openteam/contracts";
import type { Prisma } from "@openteam/db";
import type { PluginDefinition, PluginToolDefinition } from "../../plugins/catalog";
import { toJson } from "../service-utils";

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

export const boundPluginResult = (value: unknown, depth = 0): unknown => {
  if (depth >= 8) return "[nested value omitted]";
  if (typeof value === "string") {
    return value.length > 100_000 ? `${value.slice(0, 100_000)}… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => boundPluginResult(item, depth + 1));
    if (value.length > 100) items.push(`[${value.length - 100} items omitted]`);
    return items;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as JsonObject).slice(0, 200);
  const object = Object.fromEntries(
    entries.map(([key, nested]) => [key, boundPluginResult(nested, depth + 1)])
  );
  if (Object.keys(value as JsonObject).length > entries.length) {
    object._openteamOmitted = "Additional object fields were omitted";
  }
  return object;
};

export const validateJsonSchema = (
  schemaValue: Readonly<Record<string, unknown>>,
  value: unknown,
  path = "arguments"
): void => {
  const schema = jsonObject(schemaValue);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(400, "plugin_arguments_invalid", `${path} must be an object`);
    }
    const object = value as JsonObject;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      if (!(key in object)) {
        throw new ApiError(400, "plugin_arguments_invalid", `${path}.${key} is required`);
      }
    }
    const properties = jsonObject(schema.properties);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties));
      if (unknown) {
        throw new ApiError(400, "plugin_arguments_invalid", `${path}.${unknown} is not allowed`);
      }
    }
    for (const [key, nested] of Object.entries(object)) {
      const propertySchema = properties[key];
      if (propertySchema && typeof propertySchema === "object") {
        validateJsonSchema(propertySchema as JsonObject, nested, `${path}.${key}`);
      }
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new ApiError(400, "plugin_arguments_invalid", `${path} must be a string`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new ApiError(400, "plugin_arguments_invalid", `${path} is too long`);
    }
    return;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ApiError(400, "plugin_arguments_invalid", `${path} must be a finite number`);
    }
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new ApiError(400, "plugin_arguments_invalid", `${path} must be a boolean`);
  }
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
    ? /\$\{[A-Z][A-Z0-9_]*\}/.test(value)
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

export const catalogView = (plugin: PluginDefinition, installed: boolean) => ({
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
  logoUrl: plugin.logoUrl ?? null,
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
  configuration: Prisma.JsonValue;
  credentials: Prisma.JsonValue;
}): boolean {
  if (connection.authType === "none") return true;
  const configuration = jsonObject(connection.configuration);
  const credentials = jsonObject(connection.credentials);
  if (connection.authType === "token") {
    return (
      typeof credentials.bearerToken === "string" ||
      Object.keys(stringRecord(configuration.headers)).length > 0
    );
  }
  const oauth = jsonObject(credentials.oauth);
  return (
    typeof configuration.clientId === "string" ||
    typeof jsonObject(oauth.clientInformation).client_id === "string" ||
    Object.keys(jsonObject(oauth.tokens)).length > 0
  );
}

export function oauthRedirectUrl(publicUrl: string, connectionId: string): string {
  return `${publicUrl}/api/v0/plugin-oauth/callback?connectionId=${encodeURIComponent(connectionId)}`;
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
  }
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
    oauthRedirectUrl:
      connection.authType === "oauth" ? oauthRedirectUrl(publicUrl, connection.id) : null,
    canAuthenticate: connection.authType === "oauth" || connection.authType === "token",
    configured: connectionConfigured(connection),
    command:
      typeof jsonObject(connection.configuration).command === "string"
        ? String(jsonObject(connection.configuration).command)
        : null,
    tools: publicTools(connection.toolSnapshot),
  };
}
