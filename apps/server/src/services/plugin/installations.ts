import { ApiError } from "@openteam/contracts";
import {
  environmentFields,
  fieldsForConnector,
  substituteConfiguration,
  validateValues,
  type ConfigValue,
} from "@openteam/plugin-sdk";
import type { PrismaClient } from "@openteam/db";
import type { PluginDefinition } from "../../plugins/catalog";
import { appendEvent, serviceEffect, toJson } from "../service-utils";
import { definitionFromManifest, hasPlaceholder, manifestJson } from "./values";
import { resolveUpstreamPlugin } from "../../plugins/upstream-package";
import { clearPluginEnvironment, storePluginEnvironment } from "../process-secrets";

/** Provided values for setup fields delivered to Bot computer processes; missing ones stay unset. */
const environmentValues = (
  plugin: PluginDefinition,
  values: Record<string, ConfigValue>
): Array<[string, string]> => {
  const fields = environmentFields(plugin);
  let validated: Record<string, ConfigValue>;
  try {
    validated = validateValues(
      fields,
      Object.fromEntries(
        Object.entries(values)
          .filter(([key]) => fields.some((field) => field.key === key))
          .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
      ),
      false
    );
  } catch (error) {
    throw new ApiError(400, "plugin_setup_invalid", (error as Error).message);
  }
  return fields.flatMap((field) =>
    typeof validated[field.key] === "string" && validated[field.key] !== ""
      ? [[field.environment!, validated[field.key] as string]]
      : []
  );
};

