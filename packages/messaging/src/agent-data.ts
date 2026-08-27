import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, chmod, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { Prisma, type PrismaClient } from "@openbot/db";
import { parseDocument } from "yaml";
import {
  deleteAutomationFolder,
  parseAutomationFile,
  writeAutomationFiles,
} from "./automation-files";
import {
  atomicWrite,
  digest,
  jsonFile,
  listDirectories,
  listFiles,
  parseJsonObject,
  readBytes,
  readText,
  safeFolderId,
  slugify,
  uniqueSlug,
} from "./file-state";
import {
  appendMemoryFact,
  ensureDreamingLayout,
  forgetMemoryFact,
  markMemoryOrigin,
  memoryLogicalId,
  parseMemoryMarkdown,
  normalizeMemoryContent,
  readMemoryTree,
  tombstoneMemory,
} from "./memory-files";
import {
  deleteSkillFolder,
  MAX_INJECTED_SKILL_BODY,
  parseSkillFile,
  renderSkillFile,
  writeSkillFile,
} from "./skill-files";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"] as const;
const MAX_PENDING_DREAMING_AGENTS = 64;
const MAX_PENDING_DREAMING_EVIDENCE = 12;
const MAX_DREAMING_EVIDENCE_SIDE_CHARS = 8_000;
const AGENT_LOCK = "openbot-agent-data";
const ROOT_SETTINGS_VERSION = 1;
const MAX_FILE_WARNINGS = 20;
const MAX_FACT_ROWS = 20_000;

interface PendingDreamingEvidence {
  id: string;
  occurredAt: number;
  user: string;
  assistant: string;
}

const sniffAvatarExtension = (bytes: Uint8Array): (typeof AVATAR_EXTENSIONS)[number] | null => {
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return ".png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  const prefix = buffer.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return ".gif";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  const text = buffer.subarray(0, Math.min(buffer.length, 4_096)).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return ".svg";
  return null;
};

type Tx = Prisma.TransactionClient;

export interface ReconcileResult {
  warnings: string[];
}

export interface AgentPromptContext {
  profileSection: string;
  identityAnnouncement: string;
  memoryRender: string;
  skillRender: string;
  warnings: string[];
}

export interface RootSettings {
  version: 1;
  timezone: string;
  notificationsEnabled: boolean;
  pinnedAgentIds?: string[];
  sidebarSections: string[];
  theme: "system" | "light" | "dark";
  language: string;
  migrations: Record<string, boolean>;
  sidebarPreferences: {
    version: 2;
    pinnedIds: string[];
    unreadIds: string[];
    unassignedCollapsed: boolean;
    sections: Array<{ id: string; name: string; collapsed: boolean }>;
    sectionByChannel: Record<string, string>;
    channelOrderByGroup: Record<string, string[]>;
  };
}

const emptySidebarPreferences = (): RootSettings["sidebarPreferences"] => ({
  version: 2,
  pinnedIds: [],
  unreadIds: [],
  unassignedCollapsed: false,
  sections: [],
  sectionByChannel: {},
  channelOrderByGroup: {},
});

const asInputJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const boundedString = (value: unknown, maximum: number, fallback = ""): string =>
  typeof value === "string" ? value.slice(0, maximum) : fallback;

const profileDocument = (bot: {
  name: string;
  description: string;
  title: string;
  icon: string;
  color: string;
  namedBy: string;
}) => ({
  name: bot.name,
  description: bot.description,
  title: bot.title,
  avatarShape: bot.icon,
  avatarColor: bot.color,
  namedBy: bot.namedBy === "app" ? "app" : "user",
});

const settingsDocument = (bot: {
  notificationsEnabled: boolean;
  hiddenFromSidebar: boolean;
  dreamingEnabled: boolean;
}) => ({
  notifyOnAgentUpdates: bot.notificationsEnabled,
  hiddenFromSidebar: bot.hiddenFromSidebar,
  dreamingEnabled: bot.dreamingEnabled,
});

const profileValues = (value: Record<string, unknown>) => {
  const color = boundedString(value.avatarColor, 7, "#4f7cff");
  return {
    name: boundedString(value.name, 80),
    description: boundedString(value.description, 2_000),
    title: boundedString(value.title, 120),
    icon: boundedString(value.avatarShape, 16, "●") || "●",
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#4f7cff",
    namedBy: value.namedBy === "app" ? "app" : "user",
  };
};

const renderProjectDocument = (project: { name: string; description: string }): string =>
  [
    "---",
    `name: ${JSON.stringify(project.name)}`,
    `description: ${JSON.stringify(project.description)}`,
    "---",
    "",
  ].join("\n");

const parseProjectDocument = (text: string): { name: string; description: string } => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("project.md must start with YAML frontmatter");
  const document = parseDocument(match[1] ?? "", { prettyErrors: true });
  if (document.errors.length > 0) throw new Error(`project.md: ${document.errors[0]?.message}`);
  const raw = document.toJS() as unknown;
  if (!raw || Array.isArray(raw) || typeof raw !== "object")
    throw new Error("project.md frontmatter must be a mapping");
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim())
    throw new Error("project.md name must be a non-empty string");
  if (value.description !== undefined && typeof value.description !== "string")
    throw new Error("project.md description must be a string");
  return {
    name: value.name.trim().slice(0, 80),
    description: String(value.description ?? "")
      .trim()
      .slice(0, 2_000),
  };
};

const defaultRootSettings = (): RootSettings => ({
  version: 1,
  timezone: process.env.OPENBOT_TIME_ZONE ?? "UTC",
  notificationsEnabled: true,
  sidebarSections: [],
  theme: "system",
  language: "en",
  migrations: {},
  sidebarPreferences: emptySidebarPreferences(),
});

const parseSidebarPreferences = (input: unknown): RootSettings["sidebarPreferences"] => {
  const value =
    input === undefined
      ? emptySidebarPreferences()
      : parseJsonObject(JSON.stringify(input), "sidebarPreferences");
  if (value.version !== 2) throw new Error("sidebarPreferences.version must be 2");
  const arrays = ["pinnedIds", "unreadIds"] as const;
  for (const key of arrays) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error(`sidebarPreferences.${key} must be a string array`);
    }
  }
  if (!Array.isArray(value.sections))
    throw new Error("sidebarPreferences.sections must be an array");
  const sections = value.sections.map((entry) => {
    const section = parseJsonObject(JSON.stringify(entry), "sidebar section");
    if (
      typeof section.id !== "string" ||
      typeof section.name !== "string" ||
      typeof section.collapsed !== "boolean"
    ) {
      throw new Error("sidebar section requires string id/name and boolean collapsed");
    }
    return { id: section.id, name: section.name, collapsed: section.collapsed };
  });
  const sectionByChannel = parseJsonObject(
    JSON.stringify(value.sectionByChannel),
    "sectionByChannel"
  );
  if (Object.values(sectionByChannel).some((item) => typeof item !== "string")) {
    throw new Error("sectionByChannel values must be strings");
  }
  const channelOrderByGroup = parseJsonObject(
    JSON.stringify(value.channelOrderByGroup),
    "channelOrderByGroup"
  );
  if (
    Object.values(channelOrderByGroup).some(
      (item) => !Array.isArray(item) || item.some((id) => typeof id !== "string")
    )
  ) {
    throw new Error("channelOrderByGroup values must be string arrays");
  }
  return {
    version: 2,
    pinnedIds: [...new Set(value.pinnedIds as string[])],
    unreadIds: [...new Set(value.unreadIds as string[])],
    unassignedCollapsed: value.unassignedCollapsed === true,
    sections,
    sectionByChannel: sectionByChannel as Record<string, string>,
    channelOrderByGroup: channelOrderByGroup as Record<string, string[]>,
  };
};

