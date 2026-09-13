import type {
  PluginActivityView,
  PluginBotAccessView,
  PluginConnectionStatusesView,
  PluginDynamicNamespace,
  PluginInstallView,
  PluginSettingsView,
} from "@openteam/contracts";
import { createHash } from "node:crypto";
import {
  ApiError,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
  PLUGIN_CONNECTION_ID_MAX_LENGTH,
  PLUGIN_CONNECTION_STATUS_MAX_IDS,
} from "@openteam/contracts";
import type { Prisma, PrismaClient } from "@openteam/db";
import { connectionNamespace, effectiveToolPolicy } from "@openteam/plugin-sdk";
import type { PluginDefinition } from "../../plugins/catalog";
import { serviceEffect } from "../service-utils";
import {
  catalogView,
  canonicalJson,
  connectionConfigured,
  connectionView,
  definitionFromManifest,
  jsonObject,
  namespaceName,
  publicTools,
  statusForRuntime,
  toolSnapshot,
} from "./values";

export class PluginQueries {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: () => Promise<PluginDefinition[]>,
    private readonly definition: (pluginKey: string) => Promise<PluginDefinition | undefined>,
    private readonly publicUrl: string
  ) {}
  settings = () =>
    serviceEffect(async (): Promise<PluginSettingsView> => {
      const [catalog, installs, botCount, policies, activity] = await Promise.all([
        this.catalog(),
        this.prisma.pluginInstallation.findMany({
          include: { connections: true },
          orderBy: { installedAt: "desc" },
        }),
        this.prisma.bot.count({ where: { status: { not: "archived" } } }),
        this.prisma.pluginToolPolicy.findMany({
          where: { botId: null },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.pluginActivity.findMany({
          include: { installation: { select: { pluginKey: true } } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      ]);
      const installedKeys = new Set(installs.map((install) => install.pluginKey));
      return {
        catalog: catalog.map((plugin) => catalogView(plugin, installedKeys.has(plugin.key))),
        installs: installs.map(
          (install): PluginInstallView => ({
            packageDigest: createHash("sha256")
              .update(canonicalJson(install.manifest))
              .digest("hex"),
            catalog: definitionFromManifest(install.manifest)
              ? catalogView(
                  definitionFromManifest(install.manifest)!,
                  true,
                  catalog.find((plugin) => plugin.key === install.pluginKey)
                )
              : undefined,
            id: install.id,
            pluginKey: install.pluginKey,
            version: install.version,
            name: install.name,
            description: install.description,
            publisher: install.publisher,
            status: install.status,
            installedAt: install.installedAt.toISOString(),
            hasSkills: (definitionFromManifest(install.manifest)?.skills.length ?? 0) > 0,
            connections: install.connections.map((connection) =>
              connectionView(this.publicUrl, install.pluginKey, connection)
            ),
          })
        ),
        botCount,
        policies: policies.map(({ id, connectionId, botId, toolName, decision, enabled }) => ({
          id,
          connectionId,
          botId,
          toolName,
          decision,
          enabled,
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
    });

  pollConnectionStatuses = (connectionIds: readonly string[]) =>
    serviceEffect(async (): Promise<PluginConnectionStatusesView> => {
      const ids = [
        ...new Set(
          connectionIds.filter(
            (id) => id.length > 0 && id.length <= PLUGIN_CONNECTION_ID_MAX_LENGTH
          )
        ),
      ].slice(0, PLUGIN_CONNECTION_STATUS_MAX_IDS);
      if (ids.length === 0) return { connections: [] };
      return {
        connections: (
          await this.prisma.pluginConnection.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              authType: true,
              status: true,
              statusMessage: true,
              configuration: true,
              credentials: true,
              toolSnapshot: true,
              updatedAt: true,
            },
            orderBy: { id: "asc" },
          })
        ).map((connection) => ({
          id: connection.id,
          revision: connection.updatedAt.toISOString(),
          status: connection.status,
          statusMessage: connection.statusMessage,
          authorizationUrl:
            typeof jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl ===
            "string"
              ? String(jsonObject(jsonObject(connection.credentials).oauth).authorizationUrl)
              : null,
          configured: connectionConfigured(connection),
          tools: publicTools(connection.toolSnapshot),
        })),
      };
    });

  botAccess = (pluginKey: string, queryValue: string, offsetValue: number, limitValue: number) =>
    serviceEffect(async (): Promise<PluginBotAccessView> => {
      const query = queryValue
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH);
      const offset = Number.isInteger(offsetValue) ? Math.max(0, offsetValue) : 0;
      const limit = Number.isInteger(limitValue)
        ? Math.max(1, Math.min(PLUGIN_BOT_ACCESS_PAGE_SIZE, limitValue))
        : PLUGIN_BOT_ACCESS_PAGE_SIZE;
      const installation = await this.prisma.pluginInstallation.findUnique({
        where: { pluginKey },
        select: { id: true },
      });
      if (!installation) {
        throw new ApiError(404, "plugin_not_installed", "Plugin is not installed");
      }
      const where: Prisma.BotWhereInput = {
        status: { not: "archived" },
        ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      };
      const [total, bots] = await Promise.all([
        this.prisma.bot.count({ where }),
        this.prisma.bot.findMany({
          where,
          select: {
            id: true,
            name: true,
            icon: true,
            color: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: offset,
          take: limit,
        }),
      ]);
      const botIds = bots.map((bot) => bot.id);
      if (botIds.length === 0) {
        return { pluginKey, query, offset, total, bots: [] };
      }
      const [grants, enablements] = await Promise.all([
        this.prisma.botPluginConnectionGrant.findMany({
          where: {
            botId: { in: botIds },
            enabled: true,
            connection: { installationId: installation.id },
          },
          select: { botId: true, connectionId: true },
          orderBy: [{ botId: "asc" }, { connectionId: "asc" }],
        }),
        this.prisma.botPluginEnablement.findMany({
          where: {
            installationId: installation.id,
            botId: { in: botIds },
            enabled: true,
            skillsEnabled: true,
          },
          select: { botId: true },
        }),
      ]);
      const grantsByBot = new Map<string, string[]>();
      for (const grant of grants) {
        const connectionIds = grantsByBot.get(grant.botId) ?? [];
        connectionIds.push(grant.connectionId);
        grantsByBot.set(grant.botId, connectionIds);
      }
      const skillsEnabled = new Set(enablements.map((enablement) => enablement.botId));
      return {
        pluginKey,
        query,
        offset,
        total,
        bots: bots.map((bot) => ({
          ...bot,
          skillsEnabled: skillsEnabled.has(bot.id),
          grantedConnectionIds: grantsByBot.get(bot.id) ?? [],
        })),
      };
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
      include: {
        connections: {
          include: { _count: { select: { grants: { where: { enabled: true } } } } },
        },
      },
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
          grantedBotCount: connection._count.grants,
        })) ?? [],
    };
  };

  connectionStatuses = async (connectionId?: string): Promise<unknown> => ({
    connections: await this.prisma.pluginConnection
      .findMany({
        where: connectionId ? { id: connectionId } : undefined,
        include: {
          installation: { select: { pluginKey: true, name: true } },
          _count: { select: { grants: { where: { enabled: true } } } },
        },
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
          grantedBotCount: connection._count.grants,
          lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
        }))
      ),
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
            mode: { not: "disabled" },
            enablements: { some: { botId, enabled: true } },
          },
        },
      },
      include: {
        connection: {
          include: {
            installation: true,
            policies: { where: { OR: [{ botId: null }, { botId }] } },
          },
        },
      },
      orderBy: { connection: { createdAt: "asc" } },
    });
    return grants.map(({ connection }) => ({
      name: connectionNamespace(connection.id),
      description: `${connection.installation.name}: ${connection.name}${connection.instructions ? `\nSaved instructions: ${connection.instructions}` : ""}`,
      namespaceStatus: statusForRuntime(connection.status),
      tools: toolSnapshot(connection.toolSnapshot)
        .filter(
          (tool) =>
            effectiveToolPolicy(connection.policies, tool.name, botId, tool.defaultDecision).enabled
        )
        .map((tool) => ({
          connectionId: connection.id,
          name: tool.name,
          description: tool.description,
          inputSchema: { ...tool.inputSchema },
          source: `${connection.installation.pluginKey}/${connection.connectorKey}`,
        })),
    }));
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
      const plugin = definitionFromManifest(installation.manifest);
      return (plugin?.skills ?? []).map(
        (skill) =>
          `### ${plugin?.name}: ${skill.name}\n${skill.description}\n\n${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(installation.pluginKey)} and skill ${JSON.stringify(skill.name)} in ${process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data"}/plugin-skills/cache.json. Resolve relative file links from that SKILL.md directory.`
      );
    });
    const privateSkills = await this.prisma.pluginPrivateSkill.findMany({
      where: { enabledBotIds: { array_contains: [botId] } },
    });
    sections.push(
      ...privateSkills.map(
        (skill) =>
          `### Private skill: ${skill.name}\n${skill.description}\n\n${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(`private-${skill.id}`)} in ${process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data"}/plugin-skills/cache.json and resolve links from its SKILL.md directory.`
      )
    );
    return sections.length ? `\n\n## Installed plugin skills\n\n${sections.join("\n\n")}` : "";
  };

  composer = (botId: string) =>
    serviceEffect(async () => {
      const [namespaces, enablements, privateSkills] = await Promise.all([
        this.dynamicNamespaces(botId),
        this.prisma.botPluginEnablement.findMany({
          where: {
            botId,
            enabled: true,
            skillsEnabled: true,
            installation: { status: "installed", mode: { not: "disabled" } },
          },
          include: { installation: true },
        }),
        this.prisma.pluginPrivateSkill.findMany({
          where: { enabledBotIds: { array_contains: [botId] } },
        }),
      ]);
      return {
        items: [
          ...namespaces.map((namespace) => ({
            id: namespace.name,
            label: namespace.description.split("\n")[0]!,
            handle: namespace.name,
            trigger: "@" as const,
            kind: "connection" as const,
            status: namespace.namespaceStatus,
          })),
          ...enablements.flatMap(({ installation }) =>
            (definitionFromManifest(installation.manifest)?.skills ?? []).map((skill) => ({
              id: `${installation.id}:${skill.name}`,
              label: skill.name,
              handle: `${installation.pluginKey}:${skill.name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`,
              trigger: "/" as const,
              kind: "skill" as const,
              status: installation.skillSyncStatus,
            }))
          ),
          ...privateSkills.map((skill) => ({
            id: skill.id,
            label: skill.name,
            handle: `private:${skill.name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`,
            trigger: "/" as const,
            kind: "skill" as const,
            status: "ready",
          })),
        ],
      };
    });
}
