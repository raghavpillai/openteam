import type { PluginDynamicNamespace } from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const runtimeStatus = (status: string): PluginDynamicNamespace["namespaceStatus"] => {
  if (status === "ready") return "ready";
  if (status === "needs_auth") return "needsAuth";
  if (status === "error") return "error";
  return "loading";
};

const namespaceName = (pluginKey: string, alias: string): string =>
  `${pluginKey.replaceAll("-", "_")}_${alias.replace(/[^A-Za-z0-9_]+/g, "_")}`;

export const pluginRuntimeContext = async (
  prisma: PrismaClient,
  botId: string
): Promise<{ dynamicNamespaces: PluginDynamicNamespace[]; skillInstructions: string }> => {
  const [grants, enablements] = await Promise.all([
    prisma.botPluginConnectionGrant.findMany({
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
    }),
    prisma.botPluginEnablement.findMany({
      where: {
        botId,
        enabled: true,
        skillsEnabled: true,
        installation: { status: "installed" },
      },
      include: { installation: true },
    }),
  ]);

  const dynamicNamespaces: PluginDynamicNamespace[] = grants.map(({ connection }) => ({
    name: namespaceName(connection.installation.pluginKey, connection.alias),
    description: `${connection.installation.name}: ${connection.name}`,
    namespaceStatus: runtimeStatus(connection.status),
    tools: Array.isArray(connection.toolSnapshot)
      ? connection.toolSnapshot.flatMap((candidate) => {
          const tool = objectValue(candidate);
          if (typeof tool.name !== "string") return [];
          return [
            {
              connectionId: connection.id,
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: objectValue(tool.inputSchema),
              source: `${connection.installation.pluginKey}/${connection.connectorKey}`,
            },
          ];
        })
      : [],
  }));

  const skills = enablements.flatMap(({ installation }) => {
    const manifest = objectValue(installation.manifest);
    return Array.isArray(manifest.skills)
      ? manifest.skills.flatMap((candidate) => {
          const skill = objectValue(candidate);
          if (typeof skill.name !== "string" || typeof skill.body !== "string") return [];
          const description =
            typeof skill.description === "string" ? `${skill.description}\n\n` : "";
          return [`### ${installation.name}: ${skill.name}\n${description}${skill.body}`];
        })
      : [];
  });

  return {
    dynamicNamespaces,
    skillInstructions: skills.length
      ? `\n\n## Installed plugin skills\n\n${skills.join("\n\n")}`
      : "",
  };
};
