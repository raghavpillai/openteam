import type {
  PluginActivityView,
  PluginConnectionView,
  PluginDynamicNamespace,
  PluginInstallView,
  PluginSettingsView,
  SetPluginToolPolicyInput,
} from "@openbot/contracts";
import { ApiError } from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import { Effect } from "effect";
import {
  pluginCatalog,
  pluginDefinition,
  type PluginConnectorDefinition,
  type PluginToolDefinition,
} from "../plugins/catalog";
import { appendEvent, toError, toJson } from "./service-utils";

type JsonObject = Record<string, unknown>;

const jsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const toolSnapshot = (value: unknown): PluginToolDefinition[] =>
  Array.isArray(value)
    ? value.filter(
        (tool): tool is PluginToolDefinition =>
          Boolean(tool) &&
          typeof tool === "object" &&
          typeof (tool as { name?: unknown }).name === "string" &&
          typeof (tool as { description?: unknown }).description === "string"
      )
    : [];

const publicTools = (value: unknown) =>
  toolSnapshot(value).map(({ name, description, risk, defaultDecision }) => ({
    name,
    description,
    risk,
    defaultDecision,
  }));

const statusForRuntime = (status: string): PluginDynamicNamespace["namespaceStatus"] => {
  if (status === "ready") return "ready";
  if (status === "needs_auth") return "needsAuth";
  if (status === "error") return "error";
  return "loading";
};

const namespaceName = (pluginKey: string, alias: string): string =>
  `${pluginKey.replaceAll("-", "_")}_${alias.replace(/[^A-Za-z0-9_]+/g, "_")}`;

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, nested]) => [
      key,
      /token|secret|password|authorization|api.?key/i.test(key) ? "[redacted]" : redact(nested),
    ])
  );
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
    object._openbotOmitted = "Additional object fields were omitted";
  }
  return object;
};

const validateJsonSchema = (
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

const parseMcpResponse = async (response: Response): Promise<JsonObject> => {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MCP server returned ${response.status}: ${raw.slice(0, 500)}`);
  }
  if (!raw.trim()) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== "[DONE]");
    if (!data) throw new Error("MCP server returned an empty event stream");
    return jsonObject(JSON.parse(data));
  }
  return jsonObject(JSON.parse(raw));
};

const mcpHeaders = (sessionId?: string): Record<string, string> => ({
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

const postMcp = async (
  endpoint: string,
  body: JsonObject,
  sessionId?: string
): Promise<{ message: JsonObject; sessionId?: string }> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    message: await parseMcpResponse(response),
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
};

const withMcpSession = async <T>(
  endpoint: string,
  method: "tools/list" | "tools/call",
  params: JsonObject,
  decode: (result: JsonObject) => T
): Promise<T> => {
  const initialized = await postMcp(endpoint, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openbot", version: "0.1.0" },
    },
  });
  if (initialized.message.error) {
    throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.message.error)}`);
  }
  await postMcp(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    initialized.sessionId
  );
  const response = await postMcp(
    endpoint,
    { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
    initialized.sessionId
  );
  if (response.message.error) {
    throw new Error(`MCP ${method} failed: ${JSON.stringify(response.message.error)}`);
  }
  return decode(jsonObject(response.message.result));
};

export const discoverRemoteTools = (endpoint: string): Promise<PluginToolDefinition[]> =>
  withMcpSession(endpoint, "tools/list", {}, (result) => {
    if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned no tools array");
    return result.tools.map((candidate) => {
      const item = jsonObject(candidate);
      if (typeof item.name !== "string") throw new Error("MCP tool is missing a name");
      return {
        name: item.name,
        description: typeof item.description === "string" ? item.description : "",
        inputSchema: jsonObject(item.inputSchema),
        risk: "write",
        defaultDecision: "prompt",
      };
    });
  });

