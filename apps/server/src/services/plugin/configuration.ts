import { oauthCallbackMode, MANUAL_OAUTH_REDIRECT } from "../../plugins/oauth-callback";
import {
  ApiError,
  type PluginConfigurationInput,
  type PluginConfigurationView,
} from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import {
  applySecretEdits,
  connectionNamespace,
  desktopMcpProvider,
  fieldsForConnector,
  isSecretKey,
  validateValues,
  type PluginField,
} from "@openteam/plugin-sdk";
import { serviceEffect, toJson } from "../service-utils";
import {
  definitionFromManifest,
  connectionConfigured,
  connectionSetupPhase,
  jsonObject,
  oauthRedirectUrl,
  stringArray,
  stringRecord,
} from "./values";

const authenticationFields = (auth: string): PluginField[] =>
  auth === "token"
    ? [{ key: "token", label: "Access token", required: false, secret: true }]
    : auth === "oauth"
      ? [
          { key: "clientId", label: "OAuth client ID", required: false, secret: false },
          { key: "clientSecret", label: "OAuth client secret", required: false, secret: true },
          { key: "scope", label: "OAuth scopes", required: false, secret: false },
        ]
      : [];

export class PluginConfiguration {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publicUrl: string,
    private readonly stop: (id: string, transport: string) => Promise<void>
  ) {}

  private async connection(id: string) {
    const connection = await this.prisma.pluginConnection.findUnique({
      where: { id },
      include: { installation: true },
    });
    if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
    const plugin = definitionFromManifest(connection.installation.manifest);
    const connector = plugin?.connections.find((entry) => entry.key === connection.connectorKey);
    const declared = plugin ? fieldsForConnector(plugin, connection.connectorKey) : [];
    const fields = [
      ...new Map(
        [...authenticationFields(connection.authType), ...declared].map((field) => [
          field.key,
          field,
        ])
      ).values(),
    ];
    return { connection, plugin, connector, fields };
  }

  get = (id: string) =>
    serviceEffect(async (): Promise<PluginConfigurationView> => {
      const { connection, connector, plugin, fields } = await this.connection(id);
      const config = jsonObject(connection.configuration);
      const credentials = jsonObject(connection.credentials);
      const values: Record<string, unknown> = {
        ...jsonObject(config.values),
        ...(typeof config.clientId === "string" ? { clientId: config.clientId } : {}),
        ...(typeof config.scope === "string" ? { scope: config.scope } : {}),
      };
      return {
        connectionId: id,
        namespace: connectionNamespace(id,connection.alias),
        endpoint: connection.endpoint,
        command: typeof config.command === "string" ? config.command : null,
        runtime: desktopMcpProvider(config) ? "desktop" : "computer",
        args: stringArray(config.args),
        cwd: typeof config.cwd === "string" ? config.cwd : null,
        fields,
        values: Object.fromEntries(
          fields
            .filter((field) => !field.secret && values[field.key] !== undefined)
            .map((field) => [field.key, values[field.key]])
        ) as PluginConfigurationView["values"],
        configuredSecrets: [
          ...new Set([
            ...Object.keys(jsonObject(credentials.values)),
            ...(credentials.bearerToken ? ["token"] : []),
            ...(credentials.clientSecret || config.clientSecret ? ["clientSecret"] : []),
          ]),
        ],
        headerNames: [
          ...new Set([
            ...Object.keys(jsonObject(config.headers)),
            ...Object.keys(jsonObject(credentials.headers)),
          ]),
        ],
        environmentNames: [
          ...new Set([
            ...Object.keys(jsonObject(config.env)),
            ...Object.keys(jsonObject(credentials.env)),
          ]),
        ],
        setup:
          connector?.setup ??
          (plugin?.setup?.connectionKey === connection.connectorKey ? plugin.setup : null),
        callbackUrl: oauthRedirectUrl(this.publicUrl, id),
        oauthCallbackMode: (["desktop", "server", "manual"].includes(String(config.oauthCallbackMode)) ? config.oauthCallbackMode : "auto") as PluginConfigurationView["oauthCallbackMode"],
        resolvedOAuthCallbackMode: oauthCallbackMode(this.publicUrl, config),
        manualCallbackUrl: MANUAL_OAUTH_REDIRECT,
        manualCallbackSupported: connector?.oauth?.supportsLoopbackRedirect !== false,
        setupPhase: connectionSetupPhase(connection, plugin),
        oauthLoopbackPort: typeof config.oauthLoopbackPort === "number" ? config.oauthLoopbackPort : 0,
        tokenEndpointAuthMethod: String(
          config.tokenEndpointAuthMethod ??
            connector?.oauth?.tokenEndpointAuthMethod ??
            (credentials.clientSecret || config.clientSecret ? "client_secret_post" : "none")
        ),
      };
    });

  save = (id: string, input: PluginConfigurationInput) =>
    serviceEffect(async () => {
      const { connection, fields, plugin } = await this.connection(id);
      const config = { ...jsonObject(connection.configuration) };
      const credentials = { ...jsonObject(connection.credentials) };
      if (input.values) {
        const validated = validateValues(fields, input.values, false);
        const publicValues = { ...jsonObject(config.values) };
        const secretValues = { ...stringRecord(credentials.values) };
        for (const [key, value] of Object.entries(validated)) {
          if (fields.find((field) => field.key === key)?.secret) secretValues[key] = String(value);
          else publicValues[key] = value;
        }
        config.values = publicValues;
        credentials.values = secretValues;
      }
      if (input.secrets) {
        for (const key of Object.keys(input.secrets))
          if (!fields.some((field) => field.key === key && field.secret))
            throw new ApiError(400, "unknown_secret", `Unknown secret field: ${key}`);
        credentials.values = applySecretEdits(
          {
            ...stringRecord(credentials.values),
            ...(typeof credentials.bearerToken === "string"
              ? { token: credentials.bearerToken }
              : {}),
            ...(typeof credentials.clientSecret === "string"
              ? { clientSecret: credentials.clientSecret }
              : {}),
            ...(typeof config.clientSecret === "string"
              ? { clientSecret: config.clientSecret }
              : {}),
          },
          input.secrets
        );
      }
      const secretValues = jsonObject(credentials.values);
      if (input.secrets?.token || secretValues.token) {
        if (secretValues.token) credentials.bearerToken = secretValues.token;
        else delete credentials.bearerToken;
      }
      if (input.secrets?.clientSecret || secretValues.clientSecret) {
        if (secretValues.clientSecret) credentials.clientSecret = secretValues.clientSecret;
        else delete credentials.clientSecret;
        delete config.clientSecret;
      }
      const values = jsonObject(config.values);
      if (values.clientId !== undefined) config.clientId = values.clientId;
      if (values.scope !== undefined) config.scope = values.scope;
      for (const [key, value] of Object.entries({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
        oauthCallbackMode: input.oauthCallbackMode,
        oauthLoopbackPort: input.oauthLoopbackPort,
      }))
        if (value !== undefined) config[key] = value;
      for (const key of ["headers", "env"] as const) {
        // Header and environment values are always treated as credentials, regardless of their names.
        if (input[key] !== undefined) {
          credentials[key] = input[key];
          delete config[key];
        }
      }
      let endpoint = connection.endpoint;
      desktopMcpProvider({ ...config, env: { ...jsonObject(config.env), ...jsonObject(credentials.env) } });
      if (input.endpoint !== undefined) {
        const url = new URL(input.endpoint);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new ApiError(
            400,
            "mcp_url_invalid",
            "Use an HTTP(S) URL without embedded credentials"
          );
        endpoint = url.toString();
      }
      const changed =
        JSON.stringify(config) !== JSON.stringify(connection.configuration) ||
        JSON.stringify(credentials) !== JSON.stringify(connection.credentials) ||
        endpoint !== connection.endpoint;
      if (changed) {
        delete credentials.oauth;
        await this.stop(id, connection.transport);
        await this.prisma.pluginConnection.update({
          where: { id },
          data: {
            endpoint,
            configuration: toJson(config),
            credentials: toJson(credentials),
            runtimeGeneration: { increment: 1 },
            status: "disconnected",
            statusMessage: null,
          },
        });
      }
      return { id, configured: connectionConfigured({ ...connection, configuration: config, credentials }, plugin) };
    });
}