const parseRootSettings = (value: Record<string, unknown>): RootSettings => {
  if (value.version !== ROOT_SETTINGS_VERSION) throw new Error("settings.json version must be 1");
  if (typeof value.timezone !== "string")
    throw new Error("settings.json timezone must be a string");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(new Date());
  } catch {
    throw new Error("settings.json timezone must be an IANA time zone");
  }
  if (typeof value.notificationsEnabled !== "boolean") {
    throw new Error("settings.json notificationsEnabled must be a boolean");
  }
  if (
    value.pinnedAgentIds !== undefined &&
    (!Array.isArray(value.pinnedAgentIds) ||
      value.pinnedAgentIds.some((id) => typeof id !== "string"))
  ) {
    throw new Error("settings.json pinnedAgentIds must be a string array");
  }
  if (
    !Array.isArray(value.sidebarSections) ||
    value.sidebarSections.some((item) => typeof item !== "string")
  ) {
    throw new Error("settings.json sidebarSections must be a string array");
  }
  if (!["system", "light", "dark"].includes(String(value.theme))) {
    throw new Error("settings.json theme is invalid");
  }
  if (typeof value.language !== "string")
    throw new Error("settings.json language must be a string");
  const migrations = parseJsonObject(JSON.stringify(value.migrations), "settings.json migrations");
  if (Object.values(migrations).some((item) => typeof item !== "boolean")) {
    throw new Error("settings.json migrations must contain booleans");
  }
  return {
    version: 1,
    timezone: value.timezone,
    notificationsEnabled: value.notificationsEnabled,
    ...(value.pinnedAgentIds
      ? { pinnedAgentIds: [...new Set(value.pinnedAgentIds as string[])] }
      : {}),
    sidebarSections: [...new Set(value.sidebarSections as string[])],
    theme: value.theme as RootSettings["theme"],
    language: value.language,
    migrations: migrations as Record<string, boolean>,
    sidebarPreferences: parseSidebarPreferences(value.sidebarPreferences),
  };
};

const sourceNamespace = (
  botId: string,
  scope: "agent" | "user" | "project",
  projectSlug?: string
): string =>
  scope === "agent"
    ? `agent:${botId}`
    : scope === "user"
      ? `user:agent:${botId}`
      : `project:${projectSlug}:agent:${botId}`;

const scoreFact = (fact: { importance: number; createdAt: Date; sourceOrdinal: number }): number =>
  Math.log2(Math.max(fact.importance, 0.01)) +
  fact.createdAt.getTime() / (30 * 24 * 60 * 60 * 1_000) +
  fact.sourceOrdinal / 1_000_000;

const selectFacts = <
  T extends {
    logicalId: string;
    fact: string;
    importance: number;
    createdAt: Date;
    sourceOrdinal: number;
  },
>(
  facts: T[],
  maximum: number,
  characterBudget: number
): { selected: T[]; omitted: number } => {
  const unique = new Map<string, T>();
  for (const fact of facts) {
    const current = unique.get(fact.logicalId);
    if (!current || scoreFact(fact) > scoreFact(current)) unique.set(fact.logicalId, fact);
  }
  const ranked = [...unique.values()].sort((a, b) => scoreFact(b) - scoreFact(a));
  const selected: T[] = [];
  let remaining = characterBudget;
  for (const fact of ranked) {
    const lineLength = fact.fact.length + 32;
    if (selected.length >= maximum || lineLength > remaining) continue;
    selected.push(fact);
    remaining -= lineLength;
  }
  selected.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sourceOrdinal - b.sourceOrdinal
  );
  return { selected, omitted: ranked.length - selected.length };
};

const renderFacts = (
  heading: string,
  facts: Array<{ fact: string; createdAt: Date }>,
  omitted: number
): string =>
  facts.length === 0
    ? ""
    : [
        `### ${heading}`,
        ...facts.map((fact) => `- (${fact.createdAt.toISOString().slice(0, 10)}) ${fact.fact}`),
        ...(omitted > 0 ? [`- [${omitted} additional facts omitted by the prompt budget]`] : []),
      ].join("\n");

const mergeWriterShards = <
  T extends {
    logicalId: string;
    fact: string;
    tier: string;
    importance: number;
    createdAt: Date;
    sourceOrdinal: number;
    writtenByBotId: string | null;
  },
>(
  facts: T[],
  recentPerWriter: number
): T[] => {
  const byWriter = new Map<string, T[]>();
  for (const fact of facts) {
    const writer = fact.writtenByBotId ?? "";
    const entries = byWriter.get(writer) ?? [];
    entries.push(fact);
    byWriter.set(writer, entries);
  }
  const limited: Array<{ writer: string; fact: T }> = [];
  for (const writer of [...byWriter.keys()].sort()) {
    const entries = byWriter.get(writer) ?? [];
    const profile = selectFacts(
      entries.filter((fact) => fact.tier === "profile"),
      100,
      Number.MAX_SAFE_INTEGER
    ).selected;
    const recent = selectFacts(
      entries.filter((fact) => fact.tier !== "profile"),
      recentPerWriter,
      Number.MAX_SAFE_INTEGER
    ).selected;
    limited.push(...[...profile, ...recent].map((fact) => ({ writer, fact })));
  }
  const merged = new Map<string, { writer: string; fact: T }>();
  for (const candidate of limited) {
    const current = merged.get(candidate.fact.logicalId);
    if (!current || candidate.fact.createdAt > current.fact.createdAt) {
      merged.set(candidate.fact.logicalId, candidate);
    }
  }
  return [...merged.values()].map((entry) => entry.fact);
};