export const invokeRemoteTool = (
  endpoint: string,
  toolName: string,
  args: unknown
): Promise<unknown> =>
  withMcpSession(endpoint, "tools/call", { name: toolName, arguments: args }, (result) => result);

const manifestJson = (plugin: ReturnType<typeof pluginDefinition>) => {
  if (!plugin) throw new Error("Missing plugin definition");
  return toJson(plugin);
};

export class PluginService {
  constructor(private readonly prisma: PrismaClient) {}

  settings = () =>
    Effect.tryPromise({
      try: async (): Promise<PluginSettingsView> => {
        const [installs, bots, policies, activity] = await Promise.all([
          this.prisma.pluginInstallation.findMany({
            include: { connections: { include: { grants: true } }, enablements: true },
            orderBy: { installedAt: "desc" },
          }),
          this.prisma.bot.findMany({
            where: { status: { not: "archived" } },
            select: { id: true, name: true, icon: true, color: true },
            orderBy: { createdAt: "asc" },
          }),
          this.prisma.pluginToolPolicy.findMany({ orderBy: { createdAt: "asc" } }),
          this.prisma.pluginActivity.findMany({
            include: { installation: { select: { pluginKey: true } } },
            orderBy: { createdAt: "desc" },
            take: 100,
          }),
        ]);
        const installedKeys = new Set(installs.map((install) => install.pluginKey));
        const connectionViews = installs.flatMap((install) =>
          install.connections.map((connection) =>
            this.connectionView(install.pluginKey, connection)
          )
        );
        return {
          catalog: pluginCatalog.map((plugin) => ({
            key: plugin.key,
            version: plugin.version,
            name: plugin.name,
            description: plugin.description,
            publisher: plugin.publisher,
            category: plugin.category,
            featured: plugin.featured,
            components: plugin.components,
            skills: plugin.skills.map(({ name, description }) => ({ name, description })),
            installed: installedKeys.has(plugin.key),
            connections: plugin.connections.map(({ endpoint: _endpoint, ...connection }) => ({
              ...connection,
              tools: publicTools(connection.tools),
            })),
          })),
          installs: installs.map(
            (install): PluginInstallView => ({
              id: install.id,
              pluginKey: install.pluginKey,
              version: install.version,
              name: install.name,
              description: install.description,
              publisher: install.publisher,
              status: install.status,
              installedAt: install.installedAt.toISOString(),
              enabledBotIds: install.enablements
                .filter((enablement) => enablement.enabled && enablement.skillsEnabled)
                .map((enablement) => enablement.botId),
              hasSkills: (pluginDefinition(install.pluginKey)?.skills.length ?? 0) > 0,
              connections: install.connections.map((connection) =>
                this.connectionView(install.pluginKey, connection)
              ),
            })
          ),
          connections: connectionViews,
          bots,
          policies: policies.map(({ id, connectionId, botId, toolName, decision }) => ({
            id,
            connectionId,
            botId,
            toolName,
            decision,
          })),
          activity: activity.map(
            (entry): PluginActivityView => ({
              id: entry.id,
              pluginKey: entry.installation?.pluginKey ?? null,
              connectionId: entry.connectionId,
              botId: entry.botId,
              kind: entry.kind,
              summary: entry.summary,
              createdAt: entry.createdAt.toISOString(),
            })
          ),
        };
      },
      catch: toError,
    });

  searchCatalog = async (queryValue: string): Promise<unknown> => {
    const query = queryValue.trim().toLowerCase();
    const installed = new Set(
      (await this.prisma.pluginInstallation.findMany({ select: { pluginKey: true } })).map(
        (item) => item.pluginKey
      )
    );
    return {
      plugins: pluginCatalog
        .filter((plugin) =>
          `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.category}`
            .toLowerCase()
            .includes(query)
        )
        .slice(0, 20)
        .map((plugin) => ({
          key: plugin.key,
          name: plugin.name,
          description: plugin.description,
          category: plugin.category,
          installed: installed.has(plugin.key),
          components: plugin.components,
        })),
    };
  };

