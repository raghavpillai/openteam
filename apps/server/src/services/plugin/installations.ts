import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import type { PluginDefinition } from "../../plugins/catalog";
import { appendEvent, serviceEffect, toJson } from "../service-utils";
import { hasPlaceholder, manifestJson, substituteValues } from "./values";

export class PluginInstallations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly definition: (pluginKey: string) => Promise<PluginDefinition | undefined>,
    private readonly syncFileCaches: () => Promise<void>,
    private readonly stopRuntime: (connectionId: string, transport: string) => Promise<void>
  ) {}
  install = (pluginKey: string, values: Record<string, string> = {}) =>
    serviceEffect(async () => {
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
    });
}
