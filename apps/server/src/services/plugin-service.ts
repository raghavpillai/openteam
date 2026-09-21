import { setTimeout as delay } from "node:timers/promises";
import { equalOAuthState, validateDesktopCallback, parseManualCallback, oauthCallbackMode, MANUAL_OAUTH_REDIRECT, type PluginOAuthDesktopContext } from "../plugins/oauth-callback";
import type { PluginOAuthCallbackInput } from "@openteam/contracts/plugin-management";
import { cancelPendingPluginWork } from "./plugin/pending-work";
import { pluginToolArguments } from "./plugin/tool-arguments";
import { connectionNamespace } from "@openteam/plugin-sdk";
import type { ConfigurePluginConnectionInput, PluginTestInput } from "@openteam/contracts";
import { ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import type { AgentDataStore } from "@openteam/messaging";
import { Effect, Either } from "effect";
import type { PluginDefinition, PluginToolDefinition } from "../plugins/catalog";
import { McpHttpClientManager } from "../plugins/mcp-client-manager";
import { OpenTeamMarketplaceSource } from "../plugins/openteam-marketplace";
import { PluginManagement } from "./plugin/management";
import { PluginConfiguration } from "./plugin/configuration";
import {
  desktopMcpProvider,
  fieldsForConnector,
  validateValues,
  type ConfigValue,
} from "@openteam/plugin-sdk";
import { PluginAccess } from "./plugin/access";
import { PluginConnectors } from "./plugin/connectors";
import { PluginInstallations } from "./plugin/installations";
import { PluginInvocations } from "./plugin/invocations";
import { PluginQueries } from "./plugin/queries";
import { PluginTransport } from "./plugin/transport";
import {
  connectionConfigured,
  runtimeConfiguration,
  runtimeEndpoint,
  redactConnectionSecrets,
  canonicalJson,
  hasPlaceholder,
  definitionFromManifest,
  jsonObject,
  oauthRedirectUrl,
  redact,
  stringArray,
  stringRecord,
  toolSnapshot,
  validAlias,
  validateJsonSchema,
} from "./plugin/values";
import { appendEvent, forwardServiceMethod, serviceEffect, toJson } from "./service-utils";
import { ConnectorFileTransfers } from "./plugin/file-transfers";

const runAuthentication = async <A>(effect: Effect.Effect<A, Error>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

export class PluginService {
  readonly fileTransfers: ConnectorFileTransfers;
  private readonly invocations: PluginInvocations;

  private readonly connectors: PluginConnectors;

  private readonly access: PluginAccess;
  readonly configuration: PluginConfiguration;
  readonly management: PluginManagement;

  private readonly installations: PluginInstallations;

  private readonly transport: PluginTransport;

  private readonly queries: PluginQueries;

  private readonly http = new McpHttpClientManager();
  private healthTimer?: ReturnType<typeof setInterval>;
  private healthCheckRunning = false;

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
    this.management = new PluginManagement(
      prisma,
      () => this.marketplace.plugins(),
      (key) => Effect.runPromise(this.install(key)),
      () => this.syncFileCaches(),
      (id, transport) => this.stopRuntime(id, transport)
    );
    this.queries = new PluginQueries(
      prisma,
      () => this.catalog(),
      (key) => this.definition(key),
      this.publicUrl
    );

    this.transport = new PluginTransport(prisma, this.http, this.publicUrl, computerFetch);
    this.fileTransfers = new ConnectorFileTransfers(prisma, connection => this.transport.fileAccessToken(connection));

    this.installations = new PluginInstallations(
      prisma,
      (key) => this.definition(key),
      () => this.syncFileCaches(),
      (id, transport) => this.stopRuntime(id, transport)
    );

    this.access = new PluginAccess(prisma);
    this.configuration = new PluginConfiguration(prisma, this.publicUrl, (id, transport) =>
      this.stopRuntime(id, transport)
    );
    this.http.onToolsChanged = async (id, tools) => {
      const connection = await this.connectionOrThrow(id);
      if (connection.status === "ready")
        await this.markReady(connection, tools, "connection.tools_changed");
    };

    this.connectors = new PluginConnectors(
      prisma,
      this.http,
      (id) => this.connect(id),
      (...args) => this.executeInvocation(...args),
      agentData,
      id => this.transport.providerAccessToken(id)
    );

    this.invocations = new PluginInvocations(prisma, (...args) => this.executeInvocation(...args));
    if (computerFetch) {
      this.healthTimer = setInterval(() => {
        void this.refreshLocalConnections();
      }, 15_000);
      this.healthTimer.unref();
    }
  }

  storeConnectorSecret = forwardServiceMethod(() => this.connectors.storeConnectorSecret);

  deliverConnectedChannel = forwardServiceMethod(() => this.connectors.deliverConnectedChannel);

  syncFileCaches = async (): Promise<void> => {
    if (!this.agentData) return;
    const installations = await this.prisma.pluginInstallation.findMany({
      where: { status: "installed" },
      orderBy: { installedAt: "asc" },
    });
    try {
      const privateSkills = await this.prisma.pluginPrivateSkill.findMany();
      await this.agentData.syncPluginSkillCache([
        ...installations.flatMap((installation) => {
          const plugin = definitionFromManifest(installation.manifest);
          if (!plugin) return [];
          return [
            {
              id: plugin.key,
              name: plugin.name,
              version: plugin.version,
              publisher: plugin.publisher,
              skills: plugin.skills,
              files: plugin.files,
              binaryFiles: plugin.binaryFiles,
            },
          ];
        }),
        ...privateSkills.map((skill) => ({
          id: `private-${skill.id}`,
          name: skill.name,
          version: skill.updatedAt.toISOString(),
          publisher: "Private",
          skills: [
            {
              name: skill.name,
              description: skill.description,
              body: skill.body,
              path: "skills/private",
            },
          ],
          files: Object.fromEntries(
            Object.entries(stringRecord(skill.files)).map(([path, content]) => [
              `skills/private/${path}`,
              content,
            ])
          ),
        })),
      ]);
      await this.prisma.pluginInstallation.updateMany({
        where: { id: { in: installations.map((entry) => entry.id) } },
        data: { skillSyncStatus: "ready", skillSyncError: null },
      });
    } catch (error) {
      await this.prisma.pluginInstallation.updateMany({
        where: { id: { in: installations.map((entry) => entry.id) } },
        data: {
          skillSyncStatus: "error",
          skillSyncError:
            error instanceof Error ? error.message.slice(0, 2000) : "Skill sync failed",
        },
      });
    }
  };

  private catalog = async (): Promise<PluginDefinition[]> => {
    return this.management.catalog();
  };

  private definition = async (pluginKey: string): Promise<PluginDefinition | undefined> =>
    (await this.catalog()).find((plugin) => plugin.key === pluginKey);

  settings = forwardServiceMethod(() => this.queries.settings);
  composer = forwardServiceMethod(() => this.queries.composer);

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
  }): Promise<unknown> => {
    const existing = await this.prisma.approval.findUnique({
      where: { upstreamRequestId: `plugin-action:${request.callId}` },
    });
    if (existing && (existing.runId !== request.runId || jsonObject(existing.details).botId !== request.botId || jsonObject(existing.details).action !== request.action))
      throw new ApiError(409, "plugin_action_mismatch", "This tool call belongs to another action");
    if (existing && existing.status !== "pending") {
      const details = jsonObject(existing.details);
      const args = jsonObject(details.rawArguments);
      // Preserve the reviewed outcome. Acceptance by itself is not proof of a successful action.
      return {
        status: existing.status,
        completed: existing.status === "accepted" && details.actionResult != null && !details.actionError,
        ...(details.actionError ? {error:details.actionError} : {}),
        actionResult: details.actionResult,
        ...(existing.status === "accepted" ? await this.connectionStatuses() as object : {}),
        ...(existing.status === "accepted" && request.action === "InstallPlugin" && typeof args.pluginKey === "string" ? { detail: await this.catalogDetail(args.pluginKey) } : {}),
      };
    }
    if (!existing) {
      request = { ...request, arguments: await this.resolveToolArguments(request.action, request.arguments) };
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
            effect: `Confirm ${request.action} in OpenTeam. The tool continues with the result after review.`,
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

  async waitForAction(request:Parameters<PluginService["requestAction"]>[0],signal?:AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      try {return await this.requestAction(request);}
      catch(error){if(!(error instanceof ApiError)||error.code!=="plugin_action_required")throw error;}
      await delay(250,undefined,{signal});
    }
  }

  resolveAction = async (
    detailsValue: unknown,
    decision: "accept" | "decline" | "cancel"
  ): Promise<unknown> => {
    if (decision !== "accept") return { status: decision === "decline" ? "declined" : "cancelled" };
    const details = jsonObject(detailsValue);
    const action = details.action;
    const args = pluginToolArguments(String(action), details.rawArguments);
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
      const oauth = args.auth && typeof args.auth === "object" ? jsonObject(args.auth) : undefined;
      if (oauth && (!args.url || args.command || typeof oauth.CLIENT_ID !== "string" || !oauth.CLIENT_ID.trim()))
        throw new ApiError(400, "mcp_oauth_invalid", "OAuth client settings require a remote URL and CLIENT_ID");
      return Effect.runPromise(
        this.addCustomMcp({
          name: typeof args.name === "string" ? args.name : "Custom MCP",
          url: typeof args.url === "string" ? args.url : undefined,
          command: typeof args.command === "string" ? args.command : undefined,
          args: stringArray(args.args),
          env: stringRecord(args.env),
          headers: stringRecord(args.headers),
          auth: oauth ? "oauth" :
            args.auth === "oauth" || args.auth === "token" || args.auth === "none"
              ? args.auth
              : undefined,
          ...(oauth ? { oauth: { clientId: String(oauth.CLIENT_ID), clientSecret: typeof oauth.CLIENT_SECRET === "string" ? oauth.CLIENT_SECRET : undefined, scopes: stringArray(oauth.scopes) } } : {}),
          alias: typeof args.accountLabel === "string" ? args.accountLabel : undefined,
          reviewedRequestId: typeof args.createServerId === "string" ? args.createServerId : undefined,
        })
      );
    }
    if (action === "RestartMcpServers" && Array.isArray(args.connectionIds)) {
      const results = [];
      for (const id of args.connectionIds) {
        try { results.push({ connectionId: id, result: await Effect.runPromise(this.restart(String(id))) }); }
        catch (error) { results.push({ connectionId: id, error: error instanceof Error ? error.message : "Reconnect failed" }); }
      }
      return { servers: results };
    }
    let connectionId = typeof args.connectionId === "string" ? args.connectionId : undefined;
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
      if (typeof args.createAccountLabel === "string") {
        const created = await Effect.runPromise(this.addAccount(connectionId, args.createAccountLabel, typeof args.createAccountId === "string" ? args.createAccountId : undefined));
        connectionId = created.id;
      }
      const connection = await this.connectionOrThrow(connectionId);
      if (desktopMcpProvider(runtimeConfiguration(connection)))
        return Effect.runPromise(
          args.forceReauth === true ? this.restart(connectionId) : this.connect(connectionId)
        );
      return runAuthentication(this.authenticate(connectionId, args.forceReauth === true));
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

  resolveToolArguments = async (action: string, value: unknown) => {
    const args = pluginToolArguments(action, value);
    for (const key of ["connectionIds", "createAccountLabel", "createAccountId", "createServerId"]) if (key in args)
      throw new ApiError(400, "private_plugin_argument", `${key} is assigned by the approval service`);
    if (action === "AddMcpServer") args.createServerId = crypto.randomUUID();
    if (action === "RestartMcpServers" && !args.connectionId && !args.server_id) {
      args.connectionIds = (await this.prisma.pluginConnection.findMany({
        where: { installation: { status: "installed" } }, select: { id: true },
      })).map(connection => connection.id);
      return args;
    }
    if (!args.server_id) return args;
    if (typeof args.server_id !== "string") throw new ApiError(400, "server_id_invalid", "server_id must be a string");
    const connections = await this.prisma.pluginConnection.findMany({ include: { installation: true } });
    const matches = connections.filter(c => c.id === args.server_id || connectionNamespace(c.id,c.alias) === args.server_id || c.installation.pluginKey === args.server_id);
    if (!matches.length) throw new ApiError(404, "connection_not_found", "Server not found; use GetMcpServerStatus");
    const groups = new Set(matches.map(c => `${c.installationId}/${c.connectorKey}`));
    if (groups.size !== 1) throw new ApiError(409, "account_ambiguous", "Use a server identifier from GetMcpServerStatus");
    const source = matches[0]!;
    const accounts = connections.filter(c => c.installationId === source.installationId && c.connectorKey === source.connectorKey);
    const selected = typeof args.account_label === "string" ? accounts.filter(c => c.alias === args.account_label) : matches;
    if (!selected.length && action === "AuthenticateMcpServer" && typeof args.account_label === "string") {
      args.createAccountLabel = args.account_label;
      args.createAccountId = crypto.randomUUID();
    } else if (selected.length !== 1) throw new ApiError(409, "account_ambiguous", "Select one account_label from GetMcpServerStatus");
    const id = (selected[0] ?? source).id;
    if (args.connectionId && args.connectionId !== id) throw new ApiError(400, "account_ambiguous", "Conflicting connectionId and server_id");
    args.connectionId = id;
    return args;
  };

  install = (pluginKey: string, values: Record<string, ConfigValue> = {}) =>
    this.installations.install(pluginKey, values);

  addCustomMcp = forwardServiceMethod(() => this.installations.addCustomMcp);

  uninstall = forwardServiceMethod(() => this.installations.uninstall);

  testTool = (connectionId: string, input: PluginTestInput) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      if (connection.status !== "ready" || connection.installation.status !== "installed")
        throw new ApiError(
          409,
          "plugin_connection_not_ready",
          "Connect this account before testing tools"
        );
      const tool = toolSnapshot(connection.toolSnapshot).find(
        (entry) => entry.name === input.toolName
      );
      if (!tool) throw new ApiError(404, "plugin_tool_not_found", "Tool not found");
      const policy = await this.prisma.pluginToolPolicy.findFirst({
        where: { connectionId, botId: null, toolName: tool.name },
      });
      if (policy?.enabled === false || policy?.decision === "deny")
        throw new ApiError(
          403,
          "plugin_tool_denied",
          "Enable this tool and allow testing before running it"
        );
      if (tool.risk !== "read" && input.confirmSideEffect !== true)
        throw new ApiError(
          409,
          "plugin_test_confirmation_required",
          "Review and confirm this tool's possible side effects before testing"
        );
      validateJsonSchema(tool.inputSchema, input.arguments);
      const result = await this.transport.testConnection(connection, tool.name, input.arguments);
      await this.prisma.pluginActivity.create({
        data: {
          installationId: connection.installationId,
          connectionId,
          kind: "tool.tested",
          summary: `Tested ${tool.name} from plugin settings`,
        },
      });
      return { result };
    });

  configure = (connectionId: string, input: ConfigurePluginConnectionInput) =>
    this.configuration.save(connectionId, {
      values: {
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      },
      secrets: {
        ...(input.token ? { token: { action: "replace" as const, value: input.token } } : {}),
        ...(input.clientSecret !== undefined
          ? {
              clientSecret: input.clientSecret
                ? { action: "replace" as const, value: input.clientSecret }
                : { action: "clear" as const },
            }
          : {}),
      },
      ...(input.headers ? { headers: input.headers } : {}),
    });

  private authenticationStarts = new Map<string, Promise<{ connectionId: string; status: string; authorizationUrl: string }>>();

  authenticate = (connectionId: string, force = false, desktop?: PluginOAuthDesktopContext, sessionId: string | null = null) => serviceEffect(async () => {
    if (!desktop) {
      const connection = await this.connectionOrThrow(connectionId);
      const mode = oauthCallbackMode(this.publicUrl, jsonObject(connection.configuration));
      if (mode === "desktop") throw new ApiError(409, "plugin_oauth_desktop_required", "Open this connection in the desktop app, or select Automatic in account settings to sign in from this device.");
      if (mode === "manual")
        desktop = { redirectUrl: MANUAL_OAUTH_REDIRECT, sessionId, mode: "manual" };
    }
    if (desktop) validateDesktopCallback(desktop.redirectUrl);
    const existing = this.authenticationStarts.get(connectionId);
    if (existing) {
      await existing;
      return this.beginAuthentication(connectionId, force, desktop);
    }
    const pending = this.beginAuthentication(connectionId, force, desktop);
    this.authenticationStarts.set(connectionId, pending);
    try { return await pending; }
    finally { if (this.authenticationStarts.get(connectionId) === pending) this.authenticationStarts.delete(connectionId); }
  });

  private beginAuthentication = async (connectionId: string, force: boolean, desktop?: PluginOAuthDesktopContext) => {
      const connection = await this.connectionOrThrow(connectionId);
      this.assertAvailable(connection);
      this.validateConfiguration(connection);
      if (!["http", "stdio"].includes(connection.transport) || connection.authType !== "oauth") {
        throw new ApiError(409, "plugin_oauth_unsupported", "This connection does not use OAuth");
      }
      const connector = definitionFromManifest(connection.installation.manifest)?.connections.find(row => row.key === connection.connectorKey);
      if (connector?.oauth?.supportsLoopbackRedirect === false && (desktop || !this.publicUrl.startsWith("https://")))
        throw new ApiError(409, "plugin_oauth_https_required", "This provider requires an HTTPS server callback. Enable Tailscale Serve or your own HTTPS domain and select Automatic or Server callback.");
      const current = jsonObject(connection.credentials);
      const previousOAuth = jsonObject(current.oauth);
      const sameCallback = desktop
        ? previousOAuth.callbackMode === (desktop.mode ?? "desktop") && previousOAuth.redirectUrl === desktop.redirectUrl && previousOAuth.callbackSessionId === desktop.sessionId
        : !["desktop", "manual"].includes(String(previousOAuth.callbackMode)) &&
          (!previousOAuth.redirectUrl || previousOAuth.redirectUrl === oauthRedirectUrl(this.publicUrl, connectionId));
      if (!force && connection.status === "needs_auth" &&
          sameCallback && !previousOAuth.exchangeStarted &&
          previousOAuth.stateGeneration === connection.runtimeGeneration &&
          typeof previousOAuth.stateCreatedAt === "number" &&
          Date.now() - previousOAuth.stateCreatedAt < 15 * 60_000 &&
          typeof previousOAuth.authorizationUrl === "string" && previousOAuth.state) {
        return { connectionId, status: "needs_auth", authorizationUrl: previousOAuth.authorizationUrl };
      }
      const oauth =
        !force && sameCallback && previousOAuth.clientInformation
          ? { clientInformation: previousOAuth.clientInformation }
          : {};
      const state = crypto.randomUUID();
      const next = {
        ...current,
        oauth: {
          ...oauth,
          state,
          stateCreatedAt: Date.now(),
          stateGeneration: connection.runtimeGeneration + 1,
          redirectUrl: oauthRedirectUrl(this.publicUrl, connectionId),
          ...(desktop ? { redirectUrl: desktop.redirectUrl, callbackMode: desktop.mode ?? "desktop", callbackSessionId: desktop.sessionId } : {}),
        },
      };
      const started = await this.prisma.pluginConnection.updateMany({
        where: { id: connectionId, runtimeGeneration: connection.runtimeGeneration },
        data: {
          credentials: toJson(next),
          runtimeGeneration: { increment: 1 },
          status: "needs_auth",
          statusMessage: desktop?.mode === "manual" ? "Approve access in your browser, then paste the complete callback URL into OpenTeam." : "Waiting for authorization in your browser.",
          lastCheckedAt: new Date(),
        },
      });
      if (!started.count)
        throw new ApiError(
          409,
          "plugin_oauth_session_changed",
          "Connection changed; try authorization again"
        );
      const refreshed = await this.connectionOrThrow(connectionId);
      if (refreshed.runtimeGeneration !== connection.runtimeGeneration + 1 ||
          jsonObject(jsonObject(refreshed.credentials).oauth).state !== state)
        throw new ApiError(409, "plugin_oauth_session_changed", "A newer authorization attempt replaced this session.");
      let result: { authorizationUrl: string };
      try {
        result =
          refreshed.transport === "stdio"
            ? await this.transport.beginStdioOAuth(refreshed)
            : await this.http.beginOAuth(connectionId, this.httpOptions(refreshed));
      } catch (error) {
        const message = String(
          redactConnectionSecrets(
            error instanceof Error ? error.message : String(error),
            connection
          )
        );
        await this.prisma.pluginConnection.updateMany({
          where: { id: connectionId, runtimeGeneration: refreshed.runtimeGeneration },
          data: {
            credentials: toJson({ ...current, oauth }),
            status: "error",
            statusMessage: message.includes("dynamic client registration")
              ? "Configure an OAuth client ID for this self-hosted connector."
              : message,
          },
        });
        throw new ApiError(409, "plugin_oauth_failed", message);
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
    };

  connectionForOAuthState = (state: string) => serviceEffect(async () => {
    if (!state || state.length > 4096) throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
    const matches = await this.prisma.pluginConnection.findMany({
      where: { credentials: { path: ["oauth", "state"], equals: state } }, select: { id: true }, take: 2,
    });
    if (matches.length !== 1) throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
    return matches[0]!.id;
  });

  finishServerAuthentication = (connectionId: string, input: { state: string; code?: string; error?: string; iss?: string }) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      if (input.iss && input.iss !== oauth.issuer)
        throw new ApiError(400, "plugin_oauth_issuer_invalid", "OAuth issuer did not match.");
      return input.error
        ? runAuthentication(this.cancelAuthentication(connectionId, input.state))
        : runAuthentication(this.finishAuthentication(connectionId, input.code!, input.state));
    });

  finishManualAuthentication = (connectionId: string, callbackUrl: string, sessionId: string | null) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      if (oauth.callbackMode !== "manual" || oauth.callbackSessionId !== sessionId || typeof oauth.redirectUrl !== "string")
        throw new ApiError(400, "plugin_oauth_session_changed", "Start sign-in from this session before pasting its callback.");
      const input = parseManualCallback(callbackUrl, oauth.redirectUrl);
      const context: PluginOAuthDesktopContext = { redirectUrl: oauth.redirectUrl, sessionId, mode: "manual" };
      if (input.iss && input.iss !== oauth.issuer)
        throw new ApiError(400, "plugin_oauth_issuer_invalid", "OAuth issuer did not match.");
      if (input.error) return runAuthentication(this.cancelAuthentication(connectionId, input.state, context));
      return runAuthentication(this.finishAuthentication(connectionId, input.code!, input.state, context));
    });

  cancelClientAuthentication = (connectionId: string, state: string, sessionId: string | null, redirectUrl?: string) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      const context: PluginOAuthDesktopContext | undefined = oauth.callbackMode === "manual"
        ? { redirectUrl: String(oauth.redirectUrl), sessionId, mode: "manual" }
        : redirectUrl ? { redirectUrl: validateDesktopCallback(redirectUrl), sessionId } : undefined;
      return runAuthentication(this.cancelAuthentication(connectionId, state, context));
    });

  finishDesktopAuthentication = (connectionId: string, input: PluginOAuthCallbackInput, sessionId: string | null) =>
    serviceEffect(async () => {
      const desktop = { redirectUrl: validateDesktopCallback(input.redirectUrl), sessionId };
      const connection = await this.connectionOrThrow(connectionId);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      this.assertDesktopCallback(oauth, desktop);
      if (Boolean(input.code) === Boolean(input.error))
        throw new ApiError(400, "plugin_oauth_callback_invalid", "Expected an authorization code or provider error.");
      if (input.iss && input.iss !== oauth.issuer)
        throw new ApiError(400, "plugin_oauth_issuer_invalid", "OAuth issuer did not match.");
      if (input.error) return runAuthentication(this.cancelAuthentication(connectionId, input.state, desktop));
      return runAuthentication(this.finishAuthentication(connectionId, input.code!, input.state, desktop));
    });

  private assertDesktopCallback(oauth: Record<string, unknown>, desktop?: PluginOAuthDesktopContext) {
    if (["desktop", "manual"].includes(String(oauth.callbackMode))
      ? !desktop || oauth.callbackMode !== (desktop.mode ?? "desktop") || oauth.redirectUrl !== desktop.redirectUrl || oauth.callbackSessionId !== desktop.sessionId
      : Boolean(desktop))
      throw new ApiError(400, "plugin_oauth_session_changed", "Authorization belongs to a different session. Start sign-in again.");
  }

  finishAuthentication = (connectionId: string, code: string, state: string, desktop?: PluginOAuthDesktopContext) =>
    serviceEffect(async () => {
      let connection = await this.connectionOrThrow(connectionId);
      this.assertAvailable(connection);
      const oauth = jsonObject(jsonObject(connection.credentials).oauth);
      this.assertDesktopCallback(oauth, desktop);
      if (
        !equalOAuthState(oauth.state, state) || oauth.exchangeStarted ||
        oauth.stateGeneration !== connection.runtimeGeneration ||
        typeof oauth.stateCreatedAt !== "number" || Date.now() - oauth.stateCreatedAt > 15 * 60_000
      ) {
        throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
      }
      // Claim in the database before redeeming the one-time code, including across server replicas.
      const claimed = await this.prisma.pluginConnection.updateMany({
        where: { id: connectionId, runtimeGeneration: connection.runtimeGeneration },
        data: {
          runtimeGeneration: { increment: 1 },
          credentials: toJson({ ...jsonObject(connection.credentials), oauth: {
            ...oauth, exchangeStarted: true, stateGeneration: connection.runtimeGeneration + 1,
          } }),
        },
      });
      if (!claimed.count) throw new ApiError(409, "plugin_oauth_session_changed", "This authorization is already completing or has been replaced.");
      connection = { ...connection, runtimeGeneration: connection.runtimeGeneration + 1,
        credentials: toJson({ ...jsonObject(connection.credentials), oauth: {
          ...oauth, exchangeStarted: true, stateGeneration: connection.runtimeGeneration + 1,
        } }) as Prisma.JsonValue };
      let tools: PluginToolDefinition[];
      try {
        tools =
          connection.transport === "stdio"
            ? await this.transport.finishStdioOAuth(connection, code)
            : await this.http.finishOAuth(connectionId, this.httpOptions(connection), code);
      } catch (error) {
        const latest = await this.connectionOrThrow(connectionId);
        const authorized = Boolean(jsonObject(jsonObject(latest.credentials).oauth).tokens);
        const detail = String(
          redactConnectionSecrets(error instanceof Error ? error.message : String(error), latest)
        ).replaceAll(code, "[redacted]").slice(0, 1500);
        const credentials = jsonObject(latest.credentials);
        const failedOAuth = { ...jsonObject(credentials.oauth) };
        for (const key of ["state", "stateCreatedAt", "stateGeneration", "authorizationUrl", "codeVerifier", "callbackSessionId", "callbackMode", "exchangeStarted"]) delete failedOAuth[key];
        await this.prisma.pluginConnection.updateMany({
          where: { id: connectionId, runtimeGeneration: connection.runtimeGeneration },
          data: {
            runtimeGeneration: { increment: 1 },
            credentials: toJson({ ...credentials, oauth: failedOAuth }),
            status: "error",
            statusMessage: authorized
              ? `Authorization succeeded, but tool discovery failed: ${detail}`
              : `Authorization failed: ${detail}`,
          },
        });
        throw new ApiError(409, "plugin_oauth_failed", authorized ? `Authorization succeeded, but tool discovery failed: ${detail}` : `Authorization failed: ${detail}`);
      }
      await this.markReady(connection, tools, "connection.oauth_completed");
      return { connectionId, status: "ready", toolCount: tools.length };
    });

  cancelAuthentication = (connectionId: string, state: string, desktop?: PluginOAuthDesktopContext) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      const credentials = jsonObject(connection.credentials);
      const oauth = jsonObject(credentials.oauth);
      this.assertDesktopCallback(oauth, desktop);
      if (!equalOAuthState(oauth.state, state) || oauth.exchangeStarted || oauth.stateGeneration !== connection.runtimeGeneration)
        throw new ApiError(400, "plugin_oauth_state_invalid", "OAuth state did not match");
      delete oauth.state;
      delete oauth.stateCreatedAt;
      delete oauth.stateGeneration;
      delete oauth.authorizationUrl;
      delete oauth.codeVerifier;
      delete oauth.callbackMode;
      delete oauth.callbackSessionId;
      delete oauth.exchangeStarted;
      const cancelled = await this.prisma.pluginConnection.updateMany({
        where: { id: connectionId, runtimeGeneration: connection.runtimeGeneration },
        data: {
          runtimeGeneration: { increment: 1 },
          credentials: toJson({ ...credentials, oauth }),
          status: "needs_auth",
          statusMessage: "Authorization was cancelled. You can try again when ready.",
        },
      });
      if (!cancelled.count)
        throw new ApiError(
          409,
          "plugin_oauth_session_changed",
          "A newer authorization attempt replaced this session"
        );
      return { cancelled: true };
    });

  connect = (connectionId: string, sessionId: string | null = null) =>
    serviceEffect(async () => {
      const connection = await this.connectionOrThrow(connectionId);
      this.assertAvailable(connection);
      this.validateConfiguration(connection);
      if (connection.authType === "oauth") {
        const oauth = jsonObject(jsonObject(connection.credentials).oauth);
        if (!oauth.tokens) return runAuthentication(this.authenticate(connectionId, false, undefined, sessionId));
      }
      if (connection.authType === "token" && !connectionConfigured(connection)) {
        await this.prisma.pluginConnection.update({
          where: { id: connectionId },
          data: { status: "needs_auth", statusMessage: "Add a token or request headers first." },
        });
        throw new ApiError(409, "plugin_token_required", "This connector needs a token or headers");
      }

      let tools = toolSnapshot(connection.toolSnapshot);
      try {
        if (connection.transport === "http") {
          if (!connection.endpoint) throw new Error("Connection endpoint is missing");
          tools = await this.http.discover(connectionId, this.httpOptions(connection));
        } else if (connection.transport === "stdio") {
          tools = await this.discoverStdio(connection);
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const message = String(redactConnectionSecrets(raw, connection)).slice(0, 1500);
        const authFailure =
          connection.authType !== "none" &&
          /401|403|unauthoriz|invalid.token|invalid.grant/i.test(message);
        await this.prisma.pluginConnection.updateMany({
          where: { id: connectionId, runtimeGeneration: connection.runtimeGeneration },
          data: {
            status: authFailure ? "needs_auth" : "error",
            statusMessage: `${authFailure ? "Authentication failed" : connection.transport === "stdio" ? "Local runtime unavailable" : "Tool discovery failed"}: ${message}`,
            lastCheckedAt: new Date(),
          },
        });
        throw new ApiError(
          authFailure ? 401 : 503,
          authFailure ? "plugin_auth_failed" : "plugin_runtime_failed",
          message
        );
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
      await this.stopRuntime(connectionId, connection.transport);
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginConnection.update({
          where: { id: connectionId },
          data: {
            status: "disconnected",
            statusMessage: null,
            connectedAt: null,
            runtimeGeneration: { increment: 1 },
          },
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

  addAccount = (connectionId: string, aliasValue: string, reviewedAccountId?: string) =>
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
        include: { installation: true },
      });
      if (!source) throw new ApiError(404, "connection_not_found", "Connection not found");
      if (reviewedAccountId) {
        const prior = await this.prisma.pluginConnection.findUnique({ where: { id: reviewedAccountId } });
        if (prior) {
          if (prior.installationId !== source.installationId || prior.connectorKey !== source.connectorKey || prior.alias !== alias)
            throw new ApiError(409, "connection_review_changed", "The reviewed account changed; request a new approval");
          return { id: prior.id, alias: prior.alias, status: prior.status };
        }
      }
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
      const connectorDefinition = definitionFromManifest(
        source.installation.manifest
      )?.connections.find((entry) => entry.key === source.connectorKey);
      const sharedClient =
        connectorDefinition?.oauth?.shareClientCredentials === true
          ? (jsonObject(source.credentials).clientSecret ??
            jsonObject(source.configuration).clientSecret)
          : undefined;
      const account = await this.prisma.$transaction(async (tx) => {
        const created = await tx.pluginConnection.create({
          data: {
            ...(reviewedAccountId ? { id: reviewedAccountId } : {}),
            installationId: source.installationId,
            connectorKey: source.connectorKey,
            name: source.name,
            alias,
            transport: source.transport,
            authType: source.authType,
            endpoint: source.endpoint,
            configuration: toJson({
              ...connectorDefinition?.configuration,
              ...Object.fromEntries(
                Object.entries(jsonObject(source.configuration)).filter(
                  ([key]) => !["headers", "env", "clientSecret", "values"].includes(key)
                )
              ),
            }),
            credentials: toJson(sharedClient ? { clientSecret: sharedClient } : {}),
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
      }).catch((cause: unknown) => {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "P2002")
          throw new ApiError(409, "connection_alias_exists", "That account alias already exists");
        throw cause;
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
      await this.prisma.$transaction((tx) => cancelPendingPluginWork(tx, [connectionId]));
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
            configuration: toJson(
              Object.fromEntries(
                Object.entries(jsonObject(connection.configuration)).filter(
                  ([key]) => !["env", "headers", "clientSecret", "values"].includes(key)
                )
              )
            ),
            status: connection.authType === "none" ? "disconnected" : "needs_auth",
            runtimeGeneration: { increment: 1 },
            statusMessage:
              connection.authType === "none" ? null : "Authentication has not been configured.",
            connectedAt: null,
          },
        });
        await this.prisma.botPluginConnectionGrant.deleteMany({ where: { connectionId } });
        return { removed: true, reset: true };
      }
      await this.stopRuntime(connectionId, connection.transport);
      await this.prisma.pluginConnection.delete({ where: { id: connectionId } });
      return { removed: true };
    });

  setInstructions = (connectionId: string, instructionsValue: string) =>
    serviceEffect(async () => {
      const instructions = instructionsValue.trim();
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

  invoke = (request: Parameters<PluginInvocations["invoke"]>[0]) => this.invocations.invoke(request);

  /** Only human review-card endpoints call this; never exposed through PluginCall. */
  invokeReviewed = (request: Parameters<PluginInvocations["invoke"]>[0]) => this.invocations.invoke(request, true);

  resolveInvocation = forwardServiceMethod(() => this.invocations.resolveInvocation);

  private async executeInvocation(callId: string): Promise<unknown> {
    return this.transport.executeInvocation(callId);
  }

  skillInstructions = forwardServiceMethod(() => this.queries.skillInstructions);

  close = async (): Promise<void> => {
    clearInterval(this.healthTimer);
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
      runtimeGeneration: number;
      installation: { pluginKey: string };
    },
    tools: PluginToolDefinition[],
    activityKind = "connection.ready"
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PluginConnection" WHERE id = ${connection.id}::uuid FOR UPDATE`;
      const current = await tx.pluginConnection.findUnique({
        where: { id: connection.id },
        include: { installation: true },
      });
      if (!current || current.runtimeGeneration !== connection.runtimeGeneration)
        throw new ApiError(
          409,
          "plugin_connection_changed",
          "Connection setup changed while connecting. Try again with the current settings."
        );
      this.assertAvailable(current);
      const saved = await tx.pluginToolPolicy.findMany({
        where: { connectionId: connection.id, botId: null },
        select: { toolName: true },
      });
      const newTools = tools.filter(
        (tool) => !saved.some((policy) => policy.toolName === tool.name)
      );
      if (newTools.length) {
        await tx.pluginToolPolicy.createMany({
          data: newTools.map((candidate) => ({
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

  private assertAvailable(connection: { installation: { mode: string; status: string } }) {
    if (
      connection.installation.mode === "disabled" ||
      connection.installation.status !== "installed"
    )
      throw new ApiError(403, "plugin_disabled", "This plugin is disabled by workspace policy");
  }

  private validateConfiguration(connection: {
    connectorKey: string;
    endpoint: string | null;
    configuration: Prisma.JsonValue;
    credentials: Prisma.JsonValue;
    installation: { manifest: Prisma.JsonValue };
  }) {
    const plugin = definitionFromManifest(connection.installation.manifest);
    const config = runtimeConfiguration(connection);
    const credentials = jsonObject(connection.credentials);
    if (plugin) {
      const values = {
        ...jsonObject(config.values),
        ...jsonObject(credentials.values),
        ...(credentials.bearerToken ? { token: credentials.bearerToken } : {}),
        ...(config.clientId ? { clientId: config.clientId } : {}),
        ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
        ...(config.scope ? { scope: config.scope } : {}),
      };
      const fields = fieldsForConnector(plugin, connection.connectorKey);
      try {
        validateValues(
          fields,
          Object.fromEntries(
            Object.entries(values).filter(([key]) => fields.some((field) => field.key === key))
          )
        );
      } catch (error) {
        throw new ApiError(
          409,
          "plugin_configuration_required",
          error instanceof Error ? error.message : "Complete connection setup"
        );
      }
    }
    if (hasPlaceholder(config) || hasPlaceholder(runtimeEndpoint(connection)))
      throw new ApiError(
        409,
        "plugin_configuration_required",
        "Complete the connection setup fields first"
      );
  }

  private async refreshLocalConnections(): Promise<void> {
    if (this.healthCheckRunning) return;
    this.healthCheckRunning = true;
    try {
      const connections = await this.prisma.pluginConnection.findMany({
        where: {
          transport: "stdio",
          installation: { status: "installed", mode: { not: "disabled" } },
          OR: [
            { status: "ready" },
            { status: "error", statusMessage: { startsWith: "Local runtime unavailable:" } },
          ],
        },
        include: { installation: true },
      });
      for (const connection of connections) {
        // Native discovery authenticates and may open a consent prompt. A background
        // health check must not request access after the user locks the provider.
        if (jsonObject(connection.configuration).runtime === "desktop") continue;
        try {
          const tools = await this.discoverStdio(connection);
          const current = await this.connectionOrThrow(connection.id);
          if (current.updatedAt.getTime() !== connection.updatedAt.getTime()) continue;
          if (
            current.status !== "ready" ||
            canonicalJson(tools) !== canonicalJson(current.toolSnapshot)
          )
            await this.markReady(current, tools, "connection.tools_changed");
        } catch (error) {
          const message = String(
            redactConnectionSecrets(
              error instanceof Error ? error.message : String(error),
              connection
            )
          );
          await this.prisma.pluginConnection.updateMany({
            where: { id: connection.id, updatedAt: connection.updatedAt },
            data: {
              status: "error",
              statusMessage: `Local runtime unavailable: ${message.slice(0, 1500)}`,
              lastCheckedAt: new Date(),
            },
          });
        }
      }
    } catch {
      /* A transient database outage is retried on the next health check. */
    } finally {
      this.healthCheckRunning = false;
    }
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
