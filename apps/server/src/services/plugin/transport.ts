import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ApiError } from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import type { PluginToolDefinition } from "../../plugins/catalog";
import { McpHttpClientManager } from "../../plugins/mcp-client-manager";
import { OpenTeamOAuthProvider, type StoredOAuthState } from "../../plugins/oauth-provider";
import { toJson } from "../service-utils";
import {
  boundPluginResult,
  jsonObject,
  oauthRedirectUrl,
  redact,
  stringRecord,
  type JsonObject,
} from "./values";

export const compatibilityHttpManager = new McpHttpClientManager();

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

  httpOptions(connection: {
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
    const callbackUrl = oauthRedirectUrl(this.publicUrl, connection.id);
    const provider = new OpenTeamOAuthProvider({
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

  async discoverStdio(connection: {
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
