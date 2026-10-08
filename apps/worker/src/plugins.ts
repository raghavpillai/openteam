import type { PluginDynamicNamespace } from "@openteam/contracts";
import {
  connectionNamespace,
  fileTransferCapabilities,
  parsePluginRuntimeComponents,
  pluginWorkflowRoot,
  skillIsForAgent,
  type PluginRuntimePackage,
  type PluginSkillAgent,
} from "@openteam/plugin-sdk";
import { PLUGIN_WORKFLOW_HOST_CONTEXT } from "@openteam/contracts/plugin-workflows";
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

type Installation = Awaited<ReturnType<PrismaClient["pluginInstallation"]["findMany"]>>[number];

// Each agent receives the full text of the skills declared for it. Private
// skills are enabled per Bot and stay with its main agent.
const renderSkillInstructions = async (
  prisma: PrismaClient,
  botId: string,
  installations: Installation[],
  agent: PluginSkillAgent | null
): Promise<string> => {
  if (!agent) return "";
  const root = process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data";
  const skills = installations.flatMap((installation) => {
    const manifest = objectValue(installation.manifest);
    return Array.isArray(manifest.skills)
      ? manifest.skills.flatMap((candidate) => {
          const skill = objectValue(candidate);
          if (typeof skill.name !== "string" || typeof skill.body !== "string") return [];
          if (!skillIsForAgent(skill, agent)) return [];
          const description =
            typeof skill.description === "string" ? `${skill.description}\n\n` : "";
          return [
            `### ${installation.name}: ${skill.name}\n${description}${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(installation.pluginKey)} and skill ${JSON.stringify(skill.name)} in ${root}/plugin-skills/cache.json. Resolve relative file links from that SKILL.md directory.`,
          ];
        })
      : [];
  });
  if (agent === "main") {
    const privateSkills = await prisma.pluginPrivateSkill.findMany({
      where: { enabledBotIds: { array_contains: [botId] } },
    });
    skills.push(
      ...privateSkills.map(
        (skill) =>
          `### Private skill: ${skill.name}\n${skill.description}\n\n${skill.body}\n\nSupporting files: find pluginId ${JSON.stringify(`private-${skill.id}`)} in ${root}/plugin-skills/cache.json and resolve links from its SKILL.md directory.`
      )
    );
  }
  return skills.length
    ? `\n\n## Installed plugin skills\n\n${PLUGIN_WORKFLOW_HOST_CONTEXT}\n\n${skills.join("\n\n")}`
    : "";
};

/** Skill text alone, for workers that receive no plugin tools or runtime packages. */
export const pluginSkillInstructions = async (
  prisma: PrismaClient,
  botId: string,
  agent: PluginSkillAgent | null
): Promise<string> =>
  renderSkillInstructions(
    prisma,
    botId,
    await prisma.pluginInstallation.findMany({ where: { status: "installed" } }),
    agent
  );

export const pluginRuntimeContext = async (
  prisma: PrismaClient,
  botId: string,
  agent: PluginSkillAgent | null = "main"
): Promise<{
  dynamicNamespaces: PluginDynamicNamespace[];
  skillInstructions: string;
  pluginRuntimePackages: PluginRuntimePackage[];
}> => {
  const [connections, installations] = await Promise.all([
    prisma.pluginConnection.findMany({
      where: { status: { in: ["ready", "needs_auth", "error"] },
        installation: { status: "installed" } },
      include: { installation: true }, orderBy: { createdAt: "asc" },
    }),
    prisma.pluginInstallation.findMany({where:{status:"installed"}}),
  ]);

  const dynamicNamespaces: PluginDynamicNamespace[] = connections.map((connection) => ({
    name: connectionNamespace(connection.id, connection.alias),
    description: `${connection.installation.name}: ${connection.name} (${connection.alias})${connection.instructions ? `\n${connection.instructions}` : ""}`,
    namespaceStatus: runtimeStatus(connection.status),
    fileTransfers: fileTransferCapabilities(connection.installation.pluginKey),
    tools: Array.isArray(connection.toolSnapshot)
      ? connection.toolSnapshot.flatMap((candidate) => {
          const tool = objectValue(candidate);
          if (
            typeof tool.name !== "string"
          )
            return [];
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

  const root = process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data";
  const cache = await readFile(join(root, "plugin-skills/cache.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  const pluginRuntimePackages: PluginRuntimePackage[] = [];
  for (const installation of installations) {
    const manifest = objectValue(installation.manifest);
    const files = objectValue(manifest.files) as Record<string, string>;
    const components = parsePluginRuntimeComponents(files);
    if (
      ![components.hooks, components.rules, components.commands, components.agents].some(
        (items) => items.length
      )
    )
      continue;
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          version: manifest.version ?? "0",
          skills: manifest.skills,
          files: manifest.files,
          binaryFiles: manifest.binaryFiles,
        })
      )
      .digest("hex")
      .slice(0, 16);
    const installed = (cache.packages ?? []).find(
      (entry: any) =>
        entry.pluginId === installation.pluginKey &&
        entry.pluginVersion === installation.version &&
        entry.revision === revision
    );
    if (!installed?.installPath)
      throw new Error(
        `Plugin runtime cache is unavailable for ${installation.pluginKey}; reinstall or refresh the plugin`
      );
    const desktopOnly =
      Array.isArray(manifest.connections) &&
      manifest.connections.length > 0 &&
      manifest.connections.every(
        (connection: any) => objectValue(connection.configuration).runtime === "desktop"
      );
    pluginRuntimePackages.push({
      ...components,
      key: installation.pluginKey,
      installPath: join(installed.installPath, pluginWorkflowRoot(files)),
      ...(desktopOnly && components.hooks.length
        ? {
            hooksUnavailableReason:
              "This plugin's hooks validate the connected desktop filesystem and cannot run on the Bot computer. They are preserved but inactive here.",
          }
        : {}),
    });
  }
  return {
    dynamicNamespaces,
    pluginRuntimePackages,
    skillInstructions: await renderSkillInstructions(prisma, botId, installations, agent),
  };
};