export class AgentDataStore {
  readonly root: string;
  readonly workspaceRoot: string;
  private watcher: FSWatcher | null = null;
  private readonly pendingDreamingEvidence = new Map<string, PendingDreamingEvidence[]>();
  private readonly watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watcherTasks = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    options: { root?: string; workspaceRoot?: string } = {}
  ) {
    this.root = resolve(
      options.root ?? process.env.OPENBOT_AGENT_DATA_ROOT ?? "/home/openbot/agent-data"
    );
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? process.env.OPENBOT_WORKSPACE_ROOT ?? "/workspace"
    );
  }

  botDirectory(botId: string): string {
    return join(this.root, "agents", safeFolderId(botId, "bot id"));
  }

  async deleteAgentFiles(botId: string): Promise<void> {
    safeFolderId(botId, "bot id");
    const timer = this.watcherTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.watcherTimers.delete(botId);
    this.pendingDreamingEvidence.delete(botId);
    await rm(this.botDirectory(botId), { recursive: true, force: true });
    await this.prisma.agentFileState.deleteMany({ where: { botId } });
  }

  memoryDirectory(
    botId: string,
    scope: "agent" | "user" | "project",
    projectSlug?: string
  ): string {
    safeFolderId(botId, "bot id");
    if (scope === "agent") return join(this.botDirectory(botId), "memory");
    if (scope === "user") return join(this.root, "user-memory", "by-agent", botId);
    return join(
      this.root,
      "projects",
      safeFolderId(projectSlug ?? "", "project slug"),
      "memory",
      "by-agent",
      botId
    );
  }

  async projectBot(botId: string): Promise<void> {
    await this.initializeBot(botId);
  }

  async initializeBot(botId: string): Promise<void> {
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: { subagentIdentity: { select: { id: true } } },
    });
    if (!bot || bot.status === "archived" || bot.subagentIdentity) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    const directory = this.botDirectory(botId);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    if ((await readText(join(directory, "profile.json"))) === null) {
      await atomicWrite(join(directory, "profile.json"), jsonFile(profileDocument(bot)));
    }
    if ((await readText(join(directory, "settings.json"))) === null) {
      await atomicWrite(join(directory, "settings.json"), jsonFile(settingsDocument(bot)));
    }
    if (bot.instructions && (await readText(join(directory, "instructions.md"))) === null) {
      await atomicWrite(join(directory, "instructions.md"), `${bot.instructions.trim()}\n`);
    }
    await this.migrateLegacyAvatar(botId, bot.avatarPath);
  }

  async writeBotFiles(
    botId: string,
    targets: Array<"profile" | "settings" | "instructions" | "avatar" | "projects"> = [
      "profile",
      "settings",
      "instructions",
      "avatar",
      "projects",
    ]
  ): Promise<void> {
    await this.initializeBot(botId);
    const bot = await this.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: {
        projectMemberships: { orderBy: { joinedAt: "asc" } },
        subagentIdentity: { select: { id: true } },
      },
    });
    if (bot.subagentIdentity) return;
    const directory = this.botDirectory(botId);
    if (targets.includes("profile")) {
      await atomicWrite(join(directory, "profile.json"), jsonFile(profileDocument(bot)));
    }
    if (targets.includes("settings")) {
      const path = join(directory, "settings.json");
      const current = await readText(path);
      let value: Record<string, unknown> = {};
      if (current !== null) {
        try {
          value = parseJsonObject(current, "settings.json");
        } catch {
          value = {};
        }
      }
      await atomicWrite(
        path,
        jsonFile({
          ...value,
          ...settingsDocument(bot),
        })
      );
    }
    if (targets.includes("instructions")) {
      const path = join(directory, "instructions.md");
      if (bot.instructions) await atomicWrite(path, `${bot.instructions.trim()}\n`);
      else await rm(path, { force: true });
    }
    if (targets.includes("avatar")) {
      const existing = await this.avatarFiles(botId);
      if (!bot.avatarPath) {
        await this.clearAvatarFiles(botId);
      } else if (existing.length === 0) {
        await this.installAvatarFromPath(botId, bot.avatarPath, true);
      }
      await rm(join(directory, "avatar.json"), { force: true });
    }
    if (targets.includes("projects")) {
      for (const membership of bot.projectMemberships)
        await this.writeProjectFile(membership.projectSlug);
      await atomicWrite(
        join(directory, "projects.json"),
        jsonFile({
          projects: bot.projectMemberships.map((membership) => membership.projectSlug),
        })
      );
    }
  }

  async writeProjectFile(projectSlug: string): Promise<void> {
    safeFolderId(projectSlug, "project slug");
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
      select: { name: true, description: true },
    });
    if (!project) return;
    await atomicWrite(
      join(this.root, "projects", projectSlug, "project.md"),
      renderProjectDocument(project)
    );
  }

  async setAvatarFromPath(
    botId: string,
    supplied: string | null
  ): Promise<{
    path: string | null;
    resolvedPath: string | null;
    bytes: number;
  }> {
    await this.initializeBot(botId);
    if (supplied === null) {
      await this.prisma.bot.update({
        where: { id: botId },
        data: { avatarPath: null },
      });
      await this.clearAvatarFiles(botId);
      await rm(join(this.botDirectory(botId), "avatar.json"), { force: true });
      return { path: null, resolvedPath: null, bytes: 0 };
    }
    return this.installAvatarFromPath(botId, supplied, false);
  }

  private async migrateBot(botId: string): Promise<void> {
    const marker = join(this.root, ".openbot", "file-native-v1", `${botId}.json`);
    if ((await readText(marker, 20_000)) !== null) return;
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: { projectMemberships: true },
    });
    if (!bot || bot.status === "archived") return;

    const migrated = { memoryFacts: 0, skills: 0, automations: 0 };
    const seedMemory = async (root: string, namespaces: string[]): Promise<void> => {
      if ((await readMemoryTree(root)).length > 0) return;
      const facts = await this.prisma.memoryFact.findMany({
        where: { namespace: { in: namespaces } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      for (const fact of facts) {
        const result = await appendMemoryFact(root, fact.fact, fact.tier, fact.createdAt);
        if (result.added) migrated.memoryFacts += 1;
      }
    };

    await seedMemory(this.memoryDirectory(botId, "agent"), [`agent:${botId}`]);
    await seedMemory(this.memoryDirectory(botId, "user"), ["user", `user:agent:${botId}`]);
    for (const membership of bot.projectMemberships) {
      await this.writeProjectFile(membership.projectSlug);
      await seedMemory(this.memoryDirectory(botId, "project", membership.projectSlug), [
        `project:${membership.projectSlug}:agent:${botId}`,
      ]);
    }
    const projectsPath = join(this.botDirectory(botId), "projects.json");
    if (bot.projectMemberships.length > 0 && (await readText(projectsPath, 100_000)) === null) {
      await atomicWrite(
        projectsPath,
        jsonFile({
          projects: bot.projectMemberships.map((membership) => membership.projectSlug),
        })
      );
    }

    const legacyNotes = join(this.botDirectory(botId), "memory", "notes.md");
    const legacyNoteText = await readText(legacyNotes, 2_000_000);
    if (legacyNoteText !== null) {
      for (const fact of parseMemoryMarkdown(legacyNoteText)) {
        const result = await appendMemoryFact(
          this.memoryDirectory(botId, "agent"),
          fact.content.startsWith("[note] ") ? fact.content : `[note] ${fact.content}`,
          "note",
          fact.createdAt
        );
        if (result.added) migrated.memoryFacts += 1;
      }
    }

    const skillRoot = join(this.botDirectory(botId), "skills");
    const skillFolders = new Set(await listDirectories(skillRoot));
    const skills = await this.prisma.savedSkill.findMany({
      where: { botId },
      orderBy: { createdAt: "asc" },
    });
    for (const skill of skills) {
      const sourceSlug = skillFolders.has(skill.slug)
        ? skill.slug
        : skillFolders.has(skill.id)
          ? skill.id
          : null;
      const targetSlug =
        sourceSlug && sourceSlug !== skill.id
          ? sourceSlug
          : uniqueSlug(skill.name, "skill", skillFolders);
      if (sourceSlug && sourceSlug !== targetSlug) {
        await rename(join(skillRoot, sourceSlug), join(skillRoot, targetSlug));
        skillFolders.delete(sourceSlug);
      } else if (!sourceSlug) {
        await writeSkillFile(this.botDirectory(botId), {
          slug: targetSlug,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          frontmatter:
            skill.frontmatter &&
            typeof skill.frontmatter === "object" &&
            !Array.isArray(skill.frontmatter)
              ? (skill.frontmatter as Record<string, unknown>)
              : undefined,
        });
      }
      skillFolders.add(targetSlug);
      if (skill.slug !== targetSlug) {
        await this.prisma.savedSkill.update({
          where: { id: skill.id },
          data: { slug: targetSlug },
        });
      }
      migrated.skills += 1;
    }

    const automationRoot = join(this.botDirectory(botId), "automations");
    const automationFolders = new Set(await listDirectories(automationRoot));
    const routines = await this.prisma.routine.findMany({
      where: { botId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    for (const routine of routines) {
      const sourceSlug = automationFolders.has(routine.slug)
        ? routine.slug
        : automationFolders.has(routine.id)
          ? routine.id
          : null;
      const targetSlug =
        sourceSlug && sourceSlug !== routine.id
          ? sourceSlug
          : uniqueSlug(routine.name, "automation", automationFolders);
      if (sourceSlug && sourceSlug !== targetSlug) {
        await rename(join(automationRoot, sourceSlug), join(automationRoot, targetSlug));
        automationFolders.delete(sourceSlug);
      } else if (!sourceSlug) {
        await writeAutomationFiles(this.botDirectory(botId), {
          ...routine,
          slug: targetSlug,
          runLedger: routine.runLedger,
        });
      }
      automationFolders.add(targetSlug);
      if (routine.slug !== targetSlug) {
        await this.prisma.routine.update({
          where: { id: routine.id },
          data: { slug: targetSlug },
        });
      }
      migrated.automations += 1;
    }

    const legacyManifest = join(this.botDirectory(botId), ".openbot-projection.json");
    if ((await readText(legacyManifest, 2_000_000)) !== null) {
      await rename(
        legacyManifest,
        join(this.botDirectory(botId), ".openbot-projection.legacy.json")
      ).catch(() => undefined);
    }
    await atomicWrite(
      marker,
      jsonFile({
        version: 1,
        botId,
        migratedAt: new Date().toISOString(),
        ...migrated,
      }),
      0o600
    );
  }

  async reconcileBot(botId: string): Promise<ReconcileResult> {
    safeFolderId(botId, "bot id");
    const active = await this.prisma.bot.findFirst({
      where: { id: botId, status: { not: "archived" } },
      select: { id: true, subagentIdentity: { select: { id: true } } },
    });
    if (!active || active.subagentIdentity) return { warnings: [] };
    await this.initializeBot(botId);
    await this.migrateBot(botId);
    const warnings: string[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${AGENT_LOCK}:${botId}`}))`;
        const bot = await tx.bot.findUnique({
          where: { id: botId },
          include: { projectMemberships: true },
        });
        if (!bot || bot.status === "archived") return;
        await this.reconcileProfile(tx, botId, warnings);
        await this.reconcileSettings(tx, botId, warnings);
        await this.reconcileInstructions(tx, botId, warnings);
        await this.reconcileAvatar(tx, botId, warnings);
        await this.reconcileProjects(tx, botId, warnings);
        await this.reconcileMemory(tx, botId, "agent", undefined, warnings);
        await this.reconcileMemory(tx, botId, "user", undefined, warnings);
        const memberships = await tx.projectMember.findMany({
          where: { botId },
          orderBy: { joinedAt: "asc" },
        });
        for (const membership of memberships) {
          await this.reconcileMemory(tx, botId, "project", membership.projectSlug, warnings);
        }
        await this.reconcileSkills(tx, botId, warnings);
        await this.reconcileAutomations(tx, botId, warnings);
        await this.reconcileGroups(tx, botId, warnings);
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
    await Promise.all(
      ["memory/log", "skills", "automations"].map((child) =>
        mkdir(join(this.botDirectory(botId), child), {
          recursive: true,
          mode: 0o755,
        })
      )
    );
    return { warnings: warnings.slice(0, MAX_FILE_WARNINGS) };
  }

  async reconcileAllActiveBots(): Promise<ReconcileResult> {
    // Subagents are durable runtime actors, not user-manageable agents. Repair
    // legacy rows defensively and keep their visibility independent of files.
    await this.prisma.bot.updateMany({
      where: {
        subagentIdentity: { isNot: null },
        OR: [{ hiddenFromSidebar: false }, { notificationsEnabled: true }],
      },
      data: { hiddenFromSidebar: true, notificationsEnabled: false },
    });
    const bots = await this.prisma.bot.findMany({
      where: { status: "active", subagentIdentity: { is: null } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const warnings: string[] = [];
    for (const bot of bots) warnings.push(...(await this.reconcileBot(bot.id)).warnings);
    return { warnings: warnings.slice(0, 100) };
  }

  async startWatching(): Promise<void> {
    if (this.watcher) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const normalized = String(filename).split(sep).join("/");
        const botId =
          normalized.match(/^agents\/([^/]+)\//)?.[1] ??
          normalized.match(/^user-memory\/by-agent\/([^/]+)\//)?.[1] ??
          normalized.match(/^projects\/[^/]+\/memory\/by-agent\/([^/]+)\//)?.[1];
        if (!botId || normalized.includes("/.openbot") || normalized.endsWith(".part")) return;
        const previous = this.watcherTimers.get(botId);
        if (previous) clearTimeout(previous);
        this.watcherTimers.set(
          botId,
          setTimeout(() => {
            this.watcherTimers.delete(botId);
            const task = this.reconcileWatchedFolder(botId, normalized).catch((error) =>
              console.warn("agent-data watcher", error)
            );
            this.watcherTasks.add(task);
            void task.then(() => this.watcherTasks.delete(task));
          }, 50)
        );
      });
      this.watcher.on("error", (error) => console.warn("agent-data watcher", error));
    } catch (error) {
      console.warn("agent-data recursive watch unavailable; turn-start scans remain active", error);
    }
  }

  private async reconcileWatchedFolder(folderId: string, normalizedPath: string): Promise<void> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: folderId, status: { not: "archived" } },
      select: { id: true, subagentIdentity: { select: { id: true } } },
    });
    let affectedBotIds: string[];
    if (bot?.subagentIdentity) {
      return;
    }
    if (bot) {
      await this.reconcileBot(bot.id);
      affectedBotIds = [bot.id];
    } else {
      const group = await this.prisma.channel.findFirst({
        where: { id: folderId, kind: "group", archivedAt: null },
        select: {
          members: { orderBy: { ordinal: "asc" }, select: { botId: true } },
        },
      });
      const owner = group?.members[0]?.botId;
      if (!owner) return;
      await this.reconcileBot(owner);
      affectedBotIds = group.members.map((member) => member.botId);
    }
    await this.prisma.event.create({
      data: {
        topic: "bot.state.filesystem_changed",
        entityId: folderId,
        payload: { botIds: affectedBotIds, path: normalizedPath },
      },
    });
  }

  async stopWatching(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    this.watcherTimers.clear();
    this.pendingDreamingEvidence.clear();
    await Promise.allSettled([...this.watcherTasks]);
  }

  private async trackFile(
    tx: Tx,
    botId: string | null,
    kind: string,
    path: string,
    text: string | Uint8Array | null,
    error: string | null = null
  ): Promise<void> {
    const currentDigest = text === null ? null : digest(text);
    await tx.agentFileState.upsert({
      where: { path },
      create: {
        path,
        botId,
        kind,
        digest: currentDigest,
        validDigest: error ? null : currentDigest,
        exists: text !== null,
        error,
      },
      update: {
        digest: currentDigest,
        ...(error ? {} : { validDigest: currentDigest }),
        exists: text !== null,
        error,
        lastSeenAt: new Date(),
        generation: { increment: 1 },
      },
    });
  }

  private async reconcileProfile(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = join(this.botDirectory(botId), "profile.json");
    let text = await readText(path);
    let value: Record<string, unknown>;
    try {
      if (text === null) throw new Error("missing");
      value = parseJsonObject(text, "profile.json");
    } catch (error) {
      const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
      text = jsonFile(profileDocument(bot));
      await atomicWrite(path, text);
      value = profileDocument(bot);
      if ((error as Error).message !== "missing") {
        warnings.push("profile.json was unparseable and was regenerated");
      }
    }
    const parsed = profileValues(value);
    await tx.bot.update({ where: { id: botId }, data: parsed });
    await tx.channel.updateMany({
      where: { directKey: `bot:${botId}`, name: { not: parsed.name } },
      data: { name: parsed.name },
    });
    await this.trackFile(tx, botId, "profile", path, text);
  }

  private async reconcileSettings(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = join(this.botDirectory(botId), "settings.json");
    let text = await readText(path);
    if (text === null) {
      text = jsonFile({ notifyOnAgentUpdates: true });
      await atomicWrite(path, text);
    }
    try {
      const value = parseJsonObject(text, "settings.json");
      await tx.bot.update({
        where: { id: botId },
        data: {
          notificationsEnabled:
            typeof value.notifyOnAgentUpdates === "boolean" ? value.notifyOnAgentUpdates : true,
          hiddenFromSidebar:
            typeof value.hiddenFromSidebar === "boolean" ? value.hiddenFromSidebar : false,
          dreamingEnabled:
            typeof value.dreamingEnabled === "boolean" ? value.dreamingEnabled : false,
        },
      });
      await this.trackFile(tx, botId, "settings", path, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(message);
      await tx.bot.update({
        where: { id: botId },
        data: {
          notificationsEnabled: true,
          hiddenFromSidebar: false,
          dreamingEnabled: false,
        },
      });
      await this.trackFile(tx, botId, "settings", path, text, message);
    }
  }

  private async reconcileInstructions(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = join(this.botDirectory(botId), "instructions.md");
    try {
      const text = await readText(path, 200_000);
      await tx.bot.update({
        where: { id: botId },
        data: { instructions: text?.trim() ?? "" },
      });
      await this.trackFile(tx, botId, "instructions", path, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`instructions.md: ${message}`);
      await this.trackFile(tx, botId, "instructions", path, null, message);
    }
  }

  private async reconcileAvatar(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = (await this.avatarFiles(botId))[0] ?? null;
    if (path === null) {
      await tx.bot.update({ where: { id: botId }, data: { avatarPath: null } });
      return;
    }
    try {
      const { bytes, canonical } = await this.readStoredAvatar(botId, path);
      await tx.bot.update({ where: { id: botId }, data: { avatarPath: canonical } });
      await this.trackFile(tx, botId, "avatar", path, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${path}: ${message}`);
      await tx.bot.update({ where: { id: botId }, data: { avatarPath: null } });
      await this.trackFile(tx, botId, "avatar", path, null, message);
    }
  }

  private async avatarFiles(botId: string): Promise<string[]> {
    const directory = this.botDirectory(botId);
    const rank = new Map(AVATAR_EXTENSIONS.map((extension, index) => [extension, index]));
    return (await listFiles(directory))
      .filter((name) => /^avatar\.(?:png|jpg|jpeg|webp|gif|svg)$/i.test(name))
      .sort(
        (left, right) =>
          (rank.get(extname(left).toLowerCase() as (typeof AVATAR_EXTENSIONS)[number]) ?? 999) -
            (rank.get(extname(right).toLowerCase() as (typeof AVATAR_EXTENSIONS)[number]) ?? 999) ||
          left.localeCompare(right)
      )
      .map((name) => join(directory, name));
  }

  private async clearAvatarFiles(botId: string): Promise<void> {
    await Promise.all((await this.avatarFiles(botId)).map((path) => rm(path, { force: true })));
  }

  private async readStoredAvatar(
    botId: string,
    path: string
  ): Promise<{ bytes: Uint8Array; canonical: string; extension: string }> {
    const directory = await realpath(this.botDirectory(botId)).catch(() =>
      this.botDirectory(botId)
    );
    const canonical = await realpath(path).catch(() => null);
    if (!canonical || !this.isInside(canonical, directory)) {
      throw new Error("avatar path must stay inside the agent directory");
    }
    const bytes = await readBytes(canonical, MAX_AVATAR_BYTES);
    const extension = bytes ? sniffAvatarExtension(bytes) : null;
    if (!bytes || !extension) {
      throw new Error("avatar must be a supported non-empty image no larger than 5 MB");
    }
    return { bytes, canonical, extension };
  }

  private async installAvatarFromPath(
    botId: string,
    supplied: string,
    allowLegacyWorkspacePath: boolean
  ): Promise<{ path: string; resolvedPath: string; bytes: number }> {
    const directory = this.botDirectory(botId);
    const canonical = await realpath(supplied).catch(() => null);
    const agentDirectory = await realpath(directory).catch(() => directory);
    const workspace = await realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
    if (
      !canonical ||
      (!this.isInside(canonical, agentDirectory) &&
        !(allowLegacyWorkspacePath && this.isInside(canonical, workspace)))
    ) {
      throw new Error(`avatar source must stay inside ${directory}`);
    }
    const bytes = await readBytes(canonical, MAX_AVATAR_BYTES);
    const extension = bytes ? sniffAvatarExtension(bytes) : null;
    if (!bytes || !extension) {
      throw new Error("avatar must be a supported non-empty image no larger than 5 MB");
    }
    await this.clearAvatarFiles(botId);
    const destination = join(directory, `avatar${extension}`);
    await atomicWrite(destination, bytes);
    const resolvedPath = await realpath(destination);
    await rm(join(directory, "avatar.json"), { force: true });
    await this.prisma.bot.update({ where: { id: botId }, data: { avatarPath: resolvedPath } });
    return { path: supplied, resolvedPath, bytes: bytes.length };
  }

  private async migrateLegacyAvatar(botId: string, databasePath: string | null): Promise<void> {
    const directory = this.botDirectory(botId);
    if ((await this.avatarFiles(botId)).length > 0) {
      await rm(join(directory, "avatar.json"), { force: true });
      return;
    }
    let supplied = databasePath;
    const pointerPath = join(directory, "avatar.json");
    const pointer = await readText(pointerPath).catch(() => null);
    if (!supplied && pointer) {
      try {
        const value = parseJsonObject(pointer, "avatar.json");
        supplied = typeof value.path === "string" ? value.path : null;
      } catch {
        supplied = null;
      }
    }
    if (supplied) {
      await this.installAvatarFromPath(botId, supplied, true).catch(async () => {
        await this.prisma.bot.update({ where: { id: botId }, data: { avatarPath: null } });
      });
    }
    await rm(pointerPath, { force: true });
  }

  private async reconcileProjects(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = join(this.botDirectory(botId), "projects.json");
    let text = await readText(path);
    if (text === null) {
      await tx.projectMember.deleteMany({ where: { botId } });
      await this.trackFile(tx, botId, "projects", path, null);
      return;
    }
    try {
      const value = parseJsonObject(text, "projects.json");
      if (
        !Array.isArray(value.projects) ||
        value.projects.some((slug) => typeof slug !== "string")
      ) {
        throw new Error("projects.json projects must be a string array");
      }
      const slugs = [...new Set(value.projects as string[])].map((slug) =>
        safeFolderId(slug, "project slug")
      );
      const projectDirectories = new Set(await listDirectories(join(this.root, "projects")));
      const projects = await tx.project.findMany({
        where: {
          slug: {
            in: slugs.filter((slug) => projectDirectories.has(slug)),
          },
        },
        select: { slug: true },
      });
      const valid = new Set(projects.map((project) => project.slug));
      const missing = slugs.filter((slug) => !valid.has(slug));
      const joinedSlugs = slugs.filter((slug) => valid.has(slug));
      if (missing.length > 0) {
        warnings.push(`projects.json pruned missing projects: ${missing.join(", ")}`);
        text = jsonFile({ projects: joinedSlugs });
        await atomicWrite(path, text);
      }
      for (const project of projects) {
        const metadataPath = join(this.root, "projects", project.slug, "project.md");
        const metadata = await readText(metadataPath, 100_000);
        if (metadata === null) continue;
        try {
          await tx.project.update({
            where: { slug: project.slug },
            data: parseProjectDocument(metadata),
          });
        } catch (error) {
          warnings.push(
            `projects/${project.slug}/project.md: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      await tx.projectMember.deleteMany({
        where: { botId, projectSlug: { notIn: joinedSlugs } },
      });
      for (const projectSlug of joinedSlugs) {
        await tx.projectMember.upsert({
          where: { projectSlug_botId: { projectSlug, botId } },
          create: { projectSlug, botId },
          update: {},
        });
      }
      await this.trackFile(tx, botId, "projects", path, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`projects.json: ${message}`);
      await this.trackFile(tx, botId, "projects", path, text, message);
    }
  }

  private async reconcileMemory(
    tx: Tx,
    botId: string,
    scope: "agent" | "user" | "project",
    projectSlug: string | undefined,
    warnings: string[]
  ): Promise<void> {
    const root = this.memoryDirectory(botId, scope, projectSlug);
    const namespace = sourceNamespace(botId, scope, projectSlug);
    try {
      const facts = (await readMemoryTree(root)).slice(0, MAX_FACT_ROWS);
      await tx.memoryFact.deleteMany({ where: { namespace } });
      if (facts.length > 0) {
        await tx.memoryFact.createMany({
          data: facts.map((fact) => ({
            namespace,
            scope,
            tier: fact.tier,
            projectSlug,
            fact: fact.content,
            factHash: createHash("sha256").update(fact.content).digest("hex"),
            logicalId: fact.logicalId,
            sourcePath: fact.sourcePath,
            sourceOrdinal: fact.sourceOrdinal,
            sourceLine: fact.sourceLine,
            importance: fact.importance,
            origin: "filesystem",
            writtenByBotId: botId,
            createdAt: fact.createdAt,
          })),
        });
      }
    } catch (error) {
      warnings.push(`${scope} memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reconcileSkills(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const root = join(this.botDirectory(botId), "skills");
    const slugs = await listDirectories(root);
    const seen = new Set<string>();
    for (const slug of slugs) {
      const path = join(root, slug, "SKILL.md");
      const text = await readText(path, 116_384);
      if (text === null) continue;
      try {
        const parsed = parseSkillFile(text, `skills/${slug}/SKILL.md`);
        seen.add(slug);
        await tx.savedSkill.upsert({
          where: { botId_slug: { botId, slug } },
          create: {
            botId,
            slug,
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            frontmatter: asInputJson(parsed.frontmatter),
          },
          update: {
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            frontmatter: asInputJson(parsed.frontmatter),
          },
        });
        await this.trackFile(tx, botId, "skill", path, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`skills/${slug}/SKILL.md: ${message}`);
        await this.trackFile(tx, botId, "skill", path, text, message);
      }
    }
    if (await this.directoryExists(root)) {
      await tx.savedSkill.deleteMany({
        where: { botId, slug: { notIn: [...seen] } },
      });
    }
  }

  private async reconcileAutomations(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const root = join(this.botDirectory(botId), "automations");
    const slugs = await listDirectories(root);
    const seen = new Set<string>();
    for (const slug of slugs) {
      const path = join(root, slug, "automation.json");
      const text = await readText(path, 250_000);
      if (text === null) continue;
      try {
        const parsed = await parseAutomationFile(
          path,
          text,
          process.env.OPENBOT_TIME_ZONE ?? "UTC"
        );
        seen.add(slug);
        const existing = await tx.routine.findUnique({
          where: { botId_slug: { botId, slug } },
        });
        const changed =
          !existing ||
          existing.name !== parsed.name ||
          existing.prompt !== parsed.prompt ||
          JSON.stringify(existing.trigger) !== JSON.stringify(parsed.trigger) ||
          existing.enabled !== parsed.enabled;
        const revision = existing ? existing.revision + Number(changed) : 1;
        const schedule = parsed.schedule ?? {
          scheduleText: JSON.stringify(parsed.trigger),
          scheduleKind: "event" as const,
          cronExpression: null,
          intervalSeconds: null,
          timezoneMode: "installation" as const,
          timezone: process.env.OPENBOT_TIME_ZONE ?? "UTC",
        };
        const common = {
          name: parsed.name,
          prompt: parsed.prompt,
          trigger: asInputJson(parsed.trigger),
          triggerPresentation: parsed.triggerPresentation
            ? asInputJson(parsed.triggerPresentation)
            : Prisma.JsonNull,
          provenance: parsed.provenance,
          ...schedule,
          enabled: parsed.enabled,
          revision,
          nextRunAt: parsed.nextRunAt,
          lastRunAt: parsed.lastRunAt,
          pausedAt: parsed.enabled ? null : new Date(),
          deletedAt: null,
          pendingNotices: parsed.pendingNotices,
          raisedNotices: parsed.raisedNotices,
          runLedger: asInputJson(parsed.runs),
          createdAt: parsed.createdAt,
        };
        const routine = existing
          ? await tx.routine.update({
              where: { id: existing.id },
              data: common,
            })
          : await tx.routine.create({ data: { botId, slug, ...common } });
        if (!existing || changed) {
          await tx.routineRevision.create({
            data: {
              routineId: routine.id,
              revision,
              name: parsed.name,
              prompt: parsed.prompt,
              ...schedule,
              enabled: parsed.enabled,
              source: "filesystem",
            },
          });
        }
        await this.trackFile(tx, botId, "automation", path, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`automations/${slug}/automation.json: ${message}`);
        await this.trackFile(tx, botId, "automation", path, text, message);
      }
    }
    if (await this.directoryExists(root)) {
      await tx.routine.updateMany({
        where: { botId, deletedAt: null, slug: { notIn: [...seen] } },
        data: { enabled: false, nextRunAt: null, deletedAt: new Date() },
      });
    }
  }

  private async reconcileGroups(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const groups = await tx.channel.findMany({
      where: { kind: "group", archivedAt: null, members: { some: { botId } } },
      include: {
        members: {
          orderBy: { ordinal: "asc" },
          include: { bot: { select: { name: true } } },
        },
      },
    });
    for (const group of groups) {
      const directory = join(this.root, "agents", safeFolderId(group.id, "group id"));
      const groupPath = join(directory, "group.json");
      let text = await readText(groupPath, 200_000);
      if (text === null) {
        text = jsonFile({
          version: 1,
          memberIds: group.members.map((member) => member.botId),
        });
        await atomicWrite(groupPath, text);
      } else {
        try {
          const value = parseJsonObject(text, "group.json");
          if (value.version !== undefined && value.version !== 1)
            throw new Error("group.json version must be 1");
          if (
            !Array.isArray(value.memberIds) ||
            value.memberIds.length < 1 ||
            value.memberIds.length > 6
          ) {
            throw new Error("group.json must contain 1-6 memberIds");
          }
          const memberIds = value.memberIds.map((entry) => {
            if (typeof entry !== "string") throw new Error("group member ID must be a string");
            return safeFolderId(entry.trim(), "group member id");
          });
          if (new Set(memberIds).size !== memberIds.length) {
            throw new Error("group.json member IDs must be unique");
          }
          const validMembers = await tx.bot.findMany({
            where: { id: { in: memberIds }, status: "active" },
            select: { id: true },
          });
          if (validMembers.length !== memberIds.length) {
            throw new Error("group.json contains an unknown or inactive member");
          }
          const profileText = await readText(join(directory, "profile.json"), 100_000);
          if (profileText === null) throw new Error("group profile.json is missing");
          const profile = profileValues(parseJsonObject(profileText, "group profile.json"));
          if (!profile.name) throw new Error("group profile.json name must be non-empty");
          await tx.channel.update({
            where: { id: group.id },
            data: { name: profile.name },
          });
          await tx.channelMember.deleteMany({ where: { channelId: group.id } });
          await tx.channelMember.createMany({
            data: memberIds.map((memberId, ordinal) => ({
              channelId: group.id,
              botId: memberId,
              ordinal,
            })),
          });
        } catch (error) {
          warnings.push(
            `groups/${group.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if ((await readText(join(directory, "profile.json"))) === null) {
        await atomicWrite(
          join(directory, "profile.json"),
          jsonFile({ name: group.name, description: "" })
        );
      }
      if ((await readText(join(directory, "settings.json"))) === null) {
        await atomicWrite(
          join(directory, "settings.json"),
          jsonFile({ notifyOnAgentUpdates: true })
        );
      }
    }
  }

  async writeMemory(
    botId: string,
    input: {
      scope: "agent" | "user" | "project";
      projectSlug?: string;
      tier: "profile" | "log" | "note";
      fact: string;
    }
  ): Promise<{ saved: boolean; logicalId: string; sourcePath: string }> {
    const root = this.memoryDirectory(botId, input.scope, input.projectSlug);
    await mkdir(root, { recursive: true, mode: 0o755 });
    const result = await appendMemoryFact(root, input.fact, input.tier);
    if (input.scope === "agent") {
      await markMemoryOrigin(root, result.logicalId, "explicit");
    }
    await this.reconcileBot(botId);
    return {
      saved: result.added,
      logicalId: result.logicalId,
      sourcePath: result.sourcePath,
    };
  }

  async forgetMemory(
    botId: string,
    input: {
      scope: "agent" | "user" | "project";
      projectSlug?: string;
      fact: string;
      dreaming?: boolean;
    }
  ): Promise<{ forgotten: boolean; logicalId: string }> {
    const root = this.memoryDirectory(botId, input.scope, input.projectSlug);
    const result = await forgetMemoryFact(root, normalizeMemoryContent(input.fact));
    if (result.forgotten && input.scope === "agent" && input.dreaming) {
      await tombstoneMemory(root, result.logicalId);
    }
    await this.reconcileBot(botId);
    return result;
  }

  async writeSkill(
    botId: string,
    input: {
      id?: string;
      name: string;
      description: string;
      body: string;
      frontmatter?: Record<string, unknown>;
    }
  ) {
    await this.reconcileBot(botId);
    const existing = input.id
      ? await this.prisma.savedSkill.findFirst({
          where: { botId, OR: [{ id: input.id }, { slug: input.id }] },
        })
      : null;
    const written = await writeSkillFile(this.botDirectory(botId), {
      slug: existing?.slug,
      name: input.name,
      description: input.description,
      body: input.body,
      frontmatter: {
        ...(input.frontmatter ?? {}),
        name: input.name,
        description: input.description,
      },
    });
    await this.reconcileBot(botId);
    return this.prisma.savedSkill.findUniqueOrThrow({
      where: { botId_slug: { botId, slug: written.slug } },
    });
  }

  async deleteSkill(botId: string, id: string): Promise<boolean> {
    await this.reconcileBot(botId);
    const skill = await this.prisma.savedSkill.findFirst({
      where: { botId, OR: [{ id }, { slug: id }] },
    });
    if (!skill) return false;
    await deleteSkillFolder(this.botDirectory(botId), skill.slug);
    await this.prisma.savedSkill.delete({ where: { id: skill.id } });
    return true;
  }

  async writeRoutine(botId: string, id: string): Promise<void> {
    const routine = await this.prisma.routine.findFirst({
      where: { id, botId, deletedAt: null },
    });
    if (!routine) return;
    await writeAutomationFiles(this.botDirectory(botId), {
      ...routine,
      slug: routine.slug,
      runLedger: routine.runLedger,
    });
  }

  async deleteRoutine(botId: string, id: string): Promise<void> {
    const routine = await this.prisma.routine.findFirst({
      where: { id, botId },
    });
    if (routine) await deleteAutomationFolder(this.botDirectory(botId), routine.slug);
  }

  async promptContext(botId: string): Promise<AgentPromptContext> {
    const reconciliation = await this.reconcileBot(botId);
    const bot = await this.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: {
        conversation: true,
        projectMemberships: { include: { project: true } },
      },
    });
    const epoch = bot.conversation?.compactionEpoch ?? 0;
    const liveProfile = [
      `You are ${bot.name}, a durable OpenBot agent.`,
      bot.title ? `Your title is: ${bot.title}` : "",
      bot.description ? `Your description is:\n${bot.description}` : "",
      bot.instructions ? `Bot-specific instructions:\n${bot.instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    let snapshot = await this.prisma.agentPromptSnapshot.findUnique({
      where: { botId },
    });
    let profileSection: string;
    let identityAnnouncement = "";
    if (!snapshot || snapshot.profileEpoch !== epoch) {
      snapshot = await this.prisma.agentPromptSnapshot.upsert({
        where: { botId },
        create: {
          botId,
          profileEpoch: epoch,
          profileSection: liveProfile,
          systemName: bot.name,
          systemDescription: bot.description,
          announcedName: bot.name,
          announcedDescription: bot.description,
        },
        update: {
          profileEpoch: epoch,
          profileSection: liveProfile,
          systemName: bot.name,
          systemDescription: bot.description,
          announcedName: bot.name,
          announcedDescription: bot.description,
        },
      });
      profileSection = liveProfile;
    } else {
      profileSection = snapshot.profileSection;
      if (
        snapshot.announcedName !== bot.name ||
        snapshot.announcedDescription !== bot.description
      ) {
        identityAnnouncement = `Identity update for this turn: your current name is ${bot.name}${
          bot.description ? ` and your current description is: ${bot.description}` : ""
        }. The frozen profile section refreshes after conversation compaction.`;
        snapshot = await this.prisma.agentPromptSnapshot.update({
          where: { botId },
          data: {
            announcedName: bot.name,
            announcedDescription: bot.description,
          },
        });
      }
    }

    const liveMemory = await this.renderMemory(
      botId,
      bot.projectMemberships.map((entry) => entry.projectSlug)
    );
    let memoryRender = liveMemory;
    if (liveMemory) {
      if (snapshot.memoryEpoch === epoch && snapshot.memoryHasFacts) {
        memoryRender = snapshot.memoryRender;
      } else {
        snapshot = await this.prisma.agentPromptSnapshot.update({
          where: { botId },
          data: {
            memoryEpoch: epoch,
            memoryRender: liveMemory,
            memoryHasFacts: true,
          },
        });
      }
    }

    const liveSkills = await this.renderSkills(botId);
    let skillRender = liveSkills;
    if (snapshot.skillEpoch === epoch) {
      skillRender = snapshot.skillRender;
    } else {
      await this.prisma.agentPromptSnapshot.update({
        where: { botId },
        data: { skillEpoch: epoch, skillRender: liveSkills },
      });
    }
    return {
      profileSection,
      identityAnnouncement,
      memoryRender,
      skillRender,
      warnings: reconciliation.warnings,
    };
  }

  private async renderMemory(botId: string, projectSlugs: string[]): Promise<string> {
    const all = await this.prisma.memoryFact.findMany({
      where: {
        OR: [
          { namespace: `agent:${botId}` },
          { namespace: { startsWith: "user:agent:" } },
          ...(projectSlugs.length > 0
            ? [{ projectSlug: { in: projectSlugs }, scope: "project" as const }]
            : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { sourceOrdinal: "asc" }],
    });
    if (all.length === 0) return "";
    const blocks: string[] = [];
    const user = mergeWriterShards(
      all.filter((fact) => fact.scope === "user"),
      15
    );
    const userProfile = selectFacts(
      user.filter((fact) => fact.tier === "profile"),
      50,
      4_000
    );
    const userRecent = selectFacts(
      user.filter((fact) => fact.tier !== "profile"),
      15,
      2_000
    );
    const renderedUser = [
      renderFacts("Global user profile memory", userProfile.selected, userProfile.omitted),
      renderFacts("Recent global user memory", userRecent.selected, userRecent.omitted),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (renderedUser) blocks.push(renderedUser);

    const projectNames = new Map(
      (
        await this.prisma.project.findMany({
          where: { slug: { in: projectSlugs } },
          select: { slug: true, name: true },
        })
      ).map((project) => [project.slug, project.name])
    );

    const projects = projectSlugs
      .map((slug) => ({
        slug,
        facts: mergeWriterShards(
          all.filter((fact) => fact.scope === "project" && fact.projectSlug === slug),
          10
        ),
      }))
      .sort(
        (a, b) =>
          Number(b.facts.length > 0) - Number(a.facts.length > 0) ||
          (b.facts[0]?.createdAt.getTime() ?? 0) - (a.facts[0]?.createdAt.getTime() ?? 0) ||
          a.slug.localeCompare(b.slug)
      )
      .slice(0, 3);
    for (const project of projects) {
      const profile = selectFacts(
        project.facts.filter((fact) => fact.tier === "profile"),
        25,
        2_500
      );
      const recent = selectFacts(
        project.facts.filter((fact) => fact.tier !== "profile"),
        10,
        1_500
      );
      const rendered = [
        renderFacts(
          `Project ${projectNames.get(project.slug) ?? project.slug} (${project.slug}) profile memory`,
          profile.selected,
          profile.omitted
        ),
        renderFacts(
          `Project ${projectNames.get(project.slug) ?? project.slug} (${project.slug}) recent memory`,
          recent.selected,
          recent.omitted
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
      if (rendered) blocks.push(rendered);
    }
    if (projectSlugs.length > projects.length) {
      const selected = new Set(projects.map((project) => project.slug));
      const also = projectSlugs
        .filter((slug) => !selected.has(slug))
        .map((slug) => `${projectNames.get(slug) ?? slug} (${slug})`);
      if (also.length > 0) blocks.push(`Also a member of: ${also.join(", ")}.`);
    }

    const own = all.filter((fact) => fact.namespace === `agent:${botId}`);
    const ownProfile = selectFacts(
      own.filter((fact) => fact.tier === "profile"),
      100,
      20_000
    );
    const ownRecent = selectFacts(
      own.filter((fact) => fact.tier !== "profile"),
      30,
      4_000
    );
    const renderedOwn = [
      renderFacts("Own profile memory", ownProfile.selected, ownProfile.omitted),
      renderFacts("Own recent memory", ownRecent.selected, ownRecent.omitted),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (renderedOwn) blocks.push(renderedOwn);
    return blocks.join("\n\n");
  }

  private async renderSkills(botId: string): Promise<string> {
    const skills = await this.prisma.savedSkill.findMany({
      where: { botId },
      orderBy: { updatedAt: "desc" },
    });
    let remaining = 32_000;
    const blocks: string[] = [];
    for (const skill of skills) {
      if (remaining <= 0) break;
      const body = skill.body.slice(0, Math.min(MAX_INJECTED_SKILL_BODY, remaining));
      remaining -= body.length;
      blocks.push(
        `### ${skill.name} (${skill.slug})\n${skill.description}\nPath: ${join(
          this.botDirectory(botId),
          "skills",
          skill.slug,
          "SKILL.md"
        )}\n${body}${body.length < skill.body.length ? "\n[body truncated]" : ""}`
      );
    }
    const omitted = skills.length - blocks.length;
    return `${blocks.join("\n\n")}${
      omitted > 0 ? `\n\n[${omitted} additional skills omitted by the catalog budget]` : ""
    }`.trim();
  }

  async loadRootSettings(): Promise<{
    settings: RootSettings;
    valid: boolean;
    error?: string;
  }> {
    const text = await readText(join(this.root, "settings.json"));
    if (text === null) return { settings: defaultRootSettings(), valid: false };
    try {
      return {
        settings: parseRootSettings(parseJsonObject(text, "settings.json")),
        valid: true,
      };
    } catch (error) {
      return {
        settings: defaultRootSettings(),
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async writeRootSettings(input: Partial<RootSettings>): Promise<RootSettings> {
    const current = await this.loadRootSettings();
    const next = parseRootSettings({
      ...current.settings,
      ...input,
      version: 1,
    });
    await atomicWrite(join(this.root, "settings.json"), jsonFile(next));
    return next;
  }

  async writeSidebarPreferences(input: unknown): Promise<RootSettings["sidebarPreferences"]> {
    const sidebarPreferences = parseSidebarPreferences(input);
    await this.writeRootSettings({ sidebarPreferences });
    return sidebarPreferences;
  }

  async loadActiveAgentId(): Promise<string | null> {
    const text = await readText(join(this.root, "agents", "active-agent.json"));
    if (text === null) return null;
    try {
      const value = parseJsonObject(text, "active-agent.json");
      return typeof value.activeAgentId === "string" ? value.activeAgentId : null;
    } catch {
      return null;
    }
  }

  async writeActiveAgentId(activeAgentId: string): Promise<void> {
    safeFolderId(activeAgentId, "active agent id");
    await atomicWrite(join(this.root, "agents", "active-agent.json"), jsonFile({ activeAgentId }));
  }

  async writeGroupFilesForBot(botId: string): Promise<void> {
    const groups = await this.prisma.channel.findMany({
      where: { kind: "group", archivedAt: null, members: { some: { botId } } },
      include: {
        members: {
          orderBy: { ordinal: "asc" },
          include: { bot: { select: { name: true } } },
        },
      },
    });
    for (const group of groups) {
      const directory = join(this.root, "agents", safeFolderId(group.id, "group id"));
      await atomicWrite(
        join(directory, "group.json"),
        jsonFile({
          version: 1,
          memberIds: group.members.map((member) => member.botId),
        })
      );
      if ((await readText(join(directory, "profile.json"))) === null) {
        await atomicWrite(
          join(directory, "profile.json"),
          jsonFile({ name: group.name, description: "" })
        );
      }
      if ((await readText(join(directory, "settings.json"))) === null) {
        await atomicWrite(
          join(directory, "settings.json"),
          jsonFile({ notifyOnAgentUpdates: true })
        );
      }
    }
  }

  async appendAudit(botId: string, entry: Record<string, unknown>): Promise<void> {
    try {
      const path = join(this.botDirectory(botId), "audit.jsonl");
      await mkdir(this.botDirectory(botId), { recursive: true });
      await appendFile(path, `${JSON.stringify({ ts: Date.now(), agentId: botId, ...entry })}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
    } catch {
      // Best effort: audit forwarding must not fail the requested action.
    }
  }

  async recordTurnMemory(
    botId: string,
    input: {
      user: string;
      assistant: string;
      hidden?: boolean;
      occurredAt?: number;
    }
  ): Promise<void> {
    if (input.hidden || !input.user.trim()) return;
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      select: { dreamingEnabled: true },
    });
    if (!bot) return;
    if (bot.dreamingEnabled) {
      if (
        !this.pendingDreamingEvidence.has(botId) &&
        this.pendingDreamingEvidence.size >= MAX_PENDING_DREAMING_AGENTS
      ) {
        const oldest = this.pendingDreamingEvidence.keys().next().value;
        if (typeof oldest === "string") this.pendingDreamingEvidence.delete(oldest);
      }
      const evidence: PendingDreamingEvidence = {
        id: randomUUID(),
        occurredAt: input.occurredAt ?? Date.now(),
        user: input.user.slice(0, MAX_DREAMING_EVIDENCE_SIDE_CHARS),
        assistant: input.assistant.slice(0, MAX_DREAMING_EVIDENCE_SIDE_CHARS),
      };
      const current = this.pendingDreamingEvidence.get(botId) ?? [];
      this.pendingDreamingEvidence.set(
        botId,
        [...current, evidence].slice(-MAX_PENDING_DREAMING_EVIDENCE)
      );
      await this.prisma.bot.update({
        where: { id: botId },
        data: { episodePending: 0 },
      });
      return;
    }
    const pending = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`episode:${botId}`}))`;
      const current = await tx.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { episodePending: true },
      });
      const next = current.episodePending + 1;
      await tx.bot.update({
        where: { id: botId },
        data: { episodePending: next >= 6 ? 0 : next },
      });
      return next;
    });
    if (pending < 6) return;
    const user = normalizeMemoryContent(input.user).slice(0, 220);
    const assistant = normalizeMemoryContent(input.assistant).slice(0, 220);
    if (!assistant) return;
    await this.writeMemory(botId, {
      scope: "agent",
      tier: "log",
      fact: `[episode] User: ${user} Assistant: ${assistant}`,
    });
  }

  async materializeAttachments(
    botId: string,
    messageId: string,
    images: ReadonlyArray<{ url: string; alt?: string }>
  ): Promise<string[]> {
    if (images.length === 0) return [];
    const directory = join(this.botDirectory(botId), "attachments");
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      const match = image.url.match(/^data:image\/(gif|jpeg|png|webp);base64,(.+)$/i);
      if (!match?.[1] || !match[2]) continue;
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES * 4) continue;
      const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
      const label =
        (image.alt ?? "image")
          .normalize("NFKD")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64) || "image";
      const stem = messageId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
      const path = join(directory, `${stem}-${index + 1}-${label}.${extension}`);
      await atomicWrite(path, bytes, 0o644);
      paths.push(path);
    }
    return paths;
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private isInside(path: string, root: string): boolean {
    const difference = relative(resolve(root), resolve(path));
    return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`));
  }
}

export { renderSkillFile, ensureDreamingLayout, memoryLogicalId, slugify };
