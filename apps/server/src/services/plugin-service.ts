import type { ConfigurePluginConnectionInput } from "@openteam/contracts";
import { ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import type { AgentDataStore } from "@openteam/messaging";
import { Effect } from "effect";
import type { PluginDefinition, PluginToolDefinition } from "../plugins/catalog";
import { McpHttpClientManager } from "../plugins/mcp-client-manager";
import { OpenTeamMarketplaceSource } from "../plugins/openteam-marketplace";
import { PluginAccess } from "./plugin/access";
import { PluginConnectors } from "./plugin/connectors";
import { PluginInstallations } from "./plugin/installations";
import { PluginInvocations } from "./plugin/invocations";
import { PluginQueries } from "./plugin/queries";
import { PluginTransport } from "./plugin/transport";
import {
  definitionFromManifest,
  jsonObject,
  redact,
  stringArray,
  stringRecord,
  toolSnapshot,
  validAlias,
} from "./plugin/values";
import { appendEvent, forwardServiceMethod, serviceEffect, toJson } from "./service-utils";

export class PluginService {
  private readonly invocations: PluginInvocations;

  private readonly connectors: PluginConnectors;

  private readonly access: PluginAccess;

  private readonly installations: PluginInstallations;

  private readonly transport: PluginTransport;

  private readonly queries: PluginQueries;

  private readonly http = new McpHttpClientManager();
  private readonly marketplace = new OpenTeamMarketplaceSource();
  private readonly publicUrl =
    process.env.OPENTEAM_PUBLIC_URL ?? `http://127.0.0.1:${process.env.OPENTEAM_PORT ?? "8787"}`;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly computerFetch?: (path: string, init?: RequestInit) => Promise<Response>,
    private readonly agentData?: Pick<
      AgentDataStore,
      "syncPluginSkillCache" | "writeConnectorSecret"
    >
  ) {
    this.queries = new PluginQueries(
      prisma,
      () => this.catalog(),
      (key) => this.definition(key),
      this.publicUrl
    );

    this.transport = new PluginTransport(prisma, this.http, this.publicUrl, computerFetch);

    this.installations = new PluginInstallations(
      prisma,
      (key) => this.definition(key),
      () => this.syncFileCaches(),
      (id, transport) => this.stopRuntime(id, transport)
    );

    this.access = new PluginAccess(prisma);

    this.connectors = new PluginConnectors(
      prisma,
      this.http,
      (id) => this.connect(id),
      (...args) => this.executeInvocation(...args),
      agentData
    );

    this.invocations = new PluginInvocations(prisma, (...args) => this.executeInvocation(...args));
  }

  storeConnectorSecret = forwardServiceMethod(() => this.connectors.storeConnectorSecret);

  deliverConnectedChannel = forwardServiceMethod(() => this.connectors.deliverConnectedChannel);

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

  settings = forwardServiceMethod(() => this.queries.settings);

  pollConnectionStatuses = forwardServiceMethod(() => this.queries.pollConnectionStatuses);

  botAccess = forwardServiceMethod(() => this.queries.botAccess);

  searchCatalog = forwardServiceMethod(() => this.queries.searchCatalog);

  catalogDetail = forwardServiceMethod(() => this.queries.catalogDetail);

  connectionStatuses = forwardServiceMethod(() => this.queries.connectionStatuses);

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
            effect: `Confirm ${request.action} in OpenTeam. Changes are available on the next bot turn.`,
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
    this.installations.install(pluginKey, values);

  addCustomMcp = forwardServiceMethod(() => this.installations.addCustomMcp);

  uninstall = forwardServiceMethod(() => this.installations.uninstall);

  configure = (connectionId: string, input: ConfigurePluginConnectionInput) =>
    serviceEffect(async () => {
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
    });

  authenticate = (connectionId: string, force = false) =>
    serviceEffect(async () => {
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
    });

  finishAuthentication = (connectionId: string, code: string, state: string) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      if (!oauth.state || oauth.state !== state) {
        throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
      }
      const tools = await this.http.finishOAuth(connectionId, this.httpOptions(connection), code);
      await this.markReady(connection, tools, "connection.oauth_completed");
      return { connectionId, status: "ready", toolCount: tools.length };
    });

  connect = (connectionId: string) =>
    serviceEffect(async () => {
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
        throw new ApiError(409, "plugin_token_required", "This connector needs a token or headers");
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
    });

  disconnect = (connectionId: string) =>
    serviceEffect(async () => {
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
    });

  addAccount = (connectionId: string, aliasValue: string) =>
    serviceEffect(async () => {
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
    });

  renameAccount = (connectionId: string, aliasValue: string) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const alias = validAlias(aliasValue);
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
    });

  removeAccount = (connectionId: string) =>
    serviceEffect(async () => {
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
    });

  setInstructions = (connectionId: string, instructionsValue: string) =>
    serviceEffect(async () => {
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
    });

  restart = (connectionId: string) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      await this.stopRuntime(connectionId, connection.transport);
      return Effect.runPromise(this.connect(connectionId));
    });

  setGrant = forwardServiceMethod(() => this.access.setGrant);

  setEnablement = (pluginKey: string, botId: string, enabled: boolean, skillsEnabled = enabled) =>
    this.access.setEnablement(pluginKey, botId, enabled, skillsEnabled);

  setPolicy = forwardServiceMethod(() => this.access.setPolicy);

  dynamicNamespaces = forwardServiceMethod(() => this.queries.dynamicNamespaces);

  invoke = forwardServiceMethod(() => this.invocations.invoke);

  resolveInvocation = forwardServiceMethod(() => this.invocations.resolveInvocation);

  private async executeInvocation(callId: string): Promise<unknown> {
    return this.transport.executeInvocation(callId);
  }

  skillInstructions = forwardServiceMethod(() => this.queries.skillInstructions);

  close = async (): Promise<void> => {
    await this.http.closeAll();
  };

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
    return this.transport.httpOptions(connection);
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

  private async discoverStdio(connection: {
    id: string;
    configuration: Prisma.JsonValue;
  }): Promise<PluginToolDefinition[]> {
    return this.transport.discoverStdio(connection);
  }

  private async stopRuntime(connectionId: string, transport: string): Promise<void> {
    return this.transport.stopRuntime(connectionId, transport);
  }
}

export { discoverRemoteTools, invokeRemoteTool } from "./plugin/transport";

export { boundPluginResult } from "./plugin/values";
