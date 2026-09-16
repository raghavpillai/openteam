import type { PluginDynamicNamespace } from "@openteam/contracts";
import { connectionNamespace, effectiveToolPolicy, fileTransferCapabilities, parsePluginRuntimeComponents, type PluginRuntimePackage } from "@openteam/plugin-sdk";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PrismaClient } from "@openteam/db";

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
): Promise<{ dynamicNamespaces: PluginDynamicNamespace[]; skillInstructions: string; pluginRuntimePackages: PluginRuntimePackage[] }> => {
  const [grants, enablements] = await Promise.all([
    prisma.botPluginConnectionGrant.findMany({
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
      include: { connection: { include: { installation: true, policies: { where: { OR: [{ botId: null }, { botId }] } } } } },
      orderBy: { connection: { createdAt: "asc" } },
    }),
    prisma.botPluginEnablement.findMany({
      where: {
        botId,
        enabled: true,
        skillsEnabled: true,
        installation: { status: "installed", mode: { not: "disabled" } },
      },
      include: { installation: true },
    }),
  ]);

  const dynamicNamespaces: PluginDynamicNamespace[] = grants.map(({ connection }) => ({
    name: connectionNamespace(connection.id, connection.alias),
    description: `${connection.installation.name}: ${connection.name} (${connection.alias})${connection.instructions ? `\n${connection.instructions}` : ""}`,
    namespaceStatus: runtimeStatus(connection.status),
    fileTransfers: fileTransferCapabilities(connection.installation.pluginKey, connection.policies, Array.isArray(connection.toolSnapshot) ? connection.toolSnapshot.map(objectValue).filter(tool => typeof tool.name === "string") as any : [], botId),
    tools: Array.isArray(connection.toolSnapshot)
      ? connection.toolSnapshot.flatMap((candidate) => {
          const tool = objectValue(candidate);
          if (typeof tool.name !== "string" || !effectiveToolPolicy(connection.policies, tool.name, botId, "prompt").enabled) return [];
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
          return [`### ${installation.name}: ${skill.name}\n${description}${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(installation.pluginKey)} and skill ${JSON.stringify(skill.name)} in ${process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data"}/plugin-skills/cache.json. Resolve relative file links from that SKILL.md directory.`];
        })
      : [];
  });

  const privateSkills = await prisma.pluginPrivateSkill.findMany({ where: { enabledBotIds: { array_contains: [botId] } } });
  skills.push(...privateSkills.map((skill) => `### Private skill: ${skill.name}\n${skill.description}\n\n${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(`private-${skill.id}`)} in ${process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data"}/plugin-skills/cache.json and resolve links from its SKILL.md directory.`));
  const root = process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data";
  const cache = await readFile(join(root, "plugin-skills/cache.json"), "utf8").then(text => JSON.parse(text)).catch(() => ({}));
  const pluginRuntimePackages: PluginRuntimePackage[] = [];
  for (const { installation } of enablements) {
    const manifest = objectValue(installation.manifest);
    const files = objectValue(manifest.files) as Record<string, string>;
    const components = parsePluginRuntimeComponents(files);
    if (![components.hooks, components.rules, components.commands, components.agents].some(items => items.length)) continue;
    const revision = createHash("sha256").update(JSON.stringify({ version: manifest.version ?? "0", skills: manifest.skills, files: manifest.files, binaryFiles: manifest.binaryFiles })).digest("hex").slice(0, 16);
    const installed = (cache.packages ?? []).find((entry: any) => entry.pluginId === installation.pluginKey && entry.pluginVersion === installation.version && entry.revision === revision);
    if (!installed?.installPath) throw new Error(`Plugin runtime cache is unavailable for ${installation.pluginKey}; reinstall or refresh the plugin`);
    pluginRuntimePackages.push({ ...components, key: installation.pluginKey, installPath: installed.installPath });
  }
  return {
    dynamicNamespaces,
    pluginRuntimePackages,
    skillInstructions: skills.length
      ? `\n\n## Installed plugin skills\n\n${skills.join("\n\n")}`
      : "",
  };
};