  catalogDetail = async (pluginKey: string): Promise<unknown> => {
    const plugin = pluginDefinition(pluginKey);
    const installation = await this.prisma.pluginInstallation.findUnique({
      where: { pluginKey },
      include: { connections: { include: { grants: true } } },
    });
    if (!plugin && !installation) throw new ApiError(404, "plugin_not_found", "Plugin not found");
    return {
      plugin: plugin
        ? {
            key: plugin.key,
            version: plugin.version,
            name: plugin.name,
            description: plugin.description,
            publisher: plugin.publisher,
            category: plugin.category,
            components: plugin.components,
            connections: plugin.connections.map((connection) => ({
              key: connection.key,
              name: connection.name,
              transport: connection.transport,
              auth: connection.auth,
              declaredTools: connection.tools.map((tool) => tool.name),
            })),
          }
        : {
            key: installation?.pluginKey,
            version: installation?.version,
            name: installation?.name,
            description: installation?.description,
            publisher: installation?.publisher,
            components: ["mcp"],
          },
      installed: Boolean(installation),
      connections:
        installation?.connections.map((connection) => ({
          id: connection.id,
          alias: connection.alias,
          status: connection.status,
          transport: connection.transport,
          auth: connection.authType,
          grantedBotCount: connection.grants.filter((grant) => grant.enabled).length,
        })) ?? [],
    };
  };

  connectionStatuses = async (connectionId?: string): Promise<unknown> => ({
    connections: await this.prisma.pluginConnection
      .findMany({
        where: connectionId ? { id: connectionId } : undefined,
        include: { installation: { select: { pluginKey: true, name: true } }, grants: true },
        orderBy: { createdAt: "asc" },
      })
      .then((connections) =>
        connections.map((connection) => ({
          id: connection.id,
          pluginKey: connection.installation.pluginKey,
          pluginName: connection.installation.name,
          name: connection.name,
          alias: connection.alias,
          status: connection.status,
          statusMessage: connection.statusMessage,
          toolCount: toolSnapshot(connection.toolSnapshot).length,
          grantedBotCount: connection.grants.filter((grant) => grant.enabled).length,
          lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
        }))
      ),
  });

  install = (pluginKey: string) =>
    Effect.tryPromise({
      try: async () => {
        const plugin = pluginDefinition(pluginKey);
        if (!plugin) throw new ApiError(404, "plugin_not_found", "Plugin not found");
        const existing = await this.prisma.pluginInstallation.findUnique({ where: { pluginKey } });
        if (existing) return { id: existing.id, installed: true };
        const installation = await this.prisma.$transaction(async (tx) => {
          const created = await tx.pluginInstallation.create({
            data: {
              pluginKey: plugin.key,
              version: plugin.version,
              name: plugin.name,
              description: plugin.description,
              publisher: plugin.publisher,
              manifest: manifestJson(plugin),
            },
          });
          const bots = await tx.bot.findMany({
            where: { status: { not: "archived" } },
            select: { id: true },
          });
          if (bots.length) {
            await tx.botPluginEnablement.createMany({
              data: bots.map((bot) => ({
                botId: bot.id,
                installationId: created.id,
                enabled: false,
                skillsEnabled: false,
              })),
            });
          }
          for (const connector of plugin.connections) {
            const connection = await tx.pluginConnection.create({
              data: {
                installationId: created.id,
                connectorKey: connector.key,
                name: connector.name,
                transport: connector.transport,
                authType: connector.auth,
                endpoint: connector.endpoint,
                status: connector.auth === "none" ? "disconnected" : "needs_auth",
                statusMessage:
                  connector.auth === "none" ? null : "Authentication has not been configured.",
                toolSnapshot: toJson(connector.tools),
              },
            });
            if (connector.tools.length) {
              await tx.pluginToolPolicy.createMany({
                data: connector.tools.map((candidate) => ({
                  connectionId: connection.id,
                  toolName: candidate.name,
                  decision: candidate.defaultDecision,
                })),
              });
            }
          }
          await tx.pluginActivity.create({
            data: {
              installationId: created.id,
              kind: "plugin.installed",
              summary: `Installed ${plugin.name} ${plugin.version}`,
            },
          });
          await appendEvent(tx, "plugin.installed", created.id, {
            pluginKey: plugin.key,
            version: plugin.version,
          });
          return created;
        });
        return { id: installation.id, installed: true };
      },
      catch: toError,
    });

