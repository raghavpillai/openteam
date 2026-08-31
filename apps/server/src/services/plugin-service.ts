import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  ConfigurePluginConnectionInput,
  PluginActivityView,
  PluginConnectionView,
  PluginDynamicNamespace,
  PluginInstallView,
  PluginSettingsView,
  SetPluginToolPolicyInput,
} from "@openbot/contracts";
import { ApiError } from "@openbot/contracts";
import type { Prisma, PrismaClient } from "@openbot/db";
import type { AgentDataStore } from "@openbot/messaging";
import { Effect } from "effect";
import type { PluginDefinition, PluginToolDefinition } from "../plugins/catalog";
import { McpHttpClientManager } from "../plugins/mcp-client-manager";
import { OpenBotOAuthProvider, type StoredOAuthState } from "../plugins/oauth-provider";
import { OpenBotMarketplaceSource } from "../plugins/openbot-marketplace";
import { appendEvent, toError, toJson } from "./service-utils";

type JsonObject = Record<string, unknown>;

const jsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(jsonObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

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

const canonicalJson = (value: unknown): string => {
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

const compatibilityHttpManager = new McpHttpClientManager();

export const discoverRemoteTools = (endpoint: string): Promise<PluginToolDefinition[]> =>
  compatibilityHttpManager.discover(`compat:${endpoint}`, { endpoint });

export const invokeRemoteTool = (
  endpoint: string,
  toolName: string,
  args: unknown
): Promise<unknown> =>
  compatibilityHttpManager.call(`compat:${endpoint}`, { endpoint }, toolName, args);

const manifestJson = (plugin: PluginDefinition) => toJson(plugin);

const substituteValues = (value: unknown, values: Record<string, string>): unknown => {
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

const hasPlaceholder = (value: unknown): boolean =>
  typeof value === "string"
    ? /\$\{[A-Z][A-Z0-9_]*\}/.test(value)
    : Array.isArray(value)
      ? value.some(hasPlaceholder)
      : Boolean(value && typeof value === "object" && Object.values(value).some(hasPlaceholder));

const definitionFromManifest = (value: unknown): PluginDefinition | undefined => {
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

export class PluginService {
  private readonly http = new McpHttpClientManager();
  private readonly marketplace = new OpenBotMarketplaceSource();
  private readonly publicUrl =
    process.env.OPENBOT_PUBLIC_URL ?? `http://127.0.0.1:${process.env.OPENBOT_PORT ?? "8787"}`;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerFetch?: (path: string, init?: RequestInit) => Promise<Response>,
    private readonly agentData?: Pick<AgentDataStore, "syncPluginSkillCache">
  ) {}

  syncFileCaches = async (): Promise<void> => {
    if (!this.agentData) return;
    const installations = await this.prisma.pluginInstallation.findMany({
      where: { status: "installed" },
      orderBy: { installedAt: "asc" },
    });
    await this.agentData.syncPluginSkillCache(
      installations.flatMap((installation) => {
        const plugin = definitionFromManifest(installation.manifest);
        if (!plugin) return [];
        return [
          {
            id: plugin.key,
            name: plugin.name,
            version: plugin.version,
            publisher: plugin.publisher,
            skills: plugin.skills,
          },
        ];
      })
    );
  };

  private catalog = async (): Promise<PluginDefinition[]> => {
    return this.marketplace.plugins();
  };

  private definition = async (pluginKey: string): Promise<PluginDefinition | undefined> =>
    (await this.catalog()).find((plugin) => plugin.key === pluginKey);

  private catalogView = (plugin: PluginDefinition, installed: boolean) => ({
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

  settings = () =>
    Effect.tryPromise({
      try: async (): Promise<PluginSettingsView> => {
        const [catalog, installs, bots, policies, activity] = await Promise.all([
          this.catalog(),
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
          catalog: catalog.map((plugin) => this.catalogView(plugin, installedKeys.has(plugin.key))),
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
              hasSkills: (definitionFromManifest(install.manifest)?.skills.length ?? 0) > 0,
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
      plugins: (await this.catalog())
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
    const plugin = await this.definition(pluginKey);
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
            homepageUrl: plugin.homepageUrl ?? null,
            sourceUrl: plugin.sourceUrl ?? null,
            sourceRevision: plugin.sourceRevision ?? null,
            setupFields: plugin.setupFields ?? [],
            setup: plugin.setup ?? null,
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

  requestAction = async (request: {
    runId: string;
    botId: string;
    callId: string;
    action: string;
    arguments: unknown;
  }): Promise<never> => {
    const existing = await this.prisma.approval.findUnique({
      where: { upstreamRequestId: `plugin-action:${request.callId}` },
    });
    if (!existing) {
      await this.prisma.approval.create({
        data: {
          runId: request.runId,
          upstreamRequestId: `plugin-action:${request.callId}`,
          requestMethod: "plugin/action",
          kind: "permissions",
          details: toJson({
            action: request.action,
            arguments: redact(request.arguments),
            rawArguments: request.arguments,
            botId: request.botId,
            effect: `Confirm ${request.action} in OpenBot. Changes are available on the next bot turn.`,
          }),
        },
      });
    }
    throw new ApiError(
      409,
      "plugin_action_required",
      `${request.action} is waiting for user confirmation`
    );
  };

  resolveAction = async (
    detailsValue: unknown,
    decision: "accept" | "decline" | "cancel"
  ): Promise<unknown> => {
    if (decision !== "accept") return { status: decision === "decline" ? "declined" : "cancelled" };
    const details = jsonObject(detailsValue);
    const action = details.action;
    const args = jsonObject(details.rawArguments);
    if (typeof action !== "string") {
      throw new ApiError(409, "plugin_action_invalid", "Plugin action is missing its name");
    }
    if (action === "InstallPlugin") {
      if (typeof args.pluginKey !== "string")
        throw new ApiError(400, "plugin_key_required", "pluginKey is required");
      return Effect.runPromise(this.install(args.pluginKey, stringRecord(args.values)));
    }
    if (action === "UninstallPlugin") {
      if (typeof args.pluginKey !== "string")
        throw new ApiError(400, "plugin_key_required", "pluginKey is required");
      return Effect.runPromise(this.uninstall(args.pluginKey));
    }
    if (action === "AddMcpServer") {
      return Effect.runPromise(
        this.addCustomMcp({
          name: typeof args.name === "string" ? args.name : "Custom MCP",
          url: typeof args.url === "string" ? args.url : undefined,
          command: typeof args.command === "string" ? args.command : undefined,
          args: stringArray(args.args),
          env: stringRecord(args.env),
          headers: stringRecord(args.headers),
          auth:
            args.auth === "oauth" || args.auth === "token" || args.auth === "none"
              ? args.auth
              : undefined,
          alias: typeof args.accountLabel === "string" ? args.accountLabel : undefined,
        })
      );
    }
    const connectionId = typeof args.connectionId === "string" ? args.connectionId : undefined;
    if (!connectionId) {
      throw new ApiError(400, "connection_id_required", "connectionId is required");
    }
    if (action === "UninstallMcpServer") {
      const connection = await this.connectionOrThrow(connectionId);
      if (!connection.installation.pluginKey.startsWith("custom-mcp-")) {
        throw new ApiError(
          409,
          "marketplace_plugin_required",
          "Marketplace MCP servers must be removed by uninstalling their plugin"
        );
      }
      return Effect.runPromise(this.uninstall(connection.installation.pluginKey));
    }
    if (action === "AuthenticateMcpServer") {
      return Effect.runPromise(this.authenticate(connectionId, args.forceReauth === true));
    }
    if (action === "RestartMcpServers") return Effect.runPromise(this.restart(connectionId));
    if (action === "RemoveMcpAccount") return Effect.runPromise(this.removeAccount(connectionId));
    if (action === "RenameMcpAccount") {
      if (typeof args.accountLabel !== "string")
        throw new ApiError(400, "account_label_required", "accountLabel is required");
      return Effect.runPromise(this.renameAccount(connectionId, args.accountLabel));
    }
    if (action === "SetMcpInstructions") {
      return Effect.runPromise(
        this.setInstructions(
          connectionId,
          typeof args.instructions === "string" ? args.instructions : ""
        )
      );
    }
    throw new ApiError(400, "plugin_action_unknown", `Unknown plugin action ${action}`);
  };

  install = (pluginKey: string, values: Record<string, string> = {}) =>
    Effect.tryPromise({
      try: async () => {
        const plugin = await this.definition(pluginKey);
        if (!plugin) throw new ApiError(404, "plugin_not_found", "Plugin not found");
        const existing = await this.prisma.pluginInstallation.findUnique({ where: { pluginKey } });
        if (existing) {
          await this.syncFileCaches();
          return { id: existing.id, installed: true };
        }
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
            const endpoint = substituteValues(connector.endpoint, values) as string;
            const configuration = substituteValues(connector.configuration ?? {}, values);
            const missingSetup = hasPlaceholder(endpoint) || hasPlaceholder(configuration);
            const connection = await tx.pluginConnection.create({
              data: {
                installationId: created.id,
                connectorKey: connector.key,
                name: connector.name,
                transport: connector.transport,
                authType: connector.auth,
                endpoint,
                configuration: toJson(configuration),
                status: connector.auth === "none" && !missingSetup ? "disconnected" : "needs_auth",
                statusMessage: missingSetup
                  ? "Plugin setup values are required."
                  : connector.auth === "none"
                    ? null
                    : "Authentication has not been configured.",
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
        await this.syncFileCaches();
        return { id: installation.id, installed: true };
      },
      catch: toError,
    });

  addCustomMcp = (input: {
    name: string;
    url?: string;
    command?: string;
    args?: readonly string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    auth?: "none" | "token" | "oauth";
    alias?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const name = input.name.trim();
        const command = input.command?.trim();
        const transport = command ? "stdio" : "http";
        if (Boolean(command) === Boolean(input.url)) {
          throw new ApiError(
            400,
            "mcp_transport_invalid",
            "Provide exactly one remote URL or local command"
          );
        }
        let endpoint: URL | null = null;
        if (input.url) {
          try {
            endpoint = new URL(input.url.trim());
          } catch {
            throw new ApiError(400, "mcp_url_invalid", "MCP URL is invalid");
          }
          if (!["https:", "http:"].includes(endpoint.protocol)) {
            throw new ApiError(400, "mcp_url_invalid", "MCP URL must use HTTP or HTTPS");
          }
        }
        const authType = input.auth ?? (Object.keys(input.headers ?? {}).length ? "token" : "none");
        const alias = input.alias?.trim() || "default";
        const configuration = {
          ...(command
            ? { command, args: [...(input.args ?? [])], env: { ...(input.env ?? {}) } }
            : { headers: { ...(input.headers ?? {}) } }),
        };
        const pluginKey = `custom-mcp-${crypto.randomUUID()}`;
        const installation = await this.prisma.$transaction(async (tx) => {
          const created = await tx.pluginInstallation.create({
            data: {
              pluginKey,
              version: "0.0.0",
              name,
              description: command
                ? `Local MCP server launched with ${command}`
                : `Custom MCP server at ${endpoint?.origin ?? "remote endpoint"}`,
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
                    transport,
                    auth: authType,
                    endpoint: endpoint?.toString(),
                    configuration,
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
              transport,
              authType,
              endpoint: endpoint?.toString(),
              configuration: toJson(configuration),
              status: authType === "oauth" ? "needs_auth" : "disconnected",
              statusMessage:
                authType === "oauth" ? "Authentication has not been configured." : null,
            },
          });
          await tx.pluginActivity.create({
            data: {
              installationId: created.id,
              connectionId: connection.id,
              kind: "custom_mcp.added",
              summary: `Added custom MCP server ${name}`,
              metadata: command ? { command } : { origin: endpoint?.origin },
            },
          });
          await appendEvent(tx, "plugin.custom_mcp.added", created.id, {
            pluginKey,
            connectionId: connection.id,
            transport,
            endpoint: endpoint?.origin ?? command,
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
          include: { connections: { select: { id: true, transport: true } } },
        });
        if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
        await Promise.all(
          installation.connections.map((connection) =>
            this.stopRuntime(connection.id, connection.transport)
          )
        );
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
        await this.syncFileCaches();
        return { uninstalled: true };
      },
      catch: toError,
    });

  configure = (connectionId: string, input: ConfigurePluginConnectionInput) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.prisma.pluginConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
        await this.stopRuntime(connectionId, connection.transport);
        const configuration = jsonObject(connection.configuration);
        const credentials = jsonObject(connection.credentials);
        const nextConfiguration = {
          ...configuration,
          ...(input.headers ? { headers: input.headers } : {}),
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
        };
        const nextCredentials = {
          ...credentials,
          ...(input.token ? { bearerToken: input.token } : {}),
        };
        await this.http.close(connectionId);
        const updated = await this.prisma.pluginConnection.update({
          where: { id: connectionId },
          data: {
            configuration: toJson(nextConfiguration),
            credentials: toJson(nextCredentials),
            status: "disconnected",
            statusMessage: null,
          },
        });
        return { id: updated.id, configured: true };
      },
      catch: toError,
    });

  authenticate = (connectionId: string, force = false) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        if (connection.transport !== "http" || connection.authType !== "oauth") {
          throw new ApiError(409, "plugin_oauth_unsupported", "This connection does not use OAuth");
        }
        const current = jsonObject(connection.credentials);
        const oauth = force ? {} : jsonObject(current.oauth);
        const state = crypto.randomUUID();
        const next = { ...current, oauth: { ...oauth, state } };
        await this.prisma.pluginConnection.update({
          where: { id: connectionId },
          data: {
            credentials: toJson(next),
            status: "needs_auth",
            statusMessage: "Waiting for authorization in your browser.",
            lastCheckedAt: new Date(),
          },
        });
        const refreshed = await this.connectionOrThrow(connectionId);
        const options = this.httpOptions(refreshed);
        let result: { authorizationUrl: string };
        try {
          result = await this.http.beginOAuth(connectionId, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.prisma.pluginConnection.update({
            where: { id: connectionId },
            data: {
              status: "needs_auth",
              statusMessage: message.includes("dynamic client registration")
                ? "Configure an OAuth client ID for this self-hosted connector."
                : message,
            },
          });
          throw error;
        }
        await this.prisma.pluginActivity.create({
          data: {
            installationId: refreshed.installationId,
            connectionId,
            kind: "connection.oauth_started",
            summary: `Started authentication for ${refreshed.name} (${refreshed.alias})`,
          },
        });
        return { connectionId, status: "needs_auth", authorizationUrl: result.authorizationUrl };
      },
      catch: toError,
    });

  finishAuthentication = (connectionId: string, code: string, state: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        const oauth = jsonObject(jsonObject(connection.credentials).oauth);
        if (!oauth.state || oauth.state !== state) {
          throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
        }
        const tools = await this.http.finishOAuth(connectionId, this.httpOptions(connection), code);
        await this.markReady(connection, tools, "connection.oauth_completed");
        return { connectionId, status: "ready", toolCount: tools.length };
      },
      catch: toError,
    });

  connect = (connectionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        if (connection.authType === "oauth") {
          const oauth = jsonObject(jsonObject(connection.credentials).oauth);
          if (!oauth.tokens) return Effect.runPromise(this.authenticate(connectionId));
        }
        if (
          connection.authType === "token" &&
          !jsonObject(connection.credentials).bearerToken &&
          Object.keys(stringRecord(jsonObject(connection.configuration).headers)).length === 0
        ) {
          await this.prisma.pluginConnection.update({
            where: { id: connectionId },
            data: { status: "needs_auth", statusMessage: "Add a token or request headers first." },
          });
          throw new ApiError(
            409,
            "plugin_token_required",
            "This connector needs a token or headers"
          );
        }
        let tools = toolSnapshot(connection.toolSnapshot);
        if (connection.transport === "http") {
          if (!connection.endpoint) throw new Error("Connection endpoint is missing");
          tools = await this.http.discover(connectionId, this.httpOptions(connection));
        } else if (connection.transport === "stdio") {
          tools = await this.discoverStdio(connection);
        }
        const updated = await this.markReady(connection, tools);
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
              configuration: toJson(jsonObject(source.configuration)),
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

  renameAccount = (connectionId: string, aliasValue: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        const alias = this.validAlias(aliasValue);
        const updated = await this.prisma.pluginConnection.update({
          where: { id: connectionId },
          data: { alias },
        });
        await this.prisma.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId,
            kind: "connection.renamed",
            summary: `Renamed ${connection.alias} to ${alias}`,
          },
        });
        return { id: updated.id, alias: updated.alias };
      },
      catch: toError,
    });

  removeAccount = (connectionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        const siblings = await this.prisma.pluginConnection.count({
          where: {
            installationId: connection.installationId,
            connectorKey: connection.connectorKey,
          },
        });
        if (siblings <= 1) {
          await this.stopRuntime(connectionId, connection.transport);
          await this.prisma.pluginConnection.update({
            where: { id: connectionId },
            data: {
              alias: "default",
              credentials: toJson({}),
              status: connection.authType === "none" ? "disconnected" : "needs_auth",
              statusMessage:
                connection.authType === "none" ? null : "Authentication has not been configured.",
              connectedAt: null,
            },
          });
          return { removed: true, reset: true };
        }
        await this.stopRuntime(connectionId, connection.transport);
        await this.prisma.pluginConnection.delete({ where: { id: connectionId } });
        return { removed: true };
      },
      catch: toError,
    });

  setInstructions = (connectionId: string, instructionsValue: string) =>
    Effect.tryPromise({
      try: async () => {
        const instructions = instructionsValue.trim().slice(0, 500);
        const connection = await this.connectionOrThrow(connectionId);
        await this.prisma.pluginConnection.update({
          where: { id: connectionId },
          data: { instructions },
        });
        await this.prisma.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId,
            kind: "connection.instructions_updated",
            summary: instructions
              ? `Updated instructions for ${connection.name}`
              : `Cleared instructions for ${connection.name}`,
          },
        });
        return { id: connectionId, instructions };
      },
      catch: toError,
    });

  restart = (connectionId: string) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await this.connectionOrThrow(connectionId);
        await this.stopRuntime(connectionId, connection.transport);
        return Effect.runPromise(this.connect(connectionId));
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
      description: `${connection.installation.name}: ${connection.name}${connection.instructions ? `\nSaved instructions: ${connection.instructions}` : ""}`,
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
    if (decision === "prompt") {
      const pendingApprovals = await this.prisma.approval.findMany({
        where: { runId: request.runId, requestMethod: "plugin/tool", status: "pending" },
        select: { details: true },
      });
      const duplicate = pendingApprovals.some(({ details: value }) => {
        const details = jsonObject(value);
        return (
          details.connectionId === request.connectionId &&
          details.toolName === request.toolName &&
          canonicalJson(details.arguments) === canonicalJson(redact(request.arguments))
        );
      });
      if (duplicate) {
        throw new ApiError(
          409,
          "plugin_approval_required",
          "This exact plugin tool call is already waiting for one-time approval."
        );
      }
      if (pendingApprovals.length > 0) {
        throw new ApiError(
          409,
          "plugin_approval_pending",
          "Resolve the pending approval before starting another plugin side effect."
        );
      }
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
            status: decision === "prompt" ? "running" : "denied",
            arguments: toJson(request.arguments),
            completedAt: decision === "prompt" ? null : new Date(),
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
                supportsAlwaysAllow: true,
                effect:
                  "Allow once runs this exact call without changing policy. Always allow also saves an allow policy for this bot, connection, and tool.",
              }),
            },
          });
        }
      });
      throw new ApiError(
        decision === "prompt" ? 409 : 403,
        decision === "prompt" ? "plugin_approval_required" : "plugin_tool_denied",
        decision === "prompt"
          ? "This plugin tool is waiting for one-time approval."
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
        arguments: toJson(request.arguments),
      },
    });
    return this.executeInvocation(request.callId);
  };

  resolveInvocation = async (
    callId: string,
    decision: "accept" | "decline" | "cancel"
  ): Promise<unknown> => {
    const invocation = await this.prisma.pluginInvocation.findUnique({ where: { callId } });
    if (!invocation)
      throw new ApiError(404, "plugin_invocation_not_found", "Plugin call not found");
    if (invocation.status !== "running") {
      return { status: invocation.status, result: invocation.result };
    }
    if (decision !== "accept") {
      await this.prisma.pluginInvocation.update({
        where: { callId },
        data: {
          status: "denied",
          error: decision === "decline" ? "Declined by user" : "Cancelled",
          completedAt: new Date(),
        },
      });
      return { status: "denied" };
    }
    return this.executeInvocation(callId);
  };

  private async executeInvocation(callId: string): Promise<unknown> {
    const invocation = await this.prisma.pluginInvocation.findUnique({
      where: { callId },
      include: { connection: true },
    });
    if (!invocation)
      throw new ApiError(404, "plugin_invocation_not_found", "Plugin call not found");
    if (invocation.status === "completed") return invocation.result;
    try {
      const rawResult =
        invocation.connection.transport === "builtin"
          ? await this.invokeBuiltin(invocation.toolName, invocation.arguments, invocation)
          : invocation.connection.transport === "stdio"
            ? await this.callStdio(invocation.connection, invocation.toolName, invocation.arguments)
            : await this.http.call(
                invocation.connectionId,
                this.httpOptions(invocation.connection),
                invocation.toolName,
                invocation.arguments
              );
      const result = boundPluginResult(redact(rawResult));
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginInvocation.update({
          where: { callId },
          data: { status: "completed", result: toJson(result), completedAt: new Date() },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: invocation.connection.installationId,
            connectionId: invocation.connectionId,
            botId: invocation.botId,
            kind: "tool.completed",
            summary: `Called ${invocation.toolName}`,
          },
        });
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.pluginInvocation.update({
        where: { callId },
        data: { status: "failed", error: message.slice(0, 2_000), completedAt: new Date() },
      });
      throw error;
    }
  }

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
      const plugin = definitionFromManifest(installation.manifest);
      return (plugin?.skills ?? []).map(
        (skill) => `### ${plugin?.name}: ${skill.name}\n${skill.description}\n\n${skill.body}`
      );
    });
    return sections.length ? `\n\n## Installed plugin skills\n\n${sections.join("\n\n")}` : "";
  };

  close = async (): Promise<void> => {
    await this.http.closeAll();
  };

  private validAlias(value: string): string {
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

  private connectionOrThrow = async (connectionId: string) => {
    const connection = await this.prisma.pluginConnection.findUnique({
      where: { id: connectionId },
      include: { installation: true },
    });
    if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
    return connection;
  };

  private httpOptions(connection: {
    id: string;
    connectorKey: string;
    endpoint: string | null;
    authType: string;
    configuration: Prisma.JsonValue;
    credentials: Prisma.JsonValue;
  }) {
    if (!connection.endpoint)
      throw new ApiError(409, "plugin_endpoint_missing", "MCP URL is missing");
    const configuration = jsonObject(connection.configuration);
    const credentials = jsonObject(connection.credentials);
    const headers = stringRecord(configuration.headers);
    if (typeof credentials.bearerToken === "string") {
      headers.authorization = `Bearer ${credentials.bearerToken}`;
    }
    if (connection.authType !== "oauth") {
      return { endpoint: connection.endpoint, headers };
    }
    const oauth = jsonObject(credentials.oauth) as StoredOAuthState;
    const clientId =
      typeof configuration.clientId === "string"
        ? configuration.clientId
        : (process.env[
            `OPENBOT_${connection.connectorKey.toUpperCase().replaceAll("-", "_")}_OAUTH_CLIENT_ID`
          ] ?? process.env.OPENBOT_MCP_OAUTH_CLIENT_ID);
    const clientSecret =
      typeof configuration.clientSecret === "string"
        ? configuration.clientSecret
        : (process.env[
            `OPENBOT_${connection.connectorKey.toUpperCase().replaceAll("-", "_")}_OAUTH_CLIENT_SECRET`
          ] ?? process.env.OPENBOT_MCP_OAUTH_CLIENT_SECRET);
    const clientInformation: OAuthClientInformationMixed | undefined = clientId
      ? { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
      : undefined;
    const callbackUrl = this.oauthRedirectUrl(connection.id);
    const provider = new OpenBotOAuthProvider({
      redirectUrl: callbackUrl,
      scope: typeof configuration.scope === "string" ? configuration.scope : undefined,
      initial: oauth,
      clientInformation,
      save: async (state) => {
        const latest = await this.prisma.pluginConnection.findUnique({
          where: { id: connection.id },
          select: { credentials: true },
        });
        const latestCredentials = jsonObject(latest?.credentials);
        await this.prisma.pluginConnection.update({
          where: { id: connection.id },
          data: { credentials: toJson({ ...latestCredentials, oauth: state }) },
        });
      },
    });
    return { endpoint: connection.endpoint, headers, authProvider: provider };
  }

  private async markReady(
    connection: {
      id: string;
      installationId: string;
      name: string;
      installation: { pluginKey: string };
    },
    tools: PluginToolDefinition[],
    activityKind = "connection.ready"
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.pluginToolPolicy.deleteMany({ where: { connectionId: connection.id, botId: null } });
      if (tools.length) {
        await tx.pluginToolPolicy.createMany({
          data: tools.map((candidate) => ({
            connectionId: connection.id,
            toolName: candidate.name,
            decision: candidate.defaultDecision,
          })),
        });
      }
      const value = await tx.pluginConnection.update({
        where: { id: connection.id },
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
          connectionId: connection.id,
          kind: activityKind,
          summary: `Connected ${connection.name}`,
          metadata: { toolCount: tools.length },
        },
      });
      await appendEvent(tx, "plugin.connection.ready", connection.id, {
        pluginKey: connection.installation.pluginKey,
        toolCount: tools.length,
      });
      return value;
    });
  }

  private oauthRedirectUrl(connectionId: string): string {
    return `${this.publicUrl}/api/v0/plugin-oauth/callback?connectionId=${encodeURIComponent(connectionId)}`;
  }

  private async discoverStdio(connection: {
    id: string;
    configuration: Prisma.JsonValue;
  }): Promise<PluginToolDefinition[]> {
    const response = await this.callComputer(`/v1/mcp/connections/${connection.id}/discover`, {
      configuration: jsonObject(connection.configuration),
    });
    const tools = Array.isArray(response.tools) ? response.tools : [];
    return tools.map((candidate) => {
      const tool = jsonObject(candidate);
      if (typeof tool.name !== "string") throw new Error("MCP tool is missing a name");
      const annotations = jsonObject(tool.annotations);
      const readOnly = annotations.readOnlyHint === true;
      const destructive = annotations.destructiveHint === true;
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: jsonObject(tool.inputSchema),
        risk: destructive ? "destructive" : readOnly ? "read" : "write",
        defaultDecision: readOnly ? "allow" : "prompt",
      };
    });
  }

  private async callStdio(
    connection: { id: string; configuration: Prisma.JsonValue },
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const response = await this.callComputer(`/v1/mcp/connections/${connection.id}/call`, {
      configuration: jsonObject(connection.configuration),
      toolName,
      arguments: args,
    });
    return response.result;
  }

  private async stopRuntime(connectionId: string, transport: string): Promise<void> {
    if (transport === "http") {
      await this.http.close(connectionId);
      return;
    }
    if (transport === "stdio" && this.computerFetch) {
      await this.computerFetch(`/v1/mcp/connections/${connectionId}`, { method: "DELETE" }).catch(
        () => undefined
      );
    }
  }

  private async callComputer(path: string, body: unknown): Promise<JsonObject> {
    if (!this.computerFetch) {
      throw new ApiError(503, "computer_unavailable", "The computer runtime is unavailable");
    }
    const response = await this.computerFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(
        503,
        "stdio_mcp_failed",
        typeof jsonObject(value).error === "string"
          ? String(jsonObject(value).error)
          : `Computer MCP request failed (${response.status})`
      );
    }
    return jsonObject(value);
  }

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
      configuration: Prisma.JsonValue;
      credentials: Prisma.JsonValue;
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
      authorizationUrl:
        typeof jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl === "string"
          ? String(jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl)
          : null,
      oauthRedirectUrl:
        connection.authType === "oauth" ? this.oauthRedirectUrl(connection.id) : null,
      canAuthenticate: connection.authType === "oauth" || connection.authType === "token",
      configured: this.connectionConfigured(connection),
      command:
        typeof jsonObject(connection.configuration).command === "string"
          ? String(jsonObject(connection.configuration).command)
          : null,
      tools: publicTools(connection.toolSnapshot),
      grantedBotIds: connection.grants.filter((grant) => grant.enabled).map((grant) => grant.botId),
    };
  }

  private connectionConfigured(connection: {
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
