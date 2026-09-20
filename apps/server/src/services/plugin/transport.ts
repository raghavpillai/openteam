import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import type { PluginToolDefinition } from "../../plugins/catalog";
import { McpHttpClientManager } from "../../plugins/mcp-client-manager";
import { OpenTeamOAuthProvider, type StoredOAuthState } from "../../plugins/oauth-provider";
import {
  beginPackagedOAuth,
  finishPackagedOAuth,
  packagedAccessToken,
} from "../../plugins/packaged-oauth";
import { toJson } from "../service-utils";
import { effectiveToolPolicy } from "@openteam/plugin-sdk";
import {
  boundPluginResult,
  jsonObject,
  oauthRedirectUrl,
  redact,
  stringRecord,
  runtimeConfiguration,
  runtimeEndpoint,
  definitionFromManifest,
  redactConnectionSecrets,
  toolSnapshot,
  type JsonObject,
} from "./values";

export const compatibilityHttpManager = new McpHttpClientManager();

type OAuthConnection = {
  id: string;
  connectorKey: string;
  configuration: Prisma.JsonValue;
  credentials: Prisma.JsonValue;
  runtimeGeneration?: number;
};

export const discoverRemoteTools = (endpoint: string): Promise<PluginToolDefinition[]> =>
  compatibilityHttpManager.discover(`compat:${endpoint}`, { endpoint });

export const invokeRemoteTool = (
  endpoint: string,
  toolName: string,
  args: unknown
): Promise<unknown> =>
  compatibilityHttpManager.call(`compat:${endpoint}`, { endpoint }, toolName, args);