  addCustomMcp = (nameValue: string, urlValue: string, aliasValue = "default") =>
    Effect.tryPromise({
      try: async () => {
        const name = nameValue.trim();
        let endpoint: URL;
        try {
          endpoint = new URL(urlValue.trim());
        } catch {
          throw new ApiError(400, "mcp_url_invalid", "MCP URL is invalid");
        }
        const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
        if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
          throw new ApiError(
            400,
            "mcp_url_insecure",
            "Remote MCP servers must use HTTPS; HTTP is allowed only for loopback development"
          );
        }
        const alias = aliasValue.trim() || "default";
        const pluginKey = `custom-mcp-${crypto.randomUUID()}`;
        const installation = await this.prisma.$transaction(async (tx) => {
          const created = await tx.pluginInstallation.create({
            data: {
              pluginKey,
              version: "0.0.0",
              name,
              description: `Custom MCP server at ${endpoint.origin}`,
              publisher: "Local",
              manifest: toJson({
                key: pluginKey,
                version: "0.0.0",
                name,
                publisher: "Local",
                components: ["mcp"],
                connections: [
                  {
                    key: "custom",
                    name,
                    transport: "http",
                    auth: "none",
                    endpoint: endpoint.toString(),
                  },
                ],
                skills: [],
              }),
            },
          });
          const connection = await tx.pluginConnection.create({
            data: {
              installationId: created.id,
              connectorKey: "custom",
              name,
              alias,
              transport: "http",
              authType: "none",
              endpoint: endpoint.toString(),
              status: "disconnected",
            },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: created.id,
              connectionId: connection.id,
              kind: "custom_mcp.added",
              summary: `Added custom MCP server ${name}`,
              metadata: { origin: endpoint.origin },
            },
          });
          await appendEvent(tx, "plugin.custom_mcp.added", created.id, {
            pluginKey,
            connectionId: connection.id,
            origin: endpoint.origin,
          });
          return { installation: created, connection };
        });
        return {
          pluginKey,
          installationId: installation.installation.id,
          connectionId: installation.connection.id,
        };
      },
      catch: toError,
    });

  uninstall = (pluginKey: string) =>
    Effect.tryPromise({
      try: async () => {
        const installation = await this.prisma.pluginInstallation.findUnique({
          where: { pluginKey },
        });
        if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
        await this.prisma.$transaction(async (tx) => {
          await tx.pluginActivity.create({
            data: {
              kind: "plugin.uninstalled",
              summary: `Uninstalled ${installation.name}`,
              metadata: { pluginKey },
            },
          });
          await tx.pluginInstallation.delete({ where: { id: installation.id } });
          await appendEvent(tx, "plugin.uninstalled", installation.id, { pluginKey });
        });
        return { uninstalled: true };
      },
      catch: toError,
    });

  connect = (connectionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.prisma.pluginConnection.findUnique({
          where: { id: connectionId },
          include: { installation: true },
        });
        if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
        if (connection.authType !== "none") {
          await this.prisma.pluginConnection.update({
            where: { id: connectionId },
            data: {
              status: "needs_auth",
              statusMessage: "OAuth registration is required before this account can connect.",
              lastCheckedAt: new Date(),
            },
          });
          throw new ApiError(
            409,
            "plugin_auth_unavailable",
            "This connector needs provider OAuth registration before it can be connected"
          );
        }
        let tools = toolSnapshot(connection.toolSnapshot);
        if (connection.transport === "http") {
          if (!connection.endpoint) throw new Error("Connection endpoint is missing");
          tools = await discoverRemoteTools(connection.endpoint);
        }
        const updated = await this.prisma.$transaction(async (tx) => {
          await tx.pluginToolPolicy.deleteMany({
            where: { connectionId, botId: null },
          });
          if (tools.length) {
            await tx.pluginToolPolicy.createMany({
              data: tools.map((candidate) => ({
                connectionId,
                toolName: candidate.name,
                decision: candidate.defaultDecision,
              })),
            });
          }
          const value = await tx.pluginConnection.update({
            where: { id: connectionId },
            data: {
              status: "ready",
              statusMessage: null,
              connectedAt: new Date(),
              lastCheckedAt: new Date(),
              toolSnapshot: toJson(tools),
            },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: connection.installationId,
              connectionId,
              kind: "connection.ready",
              summary: `Connected ${connection.name}`,
              metadata: { toolCount: tools.length },
            },
          });
          await appendEvent(tx, "plugin.connection.ready", connectionId, {
            pluginKey: connection.installation.pluginKey,
            toolCount: tools.length,
          });
          return value;
        });
        return { id: updated.id, status: updated.status, toolCount: tools.length };
      },
      catch: toError,
    });

  disconnect = (connectionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.prisma.pluginConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
        await this.prisma.$transaction(async (tx) => {
          await tx.pluginConnection.update({
            where: { id: connectionId },
            data: { status: "disconnected", statusMessage: null, connectedAt: null },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: connection.installationId,
              connectionId,
              kind: "connection.disconnected",
              summary: `Disconnected ${connection.name}`,
            },
          });
          await appendEvent(tx, "plugin.connection.disconnected", connectionId, {});
        });
        return { disconnected: true };
      },
      catch: toError,
    });

  addAccount = (connectionId: string, aliasValue: string) =>
    Effect.tryPromise({
      try: async () => {
        const alias = aliasValue.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,78}[A-Za-z0-9]$/.test(alias)) {
          throw new ApiError(
            400,
            "connection_alias_invalid",
            "Account alias must be 2–80 letters, numbers, spaces, dots, dashes, or underscores"
          );
        }
        const source = await this.prisma.pluginConnection.findUnique({
          where: { id: connectionId },
        });
        if (!source) throw new ApiError(404, "connection_not_found", "Connection not found");
        const duplicate = await this.prisma.pluginConnection.findUnique({
          where: {
            installationId_connectorKey_alias: {
              installationId: source.installationId,
              connectorKey: source.connectorKey,
              alias,
            },
          },
        });
        if (duplicate) {
          throw new ApiError(409, "connection_alias_exists", "That account alias already exists");
        }
        const account = await this.prisma.$transaction(async (tx) => {
          const created = await tx.pluginConnection.create({
            data: {
              installationId: source.installationId,
              connectorKey: source.connectorKey,
              name: source.name,
              alias,
              transport: source.transport,
              authType: source.authType,
              endpoint: source.endpoint,
              status: source.authType === "none" ? "disconnected" : "needs_auth",
              statusMessage:
                source.authType === "none" ? null : "Authentication has not been configured.",
              toolSnapshot: toJson(toolSnapshot(source.toolSnapshot)),
            },
          });
          const tools = toolSnapshot(source.toolSnapshot);
          if (tools.length) {
            await tx.pluginToolPolicy.createMany({
              data: tools.map((tool) => ({
                connectionId: created.id,
                toolName: tool.name,
                decision: tool.defaultDecision,
              })),
            });
          }
          await tx.pluginActivity.create({
            data: {
              installationId: source.installationId,
              connectionId: created.id,
              kind: "connection.created",
              summary: `Added ${source.name} account “${alias}”`,
            },
          });
          await appendEvent(tx, "plugin.connection.created", created.id, { alias });
          return created;
        });
        return { id: account.id, alias: account.alias, status: account.status };
      },
      catch: toError,
    });

  setGrant = (connectionId: string, botId: string, enabled: boolean) =>
    Effect.tryPromise({
      try: async () => {
        const [connection, bot] = await Promise.all([
          this.prisma.pluginConnection.findUnique({ where: { id: connectionId } }),
          this.prisma.bot.findUnique({ where: { id: botId } }),
        ]);
        if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
        if (!bot || bot.status === "archived") {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.botPluginEnablement.upsert({
            where: {
              botId_installationId: { botId, installationId: connection.installationId },
            },
            create: { botId, installationId: connection.installationId, enabled: true },
            update: { enabled: true },
          });
          await tx.botPluginConnectionGrant.upsert({
            where: { botId_connectionId: { botId, connectionId } },
            create: { botId, connectionId, enabled },
            update: { enabled },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: connection.installationId,
              connectionId,
              botId,
              kind: enabled ? "grant.enabled" : "grant.disabled",
              summary: `${enabled ? "Granted" : "Revoked"} ${connection.name} access for ${bot.name}`,
            },
          });
          await appendEvent(tx, "plugin.grant.updated", connectionId, { botId, enabled });
        });
        return { connectionId, botId, enabled };
      },
      catch: toError,
    });

  setEnablement = (pluginKey: string, botId: string, enabled: boolean, skillsEnabled = enabled) =>
    Effect.tryPromise({
      try: async () => {
        const [installation, bot] = await Promise.all([
          this.prisma.pluginInstallation.findUnique({ where: { pluginKey } }),
          this.prisma.bot.findUnique({ where: { id: botId } }),
        ]);
        if (!installation) {
          throw new ApiError(404, "plugin_not_installed", "Plugin is not installed");
        }
        if (!bot || bot.status === "archived") {
          throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.botPluginEnablement.upsert({
            where: { botId_installationId: { botId, installationId: installation.id } },
            create: { botId, installationId: installation.id, enabled, skillsEnabled },
            update: { enabled, skillsEnabled },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: installation.id,
              botId,
              kind: enabled ? "plugin.bot_enabled" : "plugin.bot_disabled",
              summary: `${enabled ? "Enabled" : "Disabled"} ${installation.name} for ${bot.name}`,
            },
          });
          await appendEvent(tx, "plugin.bot_enablement.updated", installation.id, {
            botId,
            enabled,
            skillsEnabled,
          });
        });
        return { pluginKey, botId, enabled, skillsEnabled };
      },
      catch: toError,
    });

  setPolicy = (connectionId: string, input: SetPluginToolPolicyInput) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.prisma.pluginConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
        if (!toolSnapshot(connection.toolSnapshot).some((tool) => tool.name === input.toolName)) {
          throw new ApiError(404, "plugin_tool_not_found", "Tool not found on this connection");
        }
        if (input.botId) {
          const bot = await this.prisma.bot.findUnique({ where: { id: input.botId } });
          if (!bot) throw new ApiError(404, "bot_not_found", "Bot not found");
        }
        const policy = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.pluginToolPolicy.findFirst({
            where: { connectionId, botId: input.botId, toolName: input.toolName },
          });
          const value = existing
            ? await tx.pluginToolPolicy.update({
                where: { id: existing.id },
                data: { decision: input.decision },
              })
            : await tx.pluginToolPolicy.create({
                data: { connectionId, ...input },
              });
          await tx.pluginActivity.create({
            data: {
              installationId: connection.installationId,
              connectionId,
              botId: input.botId,
              kind: "policy.updated",
              summary: `${input.toolName} is now ${input.decision}`,
            },
          });
          await appendEvent(tx, "plugin.policy.updated", connectionId, input);
          return value;
        });
        return { id: policy.id, decision: policy.decision };
      },
      catch: toError,
    });

  dynamicNamespaces = async (botId: string): Promise<PluginDynamicNamespace[]> => {
    const grants = await this.prisma.botPluginConnectionGrant.findMany({
      where: {
        botId,
        enabled: true,
        connection: {
          status: { in: ["ready", "needs_auth", "error"] },
          installation: {
            status: "installed",
            enablements: { some: { botId, enabled: true } },
          },
        },
      },
      include: { connection: { include: { installation: true } } },
      orderBy: { connection: { createdAt: "asc" } },
    });
    return grants.map(({ connection }) => ({
      name: namespaceName(connection.installation.pluginKey, connection.alias),
      description: `${connection.installation.name}: ${connection.name}`,
      namespaceStatus: statusForRuntime(connection.status),
      tools: toolSnapshot(connection.toolSnapshot).map((tool) => ({
        connectionId: connection.id,
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema },
        source: `${connection.installation.pluginKey}/${connection.connectorKey}`,
      })),
    }));
  };

  invoke = async (request: {
    connectionId: string;
    botId: string;
    runId: string;
    callId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<unknown> => {
    const connection = await this.prisma.pluginConnection.findUnique({
      where: { id: request.connectionId },
      include: {
        installation: { include: { enablements: { where: { botId: request.botId } } } },
        grants: { where: { botId: request.botId } },
        policies: { where: { OR: [{ botId: request.botId }, { botId: null }] } },
      },
    });
    if (!connection || connection.installation.status !== "installed") {
      throw new ApiError(404, "plugin_connection_unavailable", "Plugin connection is unavailable");
    }
    if (connection.status !== "ready") {
      throw new ApiError(409, "plugin_connection_not_ready", "Plugin connection is not ready");
    }
    if (!connection.installation.enablements[0]?.enabled || !connection.grants[0]?.enabled) {
      throw new ApiError(403, "plugin_grant_required", "This bot is not granted this connection");
    }
    const tool = toolSnapshot(connection.toolSnapshot).find(
      (candidate) => candidate.name === request.toolName
    );
    if (!tool) throw new ApiError(404, "plugin_tool_not_found", "Plugin tool not found");
    const policy =
      connection.policies.find(
        (candidate) => candidate.botId === request.botId && candidate.toolName === request.toolName
      ) ??
      connection.policies.find(
        (candidate) => candidate.botId === null && candidate.toolName === request.toolName
      );
    const decision = policy?.decision ?? tool.defaultDecision;
    validateJsonSchema(tool.inputSchema, request.arguments);

    const previous = await this.prisma.pluginInvocation.findUnique({
      where: { callId: request.callId },
    });
    if (previous?.status === "completed") return previous.result;
    if (previous) {
      throw new ApiError(409, "plugin_call_replayed", `Plugin call is already ${previous.status}`);
    }
    if (decision !== "allow") {
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginInvocation.create({
          data: {
            callId: request.callId,
            connectionId: request.connectionId,
            botId: request.botId,
            runId: request.runId,
            toolName: request.toolName,
            decision,
            status: "denied",
            arguments: toJson(redact(request.arguments)),
            completedAt: new Date(),
            error: decision === "prompt" ? "Approval required" : "Denied by policy",
          },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId: request.connectionId,
            botId: request.botId,
            kind: decision === "prompt" ? "tool.approval_required" : "tool.denied",
            summary: `${request.toolName} was ${decision === "prompt" ? "held for approval" : "denied"}`,
          },
        });
        if (decision === "prompt") {
          await tx.approval.create({
            data: {
              runId: request.runId,
              upstreamRequestId: `plugin:${request.callId}`,
              requestMethod: "plugin/tool",
              kind: "permissions",
              details: toJson({
                pluginInvocationId: request.callId,
                connectionId: request.connectionId,
                connectionName: connection.name,
                pluginKey: connection.installation.pluginKey,
                botId: request.botId,
                toolName: request.toolName,
                arguments: redact(request.arguments),
                effect: "Accepting allows this tool for this bot. Retry the call on the next turn.",
              }),
            },
          });
        }
      });
      throw new ApiError(
        decision === "prompt" ? 409 : 403,
        decision === "prompt" ? "plugin_approval_required" : "plugin_tool_denied",
        decision === "prompt"
          ? "This plugin tool requires approval. Allow it in Plugin Policies, then retry."
          : "This plugin tool is denied by policy."
      );
    }

    await this.prisma.pluginInvocation.create({
      data: {
        callId: request.callId,
        connectionId: request.connectionId,
        botId: request.botId,
        runId: request.runId,
        toolName: request.toolName,
        decision,
        arguments: toJson(redact(request.arguments)),
      },
    });
    try {
      const rawResult =
        connection.transport === "builtin"
          ? await this.invokeBuiltin(request.toolName, request.arguments, request)
          : await invokeRemoteTool(connection.endpoint ?? "", request.toolName, request.arguments);
      const result = boundPluginResult(redact(rawResult));
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginInvocation.update({
          where: { callId: request.callId },
          data: { status: "completed", result: toJson(result), completedAt: new Date() },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId: request.connectionId,
            botId: request.botId,
            kind: "tool.completed",
            summary: `Called ${request.toolName}`,
          },
        });
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.pluginInvocation.update({
        where: { callId: request.callId },
        data: { status: "failed", error: message.slice(0, 2_000), completedAt: new Date() },
      });
      throw error;
    }
  };

  skillInstructions = async (botId: string): Promise<string> => {
    const enablements = await this.prisma.botPluginEnablement.findMany({
      where: {
        botId,
        enabled: true,
        skillsEnabled: true,
        installation: { status: "installed" },
      },
      include: { installation: true },
    });
    const sections = enablements.flatMap(({ installation }) => {
      const plugin = pluginDefinition(installation.pluginKey);
      return (plugin?.skills ?? []).map(
        (skill) => `### ${plugin?.name}: ${skill.name}\n${skill.description}\n\n${skill.body}`
      );
    });
    return sections.length ? `\n\n## Installed plugin skills\n\n${sections.join("\n\n")}` : "";
  };

  private connectionView(
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
      toolSnapshot: Prisma.JsonValue;
      grants: Array<{ botId: string; enabled: boolean }>;
    }
  ): PluginConnectionView {
    return {
      id: connection.id,
      pluginKey,
      connectorKey: connection.connectorKey,
      name: connection.name,
      alias: connection.alias,
      transport: connection.transport as PluginConnectionView["transport"],
      auth: connection.authType as PluginConnectionView["auth"],
      status: connection.status as PluginConnectionView["status"],
      statusMessage: connection.statusMessage,
      instructions: connection.instructions,
      tools: publicTools(connection.toolSnapshot),
      grantedBotIds: connection.grants.filter((grant) => grant.enabled).map((grant) => grant.botId),
    };
  }

  private async invokeBuiltin(
    toolName: string,
    argsValue: unknown,
    context: { connectionId: string; botId: string }
  ): Promise<unknown> {
    const args = jsonObject(argsValue);
    if (toolName === "echo") return { text: args.text };
    if (toolName === "add") return { value: Number(args.a) + Number(args.b) };
    if (toolName === "remember_note") {
      await this.prisma.pluginActivity.create({
        data: {
          connectionId: context.connectionId,
          botId: context.botId,
          kind: "fixture.note",
          summary: `Remembered: ${String(args.note).slice(0, 160)}`,
        },
      });
      return { remembered: true };
    }
    throw new ApiError(404, "plugin_tool_not_found", "Builtin plugin tool not found");
  }
}

export const pluginConnector = (
  pluginKey: string,
  connectorKey: string
): PluginConnectorDefinition | undefined =>
  pluginDefinition(pluginKey)?.connections.find((connector) => connector.key === connectorKey);
