import { cancelPendingPluginWork } from "./pending-work";
import { ApiError } from "@openteam/contracts";
import {
  fieldsForConnector,
  substituteConfiguration,
  validateValues,
  type ConfigValue,
} from "@openteam/plugin-sdk";
import type { PrismaClient } from "@openteam/db";
import type { PluginDefinition } from "../../plugins/catalog";
import { appendEvent, serviceEffect, toJson } from "../service-utils";
import { hasPlaceholder, manifestJson } from "./values";
import { resolveUpstreamPlugin } from "../../plugins/upstream-package";

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
    reviewedRequestId?: string;
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
      const pluginKey = `custom-mcp-${input.reviewedRequestId ?? crypto.randomUUID()}`;
      const installation = await this.prisma.$transaction(async (tx) => {
        if (input.reviewedRequestId) {
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
                "The reviewed server changed; request a new approval"
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

  uninstall = (pluginKey: string) =>
    serviceEffect(async () => {
      const installation = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey },
        include: { connections: { select: { id: true, transport: true } } },
      });
      if (!installation) throw new ApiError(404, "plugin_not_installed", "Plugin not installed");
      if (installation.mode === "required")
        throw new ApiError(
          403,
          "plugin_required",
          "Change the workspace installation policy before removing this required plugin"
        );
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
        await cancelPendingPluginWork(
          tx,
          installation.connections.map((connection) => connection.id)
        );
        await tx.pluginInstallation.delete({ where: { id: installation.id } });
        await appendEvent(tx, "plugin.uninstalled", installation.id, { pluginKey });
      });
      await this.syncFileCaches();
      return { uninstalled: true };
    });
}
