import { skillIsForAgent, type PluginSkillAgent } from "@openteam/plugin-sdk";
import { digest } from "./file-state";
import { agentSkillItem } from "./skill-catalog";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

/** The index the plugin service writes to plugin-skills/cache.json. */
export interface PluginSkillCache {
  packages?: Array<{ pluginId?: unknown; pluginVersion?: unknown; revision?: unknown; installPath?: unknown }>;
  skills?: Array<{ name?: unknown; installPath?: unknown; filePath?: unknown }>;
}

export interface PluginSkillInstallation {
  name: string;
  pluginKey: string;
  version: string;
  manifest: unknown;
}

export interface PluginPrivateSkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: Date;
}

export interface PluginSkillEntry {
  /** Plugin key, or `private-<id>` for a private skill. */
  pluginId: string;
  /** Plugin display name; null for a private skill. */
  pluginName: string | null;
  name: string;
  description: string;
  body: string;
  /** The skill's SKILL.md on the Bot computer, once the plugin service has written it. */
  path?: string;
}

// Must match the revision the plugin service gives each package it writes to the cache.
export const pluginPackageRevision = (manifest: unknown): string =>
  digest(
    JSON.stringify({
      version: objectValue(manifest).version ?? "0",
      skills: objectValue(manifest).skills,
      files: objectValue(manifest).files,
      binaryFiles: objectValue(manifest).binaryFiles,
    })
  ).slice(0, 16);

/** The cached package for a plugin version; `revision` pins the exact package contents. */
export const cachedPluginPackage = (
  cache: PluginSkillCache,
  pluginId: string,
  version: string,
  revision?: string
): { installPath: string } | undefined =>
  (cache.packages ?? []).find(
    (entry): entry is { installPath: string } =>
      entry.pluginId === pluginId &&
      entry.pluginVersion === version &&
      (revision === undefined || entry.revision === revision) &&
      typeof entry.installPath === "string"
  );

const cachedSkillPath = (
  cache: PluginSkillCache,
  pluginId: string,
  version: string,
  revision: string | undefined,
  name: string
): string | undefined => {
  const installed = cachedPluginPackage(cache, pluginId, version, revision);
  if (!installed) return undefined;
  const record = (cache.skills ?? []).find(
    (entry) => entry.installPath === installed.installPath && entry.name === name
  );
  return typeof record?.filePath === "string" ? record.filePath : undefined;
};

/** Plugin skills declared for an agent. Private skills are enabled per Bot and go to its main agent only. */
export const pluginSkillsForAgent = (
  cache: PluginSkillCache,
  installations: readonly PluginSkillInstallation[],
  privateSkills: readonly PluginPrivateSkillRecord[],
  agent: PluginSkillAgent
): PluginSkillEntry[] => {
  const entries: PluginSkillEntry[] = [];
  for (const installation of installations) {
    const manifest = objectValue(installation.manifest);
    if (!Array.isArray(manifest.skills)) continue;
    const revision = pluginPackageRevision(manifest);
    for (const candidate of manifest.skills) {
      const skill = objectValue(candidate);
      if (typeof skill.name !== "string" || typeof skill.body !== "string") continue;
      if (!skillIsForAgent(skill, agent)) continue;
      entries.push({
        pluginId: installation.pluginKey,
        pluginName: installation.name,
        name: skill.name,
        description: typeof skill.description === "string" ? skill.description : "",
        body: skill.body,
        path: cachedSkillPath(cache, installation.pluginKey, installation.version, revision, skill.name),
      });
    }
  }
  if (agent !== "main") return entries;
  for (const skill of privateSkills) {
    const pluginId = `private-${skill.id}`;
    entries.push({
      pluginId,
      pluginName: null,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      path: cachedSkillPath(cache, pluginId, skill.updatedAt.toISOString(), undefined, skill.name),
    });
  }
  return entries;
};

/** Catalog items in the agent_skills format used for managed and saved skills. */
export const renderPluginSkillCatalog = (entries: readonly PluginSkillEntry[]): string =>
  entries.flatMap((entry) => (entry.path ? [agentSkillItem(entry.path, entry.description)] : [])).join("\n\n");