export class PluginInstallations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly definition: (pluginKey: string) => Promise<PluginDefinition | undefined>,
    private readonly syncFileCaches: () => Promise<void>,
    private readonly stopRuntime: (connectionId: string, transport: string) => Promise<void>
  ) {}
  install = (pluginKey: string, values: Record<string, ConfigValue> = {}) =>
    serviceEffect(async () => {
      const candidate = await this.definition(pluginKey);
      if (!candidate) throw new ApiError(404, "plugin_not_found", "Plugin not found");
      const existing = await this.prisma.pluginInstallation.findUnique({ where: { pluginKey } });
      if (existing) {
        await this.syncFileCaches();
        return { id: existing.id, installed: true };
      }
      const plugin = await resolveUpstreamPlugin(candidate);
      const environment = environmentValues(plugin, values);
      const names = environmentFields(plugin).map((field) => field.environment!);
      if (names.length) {
        const others = await this.prisma.pluginInstallation.findMany({ select: { name: true, manifest: true } });
        const conflict = others.find((other) => {
          const definition = definitionFromManifest(other.manifest);
          return definition
            ? environmentFields(definition).some((field) => names.includes(field.environment!))
            : false;
        });
        if (conflict)
          throw new ApiError(409, "plugin_environment_conflict", `${conflict.name} already provides one of this plugin's environment variables`);
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
        for (const connector of plugin.connections) {
          const fields = fieldsForConnector(plugin, connector.key);
          const setupValues = validateValues(
            fields,
            Object.fromEntries(
              Object.entries({
                ...Object.fromEntries(
                  fields
                    .filter((field) => field.default !== undefined)
                    .map((field) => [field.key, field.default])
                ),
                ...values,
              }).filter(([key]) => fields.some((field) => field.key === key))
            ),
            false
          );
          const publicValues = Object.fromEntries(
            Object.entries(setupValues).filter(
              ([key]) => !fields.some((field) => field.key === key && field.secret)
            )
          );
          const secretValues = Object.fromEntries(
            Object.entries(setupValues).filter(([key]) =>
              fields.some((field) => field.key === key && field.secret)
            )
          );
          const endpoint = connector.endpoint;
          const setup =
            connector.setup ??
            (plugin.setup?.connectionKey === connector.key ? plugin.setup : null);
          const configuration = {
            ...(setup?.requiredScopes.length ? { scope: setup.requiredScopes.join(" ") } : {}),
            ...(connector.oauth?.tokenEndpointAuthMethod
              ? { tokenEndpointAuthMethod: connector.oauth.tokenEndpointAuthMethod }
              : {}),
            ...connector.configuration,
            values: publicValues,
          };
          const missingSetup =
            hasPlaceholder(substituteConfiguration(endpoint, setupValues)) ||
            hasPlaceholder(substituteConfiguration(configuration, setupValues)) ||
            fields.some(
              (field) =>
                field.required &&
                (setupValues[field.key] === undefined || setupValues[field.key] === "")
            );
          const connection = await tx.pluginConnection.create({
            data: {
              installationId: created.id,
              connectorKey: connector.key,
              name: connector.name,
              transport: connector.transport,
              authType: connector.auth,
              endpoint,
              configuration: toJson(configuration),
              credentials: toJson({
                values: secretValues,
                ...(secretValues.token ? { bearerToken: secretValues.token } : {}),
              }),
              status: connector.auth === "none" ? "disconnected" : "needs_auth",
              statusMessage: missingSetup
                ? "Plugin setup values are required."
                : connector.auth === "none"
                  ? null
                  : "Authentication has not been configured.",
              toolSnapshot: toJson(connector.tools),
            },
          });
        }
        await storePluginEnvironment(tx, plugin.key, environment);
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
    });

  addCustomMcp = (input: {
    name: string;
    url?: string;
    command?: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    auth?: "none" | "token" | "oauth";
    oauth?: { clientId: string; clientSecret?: string; scopes: string[] };
    alias?: string;
    installationRequestId?: string;
  }) =>
    serviceEffect(async () => {
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
        if (
          !["https:", "http:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        ) {
          throw new ApiError(400, "mcp_url_invalid", "MCP URL must use HTTP or HTTPS");
        }
      }
      const authType = input.auth ?? (Object.keys(input.headers ?? {}).length ? "token" : "none");
      const alias = input.alias?.trim() || "default";
      const configuration = {
        ...(input.oauth
          ? { clientId: input.oauth.clientId, scope: input.oauth.scopes.join(" ") }
          : {}),
        ...(command
          ? { command, args: [...(input.args ?? [])], ...(input.cwd ? { cwd: input.cwd } : {}) }
          : {}),
      };
      const pluginKey = `custom-mcp-${input.installationRequestId ?? crypto.randomUUID()}`;
      const installation = await this.prisma.$transaction(async (tx) => {
        if (input.installationRequestId) {
          const prior = await tx.pluginInstallation.findUnique({
            where: { pluginKey },
            include: { connections: true },
          });
          if (prior) {
            const connection = prior.connections.find((item) => item.connectorKey === "custom");
            if (!connection)
              throw new ApiError(
                409,
                "reviewed_server_changed",
                "The server definition changed; create a new request"
              );
            return { installation: prior, connection };
          }
        }
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
              description: "Custom MCP server",
              category: "MCP",
              featured: false,
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
                  endpoint: endpoint?.toString() ?? "",
                  tools: [],
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
            credentials: toJson({
              headers: input.headers ?? {},
              env: input.env ?? {},
              ...(input.oauth?.clientSecret ? { clientSecret: input.oauth.clientSecret } : {}),
            }),
            status: authType === "oauth" ? "needs_auth" : "disconnected",
            statusMessage: authType === "oauth" ? "Authentication has not been configured." : null,
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
    });

  /** Replace plugin setup secrets delivered to Bot computer processes, e.g. a rotated token. */
  updateEnvironment = (pluginKey: string, values: Record<string, ConfigValue>) =>
    serviceEffect(async () => {
      return this.prisma.$transaction(async (tx) => {
        // Serializes with uninstall so a replaced secret cannot outlive its plugin.
        const [installation] = await tx.$queryRaw<Array<{ manifest: unknown }>>`
          SELECT "manifest" FROM "PluginInstallation" WHERE "pluginKey" = ${pluginKey} FOR UPDATE`;
        if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
        const plugin = definitionFromManifest(installation.manifest);
        if (!plugin) throw new ApiError(409, "plugin_manifest_invalid", "Plugin package is invalid");
        const environment = environmentValues(plugin, values);
        if (!environment.length)
          throw new ApiError(400, "plugin_setup_invalid", "Enter a new value to save");
        await storePluginEnvironment(tx, pluginKey, environment);
        return { updated: environment.map(([name]) => name) };
      });
    });

  uninstall = (pluginKey: string) =>
    serviceEffect(async () => {
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
        await tx.$queryRaw`SELECT 1 FROM "PluginInstallation" WHERE "id" = ${installation.id} FOR UPDATE`;
        await tx.pluginActivity.create({
          data: {
            kind: "plugin.uninstalled",
            summary: `Uninstalled ${installation.name}`,
            metadata: { pluginKey },
          },
        });
        await clearPluginEnvironment(tx, pluginKey);
        await tx.pluginInstallation.delete({ where: { id: installation.id } });
        await appendEvent(tx, "plugin.uninstalled", installation.id, { pluginKey });
      });
      await this.syncFileCaches();
      return { uninstalled: true };
    });
}
