import type { PluginDynamicNamespace } from "@openteam/contracts";
import {
  connectionNamespaces,
  parsePluginRuntimeComponents,
  pluginWorkflowRoot,
  type PluginRuntimePackage,
  type PluginSkillAgent,
} from "@openteam/plugin-sdk";
import { PLUGIN_WORKFLOW_HOST_CONTEXT } from "@openteam/contracts/plugin-workflows";
import { connectorCustomInstructionsSection, pluginDynamicNamespaces } from "@openteam/contracts/plugin-namespaces";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@openteam/db";
import {
  cachedPluginPackage,
  pluginPackageRevision,
  pluginSkillsForAgent,
  type PluginSkillCache,
} from "@openteam/messaging";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

type Installation = Awaited<ReturnType<PrismaClient["pluginInstallation"]["findMany"]>>[number];

const agentDataRoot = (): string => process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/agent-data";

const readSkillCache = (): Promise<PluginSkillCache> =>
  readFile(join(agentDataRoot(), "plugin-skills/cache.json"), "utf8")
    .then((text) => JSON.parse(text) as PluginSkillCache)
    .catch(() => ({}));

// The main agent's agent_skills catalog lists each plugin skill whose files are
// on the computer, read on demand like managed and saved skills. This section
// keeps the provider-workflow notes and the full text of skills whose files are
// not written yet. An agent a skill names explicitly gets its full text.
const renderSkillInstructions = async (
  prisma: PrismaClient,
  botId: string,
  installations: Installation[],
  agent: PluginSkillAgent | null
): Promise<string> => {
  if (!agent) return "";
  const root = agentDataRoot();
  const main = agent === "main";
  const entries = pluginSkillsForAgent(
    main ? await readSkillCache() : {},
    installations,
    main
      ? await prisma.pluginPrivateSkill.findMany({
          where: { enabledBotIds: { array_contains: [botId] } },
        })
      : [],
    agent
  );
  if (!entries.length) return "";
  const fullText = entries
    .filter((entry) => !entry.path)
    .map((entry) =>
      entry.pluginName === null
        ? `### Private skill: ${entry.name}\n${entry.description}\n\n${entry.body}\n\nSupporting files: find pluginId ${JSON.stringify(entry.pluginId)} in ${root}/plugin-skills/cache.json and resolve links from its SKILL.md directory.`
        : `### ${entry.pluginName}: ${entry.name}\n${entry.description ? `${entry.description}\n\n` : ""}${entry.body}\n\nSupporting files: find pluginId ${JSON.stringify(entry.pluginId)} and skill ${JSON.stringify(entry.name)} in ${root}/plugin-skills/cache.json. Resolve relative file links from that SKILL.md directory.`
    );
  return `\n\n## Installed plugin skills\n\n${[
    PLUGIN_WORKFLOW_HOST_CONTEXT,
    ...(fullText.length < entries.length
      ? ["Installed plugin skills are listed with their SKILL.md paths in the agent_skills catalog in user_info."]
      : []),
    ...fullText,
  ].join("\n\n")}`;
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
  const [connections, installations, named] = await Promise.all([
    prisma.pluginConnection.findMany({
      where: { status: { in: ["ready", "needs_auth", "error"] },
        installation: { status: "installed" } },
      include: { installation: true }, orderBy: { createdAt: "asc" },
    }),
    prisma.pluginInstallation.findMany({where:{status:"installed"}}),
    // Named from every connection, as the server names them.
    prisma.pluginConnection.findMany({ select: { id: true, name: true, alias: true, createdAt: true } }),
  ]);
  const namespaces = connectionNamespaces(named);

  const dynamicNamespaces = pluginDynamicNamespaces(connections, namespaces);
  // Saved connector instructions are rules for the main agent and its routine runs, not for workers.
  const customInstructions = agent === "main" ? connectorCustomInstructionsSection(connections, namespaces) : "";

  const cache = await readSkillCache();
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
    const installed = cachedPluginPackage(
      cache,
      installation.pluginKey,
      installation.version,
      pluginPackageRevision(manifest)
    );
    if (!installed)
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
    skillInstructions: [customInstructions && `\n\n${customInstructions}`, await renderSkillInstructions(prisma, botId, installations, agent)].join(""),
  };
};