export class PluginTransport {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly http: McpHttpClientManager,
    private readonly publicUrl: string,
    private readonly computerFetch?: (path: string, init?: RequestInit) => Promise<Response>
  ) {}
  async executeInvocation(callId: string): Promise<unknown> {
    const invocation = await this.prisma.pluginInvocation.findUnique({
      where: { callId },
      include: { connection: true },
    });
    if (!invocation)
      throw new ApiError(404, "plugin_invocation_not_found", "Plugin call not found");
    if (invocation.status === "completed") return invocation.result;
    try {
      if (invocation.status !== "running")
        throw new ApiError(409, "plugin_call_replayed", "This call is no longer pending");
      const current = await this.prisma.pluginConnection.findUnique({
        where: { id: invocation.connectionId },
        include: {
          installation: { include: { enablements: { where: { botId: invocation.botId } } } },
          grants: { where: { botId: invocation.botId } },
          policies: { where: { OR: [{ botId: null }, { botId: invocation.botId }] } },
        },
      });
      if (
        !current ||
        current.status !== "ready" ||
        current.installation.status !== "installed" ||
        current.installation.mode === "disabled" ||
        !current.installation.enablements[0]?.enabled ||
        !current.grants[0]?.enabled
      )
        throw new ApiError(
          403,
          "plugin_access_revoked",
          "Connection access was revoked before this call could run"
        );
      const tool = toolSnapshot(current.toolSnapshot).find(
        (candidate) => candidate.name === invocation.toolName
      );
      if (!tool)
        throw new ApiError(404, "plugin_tool_not_found", "The tool is no longer available");
      const policy = effectiveToolPolicy(
        current.policies,
        tool.name,
        invocation.botId,
        tool.defaultDecision
      );
      if (!policy.enabled || policy.decision === "deny")
        throw new ApiError(
          403,
          "plugin_tool_denied",
          "The tool was disabled or denied before this call could run"
        );
      // Claim once, including approvals accepted concurrently in multiple clients.
      const claim = await this.prisma.pluginInvocation.updateMany({
        where: { callId, status: "running", error: { not: "Executing" } },
        data: { error: "Executing" },
      });
      // Nullable error requires a separate predicate in PostgreSQL.
      if (!claim.count) {
        const emptyClaim = await this.prisma.pluginInvocation.updateMany({
          where: { callId, status: "running", error: null },
          data: { error: "Executing" },
        });
        if (!emptyClaim.count)
          throw new ApiError(409, "plugin_call_replayed", "This call is already executing");
      }
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
      const result = boundPluginResult(redactConnectionSecrets(rawResult, invocation.connection));
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginInvocation.update({
          where: { callId },
          data: {
            status: "completed",
            error: null,
            result: toJson(result),
            completedAt: new Date(),
          },
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
      if (error instanceof ApiError && error.code === "plugin_call_replayed") throw error;
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.pluginInvocation.update({
        where: { callId },
        data: { status: "failed", error: message.slice(0, 2_000), completedAt: new Date() },
      });
      throw error;
    }
  }

  httpOptions(connection: {
    id: string;
    connectorKey: string;
    endpoint: string | null;
    authType: string;
    configuration: Prisma.JsonValue;
    credentials: Prisma.JsonValue;
    runtimeGeneration?: number;
  }) {
    const endpoint = runtimeEndpoint(connection);
    if (!endpoint) throw new ApiError(409, "plugin_endpoint_missing", "MCP URL is missing");
    const configuration = runtimeConfiguration(connection);
    const credentials = jsonObject(connection.credentials);
    const headers = stringRecord(configuration.headers);
    if (typeof credentials.bearerToken === "string") {
      headers.authorization = `Bearer ${credentials.bearerToken}`;
    }
    if (connection.authType !== "oauth") {
      return { endpoint, headers };
    }
    return { endpoint, headers, authProvider: this.oauthProvider(connection) };
  }

  private oauthProvider(
    connection: OAuthConnection,
    saveOverride?: (state: StoredOAuthState) => Promise<void>
  ) {
    const configuration = runtimeConfiguration(connection);
    const credentials = jsonObject(connection.credentials);
    const oauth = jsonObject(credentials.oauth) as StoredOAuthState;
    let expectedOAuthState = oauth.state;
    const clientId =
      typeof configuration.clientId === "string"
        ? configuration.clientId
        : (process.env[
            `OPENTEAM_${connection.connectorKey.toUpperCase().replaceAll("-", "_")}_OAUTH_CLIENT_ID`
          ] ?? process.env.OPENTEAM_MCP_OAUTH_CLIENT_ID);
    const clientSecret =
      typeof configuration.clientSecret === "string"
        ? configuration.clientSecret
        : (process.env[
            `OPENTEAM_${connection.connectorKey.toUpperCase().replaceAll("-", "_")}_OAUTH_CLIENT_SECRET`
          ] ?? process.env.OPENTEAM_MCP_OAUTH_CLIENT_SECRET);
    const clientInformation: OAuthClientInformationMixed | undefined = clientId
      ? { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
      : undefined;
    const callbackUrl = oauth.redirectUrl ?? oauthRedirectUrl(this.publicUrl, connection.id);
    const provider = new OpenTeamOAuthProvider({
      redirectUrl: callbackUrl,
      scope: typeof configuration.scope === "string" ? configuration.scope : undefined,
      authorizationParameters: stringRecord(configuration.oauthAuthorizationParameters),
      initial: oauth,
      clientInformation,
      tokenEndpointAuthMethod: ["none", "client_secret_post", "client_secret_basic"].includes(
        String(configuration.tokenEndpointAuthMethod)
      )
        ? (configuration.tokenEndpointAuthMethod as
            | "none"
            | "client_secret_post"
            | "client_secret_basic")
        : undefined,
      save:
        saveOverride ??
        (async (state) => {
          await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "PluginConnection" WHERE id = ${connection.id}::uuid FOR UPDATE`;
            const latest = await tx.pluginConnection.findUnique({
              where: { id: connection.id },
              select: { credentials: true, runtimeGeneration: true },
            });
            const latestCredentials = jsonObject(latest?.credentials);
            if (
              !latest ||
              (connection.runtimeGeneration !== undefined &&
                latest.runtimeGeneration !== connection.runtimeGeneration) ||
              jsonObject(latestCredentials.oauth).state !== expectedOAuthState
            )
              throw new ApiError(
                409,
                "plugin_oauth_session_changed",
                "A newer authorization attempt or configuration change replaced this session"
              );
            await tx.pluginConnection.update({
              where: { id: connection.id },
              data: { credentials: toJson({ ...latestCredentials, oauth: state }) },
            });
          });
          expectedOAuthState = state.state;
        }),
    });
    return provider;
  }

  private async packagedOAuth(connection: OAuthConnection) {
    const installed = await this.prisma.pluginConnection.findUniqueOrThrow({
      where: { id: connection.id },
      select: { installation: { select: { manifest: true } } },
    });
    const oauth = definitionFromManifest(installed.installation.manifest)?.connections.find(
      (candidate) => candidate.key === connection.connectorKey
    )?.oauth;
    if (!oauth?.authorizationServer || !oauth.accessTokenEnv)
      throw new Error("This packaged connector has no OAuth configuration");
    return oauth;
  }

  async beginStdioOAuth(connection: OAuthConnection) {
    await this.stopRuntime(connection.id, "stdio");
    return beginPackagedOAuth(this.oauthProvider(connection), await this.packagedOAuth(connection));
  }

  async finishStdioOAuth(connection: OAuthConnection, code: string) {
    await finishPackagedOAuth(
      this.oauthProvider(connection),
      await this.packagedOAuth(connection),
      code
    );
    return this.discoverStdio(connection);
  }

  async testConnection(
    connection: {
      id: string;
      connectorKey: string;
      transport: string;
      authType: string;
      endpoint: string | null;
      configuration: Prisma.JsonValue;
      credentials: Prisma.JsonValue;
    },
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const result =
      connection.transport === "builtin"
        ? await this.invokeBuiltin(toolName, args, { connectionId: connection.id })
        : connection.transport === "stdio"
          ? await this.callStdio(connection, toolName, args)
          : await this.http.call(connection.id, this.httpOptions(connection), toolName, args);
    return boundPluginResult(redactConnectionSecrets(result, connection));
  }

  async discoverStdio(connection: {
    id: string;
    configuration: Prisma.JsonValue;
    credentials?: Prisma.JsonValue;
  }): Promise<PluginToolDefinition[]> {
    const response = await this.callComputer(`/v1/mcp/connections/${connection.id}/discover`, {
      configuration: await this.stdioConfiguration(connection),
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
        defaultDecision: readOnly && !destructive ? "allow" : "prompt",
      };
    });
  }

  private async callStdio(
    connection: { id: string; configuration: Prisma.JsonValue; credentials?: Prisma.JsonValue },
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const configuration = await this.stdioConfiguration(connection);
    const response = await this.callComputer(`/v1/mcp/connections/${connection.id}/call`, {
      configuration,
      toolName,
      arguments: args,
    });
    return redactConnectionSecrets(response.result, {
      configuration: {},
      credentials: { env: configuration.env },
    });
  }

  private async stdioConfiguration(connection: {
    id: string;
    configuration: Prisma.JsonValue;
    credentials?: Prisma.JsonValue;
  }) {
    // A database lock serializes refreshes across server processes, including rotating tokens.
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "PluginConnection" WHERE id = ${connection.id}::uuid FOR UPDATE`;
        const current = await tx.pluginConnection.findUniqueOrThrow({
          where: { id: connection.id },
          include: { installation: { select: { manifest: true } } },
        });
        const definition = definitionFromManifest(current.installation.manifest);
        const configuration = runtimeConfiguration(current);
        const oauth = definition?.connections.find(
          (candidate) => candidate.key === current.connectorKey
        )?.oauth;
        let env = stringRecord(configuration.env);
        if (current.authType === "oauth") {
          if (!oauth?.authorizationServer || !oauth.accessTokenEnv)
            throw new Error("This packaged connector has no OAuth configuration");
          const provider = this.oauthProvider(current, async (state) => {
            await tx.pluginConnection.update({
              where: { id: current.id },
              data: { credentials: toJson({ ...jsonObject(current.credentials), oauth: state }) },
            });
          });
          env = { ...env, [oauth.accessTokenEnv]: await packagedAccessToken(provider, oauth) };
        }
        // Never send client secrets, refresh tokens, or setup values to the child process.
        return {
          runtime: configuration.runtime,
          provider: configuration.provider,
          command: configuration.command,
          args: configuration.args,
          cwd: configuration.cwd,
          env: { ...env, OPENTEAM_PLUGIN_ACCOUNT_ID: current.id },
          packageFiles: definition?.files ?? {},
          packageBinaryFiles: definition?.binaryFiles ?? {},
        };
      },
      { maxWait: 40_000, timeout: 40_000 }
    );
  }

  /** Used only by the private binary-transfer service, never exposed as a tool result. */
  async providerAccessToken(connectionId: string): Promise<string> {
    const current=await this.prisma.pluginConnection.findUniqueOrThrow({where:{id:connectionId}});
    if(current.status!=="ready")throw new Error("Connection is no longer ready");
    if(current.transport==="stdio")return this.fileAccessToken(current);
    const token=current.authType==="oauth"?await this.prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "PluginConnection" WHERE id = ${connectionId}::uuid FOR UPDATE`;
      const latest=await tx.pluginConnection.findUniqueOrThrow({where:{id:connectionId}});
      if(latest.status!=="ready")throw new Error("Connection is no longer ready");
      const state=jsonObject(jsonObject(latest.credentials).oauth) as StoredOAuthState;
      const provider=this.oauthProvider(latest,async oauth=>{await tx.pluginConnection.update({where:{id:connectionId},data:{credentials:toJson({...jsonObject(latest.credentials),oauth})}});});
      if(!state.tokens?.access_token||state.tokensExpireAt!==undefined&&state.tokensExpireAt<Date.now()+60_000){
        // Native delivery uses the same persisted SDK OAuth refresh path as MCP.
        // Any interactive reauthorization stays pending in account settings.
        const endpoint=runtimeEndpoint(latest);if(!endpoint)throw new Error("This OAuth connection has no endpoint");
        if(await auth(provider,{serverUrl:endpoint,scope:provider.clientMetadata.scope})!=="AUTHORIZED")throw new Error("Reauthenticate this account in plugin settings before sending files");
      }
      return provider.tokens()?.access_token;
    },{maxWait:40_000,timeout:40_000}):jsonObject(current.credentials).bearerToken;
    if(typeof token!=="string"||!token)throw new Error("This connection has no native API access token; authenticate again");
    return token;
  }

  async fileAccessToken(connection: { id: string; configuration: Prisma.JsonValue; credentials: Prisma.JsonValue }): Promise<string> {
    const configuration = await this.stdioConfiguration(connection);
    const env = configuration.env as Record<string, string>;
    const token = env.GOOGLE_ACCESS_TOKEN ?? env.MICROSOFT_ACCESS_TOKEN;
    if (!token) throw new Error("This account has no authenticated file-transfer token");
    return token;
  }

  async stopRuntime(connectionId: string, transport: string): Promise<void> {
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
      // Native authorization waits for the user's 1Password prompt; the generic RPC budget is 10s.
      ...(jsonObject(jsonObject(body).configuration).runtime === "desktop"
        ? { signal: AbortSignal.timeout(180_000) } : {}),
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

  private async invokeBuiltin(
    toolName: string,
    argsValue: unknown,
    context: { connectionId: string; botId?: string }
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
