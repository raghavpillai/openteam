import {
  MEMORY_HEADING,
  MEMORY_PROFILE_PROMPT_LIMIT,
  MEMORY_RECENT_PROMPT_LIMIT,
  MEMORY_USER_PROFILE_PROMPT_LIMIT,
  MEMORY_USER_RECENT_PROMPT_LIMIT,
  SHARED_USER_MEMORY_HEADING,
  renderMemoryFactSnapshot,
  renderMemorySystemPolicyPrompt,
  renderOtherAssistantMemoryUpdate,
  renderUserMemoryFactSnapshot,
  renderUserMemorySystemPolicyPrompt,
  type PromptMemoryRecord,
} from "./memory-rendering";
import managedSkills from "./prompts/managed-skills.json";
import { managedSkillAgents, managedSkillIsForMain } from "./managed-skill-agents";
import { safePackagePath } from "@openteam/plugin-sdk";
import { originalSkillMarkdown } from "@openteam/plugin-sdk/skill-markdown";
import { pluginSkillsForAgent, renderPluginSkillCatalog, type PluginSkillCache } from "./plugin-skill-catalog";
import { agentSkillItem, omittedSkillsNotice, renderAgentSkillsSection } from "./skill-catalog";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { defaultTaskConfiguration, parseTaskConfiguration, type TaskConfiguration } from "@openteam/contracts/task-configuration";
import {
  appendFile,
  chmod,
  mkdir,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  ApiError,
  BOT_MEMORY_LIST_LIMIT,
  type BotMemoryEntry,
  type BotMemoryList,
  parseBotRecipe,
  defaultServerInferenceSettings,
  serverInferenceSettings,
  type AssetRef,
  type ServerInferenceSettings,
} from "@openteam/contracts";
import {
  emptySidebarPreferences,
  parseSidebarPreferences,
  type SidebarPreferences,
} from "@openteam/contracts/client-preferences";
import type { ComputerInferenceRequest } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import { type FSWatcher, watch } from "chokidar";
import { snapshotWatchedFiles } from "./file-watch-snapshot";
import {
  deleteAutomationFolder,
  parseAutomationFile,
  writeAutomationFiles,
} from "./automation-files";
import { triggerIdentity } from "./automation-trigger";
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
  memoryImportance,
  memoryLogicalId,
  memoryTier,
  normalizeMemoryContent,
  type MemoryProvenance,
} from "./memory-facts";
import { deleteSkillFolder, parseSkillFile, renderSkillFile, writeSkillFile } from "./skill-files";
import type { AgentTimelineEvent } from "./timeline-events";
import {
  acknowledgeMemoryContext,
  acknowledgePromptSections,
  parsePromptSections,
  prepareMemoryContext,
  preparePromptSections,
  type MemoryContextLive,
  type MemoryContextReceipt,
  type PromptSectionReceipt,
} from "./prompt-sections";
import { parseRecallInput, recallMemoryResult } from "./recall-memory";
import {
  buildExtractionUserPrompt,
  gatherExtractionMemories,
  holdMemoryExchange,
  isMemorableExchange,
  parseExtractedMemories,
  parseHeldMemoryExchanges,
  renderTurnMemoryDate,
  type HeldMemoryExchange,
  type MemoryExchange,
} from "./memory-learning";
import { resolveTimeZone } from "./timestamps";
import { MEMORY_EXTRACTION_SYSTEM_PROMPT } from "./memory-prompts";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE_REFUSAL = "the image must be under 5 MB and non-empty.";
const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"] as const;
const MEMORY_INFERENCE_DEADLINE_MS = 90_000;
const MAX_HELD_MEMORY_EXCHANGES = 5;
const AGENT_LOCK = "openteam-agent-data";
const ROOT_SETTINGS_VERSION = 1;
const MAX_FILE_WARNINGS = 20;
const MAX_SAVED_SKILLS = 100;
const MAX_MATERIALIZED_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const ATTACHMENT_COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_AGENT_ATTACHMENT_PATH_CACHE_ENTRIES = 1_024;
const UUID_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQLITE_RUNTIME_FILE = /(?:^|\/)(?:store|conversation-blobs)\.db(?:-(?:wal|shm|journal))?$/;
const BOX_STORE_RUNTIME_FILE = /(?:^|\/)\.box-store-/;

const privateRuntimePath = (path: string): boolean => {
  const normalized = path.split(sep).join("/");
  return SQLITE_RUNTIME_FILE.test(normalized) || BOX_STORE_RUNTIME_FILE.test(normalized);
};

const writeAttachmentChunk = async (handle: FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Attachment staging file could not be written");
    offset += bytesWritten;
  }
};

const stageAttachmentCopy = async (input: {
  source: string;
  temporary: string;
  expectedAssetId: string;
  expectedByteSize: number;
}): Promise<boolean> => {
  let handle: FileHandle | null = await open(input.temporary, "wx", 0o644);
  let complete = false;
  let writeFailure: unknown = null;
  try {
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const chunk of createReadStream(input.source, {
        highWaterMark: ATTACHMENT_COPY_CHUNK_BYTES,
      })) {
        byteSize += chunk.byteLength;
        if (byteSize > input.expectedByteSize || byteSize > MAX_MATERIALIZED_ATTACHMENT_BYTES) {
          return false;
        }
        hash.update(chunk);
        try {
          await writeAttachmentChunk(handle, chunk);
        } catch (error) {
          writeFailure = error;
          throw error;
        }
      }
    } catch {
      if (writeFailure) throw writeFailure;
      return false;
    }
    if (
      byteSize !== input.expectedByteSize ||
      hash.digest("hex") !== input.expectedAssetId
    ) {
      return false;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    complete = true;
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!complete) await rm(input.temporary, { force: true }).catch(() => undefined);
  }
};

const writeEditableBotFile = async (path: string, content: string): Promise<void> => {
  // Set the mode on the unpublished descriptor, avoiding both umask drift and
  // a post-rename chmod that could follow a concurrently substituted symlink.
  await atomicWrite(path, content, 0o664, { exactMode: true });
};

const ensureEditableBotDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o775 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error("Bot directory must not be a symlink");
  const mode = info.mode & 0o7777;
  if ((mode & 0o070) !== 0o070) await chmod(directory, mode | 0o070);
};

export type BotFileTarget = "profile" | "settings" | "instructions" | "avatar";

export type MemoryInferenceRequest = Omit<ComputerInferenceRequest, "model" | "reasoning"> & {
  signal?: AbortSignal;
};

export type MemoryInference = (request: MemoryInferenceRequest) => Promise<string>;

interface AgentDataStoreOptions {
  root?: string;
  workspaceRoot?: string;
  assetRoot?: string;
  memoryInference?: MemoryInference;
}

export interface PendingIdentityAnnouncement {
  epoch: number;
  profileSection: string;
  systemName: string;
  systemDescription: string;
  announcedName: string;
  announcedDescription: string;
  previousName: string;
  previousDescription: string;
}

const profileUpdateXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const renderAgentProfileUpdate = (name: string, description: string): string => {
  const identity = { name, description };
  const marker = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
  return [
    `[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:${marker}>>`,
    "<agent_profile_update>",
    "Your agent profile changed. This update supersedes older identity details in this conversation.",
    `Current name: ${profileUpdateXmlText(name)}`,
    `Current description: ${description ? profileUpdateXmlText(description) : "(no description)"}`,
    "Keep using this identity until a later conversation summary folds it into the profile section.",
    "</agent_profile_update>",
  ].join("\n");
};

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

export interface AutomationReconcileBatchResult extends ReconcileResult {
  /** The last processed bot ID, or null when the current safety-sweep cycle is complete. */
  nextCursor: string | null;
  reconciled: number;
}

export interface AgentPromptContext {
  compactionEpoch: number;
  profileSection: string;
  profileSnapshot: {
    version: 1;
    profileSection: string;
    systemIdentity: { name: string; description: string };
    announcedIdentity: { name: string; description: string };
    compactionEpoch: number;
  };
  identityAnnouncement: string;
  identityReceipt?: PendingIdentityAnnouncement;
  /** The memory sections for the system prompt, and the facts and peer changes for <memory_context>. */
  memory: LiveMemory;
  skillRender: string;
  warnings: string[];
}

export interface LiveMemory extends MemoryContextLive {
  policy: string;
}

export interface RootSidebarSection {
  id: string;
  name: string;
  agentIds: string[];
  isCollapsed: boolean;
}

interface AccountScopedRootSettings {
  mcpCustomInstructions?: string;
  mcpCustomInstructionsByServerId?: Record<string, string>;
  agentDefaultModel?: string;
  computerUseModel?: string;
}

export interface RootSettings extends AccountScopedRootSettings {
  version: 1;
  inference: ServerInferenceSettings;
  mcpBoxServers: string[];
  hasSeenOnboarding?: boolean;
  hasSeenOnboardingAccountScope?: string;
  selectedTeam?: { teamId: number; accountScope: string };
  autoUpdateWhenIdleOptIn: boolean;
  updateTrackOverride?: "stable" | "nightly" | "dogfood";
  themePreference?: "system" | "light" | "dark" | string;
  languagePreference?: string;
  egressTunnelEnabled: boolean;
  webauthnProxyEnabled: boolean;
  hardwareAccelerationEnabled?: boolean;
  notifications?: {
    isEnabled?: boolean;
    allowedApps?: string[];
    minIntervalMs?: number;
    maxPerWindow?: number;
    windowMs?: number;
  };
  desktopNotificationPreferences?: { playSound?: boolean; sound?: string };
  userTimeZone?: string;
  userTimeZoneOverride?: string;
  conciergeConsent: "unset" | "allowed" | "denied";
  settingsMigrations: string[];
  pinnedAgentIds?: string[];
  sidebarSections?: RootSidebarSection[];
  accountScopes: Record<string, AccountScopedRootSettings>;
  activeAccountScope?: string;
}

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

const settingsDocument = (bot: { notificationsEnabled: boolean; hiddenFromSidebar: boolean }) => ({
  notifyOnAgentUpdates: bot.notificationsEnabled,
  hiddenFromSidebar: bot.hiddenFromSidebar,
});

const profileValues = (input: unknown) => {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    // Duplication appends to the full name; reconciliation must not cut off its suffix.
    name: typeof value.name === "string" ? value.name.trim() : "",
    description: boundedString(value.description, 2_000),
    title: typeof value.title === "string" ? value.title.trim() : "",
    icon: boundedString(value.avatarShape, 16),
    color: boundedString(value.avatarColor, 80),
    namedBy: value.namedBy === "app" ? "app" : "user",
  };
};

const ROOT_SETTINGS_MIGRATIONS = ["downgrade-max-fast"];
const AGENTS_SECTION_ID = "__agents__";

const defaultRootSettings = (): RootSettings => ({
  version: 1,
  inference: defaultServerInferenceSettings(),
  mcpBoxServers: [],
  mcpCustomInstructions: "",
  mcpCustomInstructionsByServerId: {},
  autoUpdateWhenIdleOptIn: false,
  egressTunnelEnabled: false,
  webauthnProxyEnabled: true,
  conciergeConsent: "unset",
  settingsMigrations: [...ROOT_SETTINGS_MIGRATIONS],
  accountScopes: {},
});

const uniqueStrings = (input: unknown, label: string, allowEmpty = false): string[] => {
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  const values = input as string[];
  if (!allowEmpty && values.some((item) => item.length === 0)) {
    throw new Error(`${label} must not contain empty strings`);
  }
  return [...new Set(values)];
};

const stringRecord = (input: unknown, label: string): Record<string, string> => {
  const value = parseJsonObject(JSON.stringify(input), label);
  if (Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${label} values must be strings`);
  }
  return value as Record<string, string>;
};

const stringArrayRecord = (input: unknown, label: string): Record<string, string[]> => {
  const value = parseJsonObject(JSON.stringify(input), label);
  const parsed: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value))
    parsed[key] = uniqueStrings(item, `${label}.${key}`);
  return parsed;
};

const parseAccountScopedSettings = (input: unknown, label: string): AccountScopedRootSettings => {
  const value = parseJsonObject(JSON.stringify(input), label);
  const parsed: AccountScopedRootSettings = {};
  if (value.mcpCustomInstructions !== undefined) {
    if (typeof value.mcpCustomInstructions !== "string")
      throw new Error(`${label}.mcpCustomInstructions must be a string`);
    parsed.mcpCustomInstructions = value.mcpCustomInstructions;
  }
  if (value.mcpCustomInstructionsByServerId !== undefined) {
    parsed.mcpCustomInstructionsByServerId = stringRecord(
      value.mcpCustomInstructionsByServerId,
      `${label}.mcpCustomInstructionsByServerId`
    );
  }
  for (const key of ["agentDefaultModel", "computerUseModel"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw new Error(`${label}.${key} must be a string`);
      parsed[key] = value[key];
    }
  }
  return parsed;
};

const normalizeSidebarSections = (input: unknown): RootSidebarSection[] => {
  if (!Array.isArray(input)) throw new Error("settings.json sidebarSections must be an array");
  const claimedAgents = new Set<string>();
  const sectionIds = new Set<string>();
  const sections: RootSidebarSection[] = [];
  for (const item of input) {
    const value = parseJsonObject(JSON.stringify(item), "settings.json sidebar section");
    if (
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.name !== "string" ||
      typeof value.isCollapsed !== "boolean"
    ) {
      throw new Error("settings.json sidebar section is malformed");
    }
    const agentIds = uniqueStrings(value.agentIds, "settings.json sidebar section agentIds");
    if (value.id === AGENTS_SECTION_ID || sectionIds.has(value.id)) continue;
    sectionIds.add(value.id);
    sections.push({
      id: value.id,
      name: value.name,
      agentIds: agentIds.filter((agentId) => {
        if (claimedAgents.has(agentId)) return false;
        claimedAgents.add(agentId);
        return true;
      }),
      isCollapsed: value.isCollapsed,
    });
  }
  if (sections.length > 0) {
    sections.push({ id: AGENTS_SECTION_ID, name: "Unassigned", agentIds: [], isCollapsed: false });
  }
  return sections;
};

const parseRootSettings = (value: Record<string, unknown>): RootSettings => {
  if (value.version !== ROOT_SETTINGS_VERSION) throw new Error("settings.json version must be 1");
  const requiredBooleans = [
    "autoUpdateWhenIdleOptIn",
    "egressTunnelEnabled",
    "webauthnProxyEnabled",
  ] as const;
  for (const key of requiredBooleans) {
    if (typeof value[key] !== "boolean") throw new Error(`settings.json ${key} must be boolean`);
  }
  if (!(["unset", "allowed", "denied"] as unknown[]).includes(value.conciergeConsent)) {
    throw new Error("settings.json conciergeConsent is invalid");
  }
  const accountScopesRaw = parseJsonObject(
    JSON.stringify(value.accountScopes),
    "settings.json accountScopes"
  );
  const accountScopes = Object.fromEntries(
    Object.entries(accountScopesRaw).map(([key, scoped]) => [
      key,
      parseAccountScopedSettings(scoped, `settings.json accountScopes.${key}`),
    ])
  );
  if (value.inference === undefined) throw new Error("settings.json inference is required");
  const inference = parseJsonObject(JSON.stringify(value.inference), "settings.json inference");
  if (typeof inference.providerId !== "string" || typeof inference.modelId !== "string") {
    throw new Error("settings.json inference providerId and modelId must be strings");
  }
  const parsed: RootSettings = {
    version: 1,
    inference: inference.modelId === ""
      ? defaultServerInferenceSettings(inference.providerId, inference.reasoning)
      : serverInferenceSettings(inference.providerId, inference.modelId, inference.reasoning),
    mcpBoxServers: uniqueStrings(value.mcpBoxServers, "settings.json mcpBoxServers", true),
    autoUpdateWhenIdleOptIn: value.autoUpdateWhenIdleOptIn as boolean,
    egressTunnelEnabled: value.egressTunnelEnabled as boolean,
    webauthnProxyEnabled: value.webauthnProxyEnabled as boolean,
    conciergeConsent: value.conciergeConsent as RootSettings["conciergeConsent"],
    settingsMigrations: uniqueStrings(
      value.settingsMigrations,
      "settings.json settingsMigrations",
      true
    ),
    accountScopes,
    ...parseAccountScopedSettings(value, "settings.json"),
  };
  const optionalStrings = [
    "hasSeenOnboardingAccountScope",
    "themePreference",
    "languagePreference",
    "userTimeZone",
    "userTimeZoneOverride",
    "activeAccountScope",
  ] as const;
  for (const key of optionalStrings) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") throw new Error(`settings.json ${key} must be a string`);
    parsed[key] = value[key];
  }
  for (const key of ["hasSeenOnboarding", "hardwareAccelerationEnabled"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") throw new Error(`settings.json ${key} must be boolean`);
    parsed[key] = value[key];
  }
  if (value.updateTrackOverride !== undefined) {
    if (!(["stable", "nightly", "dogfood"] as unknown[]).includes(value.updateTrackOverride)) {
      throw new Error("settings.json updateTrackOverride is invalid");
    }
    parsed.updateTrackOverride = value.updateTrackOverride as RootSettings["updateTrackOverride"];
  }
  if (value.selectedTeam !== undefined) {
    const team = parseJsonObject(JSON.stringify(value.selectedTeam), "settings.json selectedTeam");
    if (!Number.isInteger(team.teamId) || typeof team.accountScope !== "string") {
      throw new Error("settings.json selectedTeam is malformed");
    }
    parsed.selectedTeam = { teamId: team.teamId as number, accountScope: team.accountScope };
  }
  if (value.notifications !== undefined) {
    const notifications = parseJsonObject(
      JSON.stringify(value.notifications),
      "settings.json notifications"
    );
    const result: NonNullable<RootSettings["notifications"]> = {};
    if (notifications.isEnabled !== undefined) {
      if (typeof notifications.isEnabled !== "boolean")
        throw new Error("settings.json notifications.isEnabled must be boolean");
      result.isEnabled = notifications.isEnabled;
    }
    if (notifications.allowedApps !== undefined) {
      result.allowedApps = uniqueStrings(
        notifications.allowedApps,
        "settings.json notifications.allowedApps"
      );
    }
    for (const key of ["minIntervalMs", "maxPerWindow", "windowMs"] as const) {
      if (notifications[key] === undefined) continue;
      if (typeof notifications[key] !== "number" || !Number.isFinite(notifications[key])) {
        throw new Error(`settings.json notifications.${key} must be a number`);
      }
      result[key] = notifications[key];
    }
    parsed.notifications = result;
  }
  if (value.desktopNotificationPreferences !== undefined) {
    const preferences = parseJsonObject(
      JSON.stringify(value.desktopNotificationPreferences),
      "settings.json desktopNotificationPreferences"
    );
    const result: NonNullable<RootSettings["desktopNotificationPreferences"]> = {};
    if (preferences.playSound !== undefined) {
      if (typeof preferences.playSound !== "boolean")
        throw new Error("settings.json desktopNotificationPreferences.playSound must be boolean");
      result.playSound = preferences.playSound;
    }
    if (preferences.sound !== undefined) {
      if (typeof preferences.sound !== "string")
        throw new Error("settings.json desktopNotificationPreferences.sound must be a string");
      result.sound = preferences.sound;
    }
    parsed.desktopNotificationPreferences = result;
  }
  if (value.pinnedAgentIds !== undefined) {
    parsed.pinnedAgentIds = uniqueStrings(value.pinnedAgentIds, "settings.json pinnedAgentIds");
  }
  if (value.sidebarSections !== undefined) {
    parsed.sidebarSections = normalizeSidebarSections(value.sidebarSections);
  }
  return parsed;
};

type MemoryScope = "agent" | "user";

/** A bot's own facts, or its shard of the shared user memory. */
const memoryNamespace = (botId: string, scope: MemoryScope): string =>
  scope === "agent" ? `agent:${botId}` : `user:agent:${botId}`;

const lockMemoryNamespace = (tx: Tx, namespace: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memory:${namespace}`}))`;

const scoreFact = (fact: { importance: number; createdAt: Date; sourceOrdinal: number }): number =>
  Math.log2(Math.max(fact.importance, 0.01)) +
  fact.createdAt.getTime() / (30 * 24 * 60 * 60 * 1_000);

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
  characterBudget: number,
  options: { sourceOrder?: boolean; rankByImportance?: boolean } = {}
): { selected: T[]; omitted: number } => {
  const { sourceOrder = false, rankByImportance = false } = options;
  const unique = new Map<string, T>();
  for (const fact of facts) {
    const current = unique.get(normalizeMemoryContent(fact.fact).toLowerCase());
    if (
      !current ||
      fact.createdAt > current.createdAt ||
      (sourceOrder &&
        fact.createdAt.getTime() === current.createdAt.getTime() &&
        fact.sourceOrdinal > current.sourceOrdinal)
    ) {
      unique.set(normalizeMemoryContent(fact.fact).toLowerCase(), fact);
    }
  }
  const ranked = [...unique.values()].sort(
    (a, b) =>
      (rankByImportance
        ? scoreFact(b) - scoreFact(a)
        : b.createdAt.getTime() - a.createdAt.getTime()) ||
      (sourceOrder ? b.sourceOrdinal - a.sourceOrdinal : (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0))
  );
  const selected: T[] = [];
  let remaining = characterBudget;
  for (const fact of ranked) {
    const lineLength = fact.fact.length + 32;
    if (selected.length >= maximum || (selected.length > 0 && lineLength > remaining)) continue;
    selected.push(fact);
    remaining -= lineLength;
  }
  return { selected, omitted: ranked.length - selected.length };
};

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
      Number.MAX_SAFE_INTEGER,
      { sourceOrder: true }
    ).selected;
    const recent = selectFacts(
      entries.filter((fact) => fact.tier !== "profile"),
      recentPerWriter,
      Number.MAX_SAFE_INTEGER,
      { sourceOrder: true, rankByImportance: true }
    ).selected;
    limited.push(...[...profile, ...recent].map((fact) => ({ writer, fact })));
  }
  const merged = new Map<string, { writer: string; fact: T }>();
  for (const candidate of limited) {
    const current = merged.get(normalizeMemoryContent(candidate.fact.fact).toLowerCase());
    if (!current || candidate.fact.createdAt > current.fact.createdAt) {
      merged.set(normalizeMemoryContent(candidate.fact.fact).toLowerCase(), candidate);
    }
  }
  return [...merged.values()].map((entry) => entry.fact);
};

export class AgentDataStore {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly assetRoot: string;
  private watcher: FSWatcher | null = null;
  private watcherStarting: Promise<void> | null = null;
  private watcherScanTimer: ReturnType<typeof setInterval> | null = null;
  private watcherScan: Promise<void> | null = null;
  private readonly pendingIdentityAnnouncements = new Map<string, PendingIdentityAnnouncement>();
  private readonly watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watcherTasks = new Set<Promise<void>>();
  private readonly agentAttachmentPaths = new Map<string, string>();
  private readonly agentAttachmentPathLookups = new Map<string, Promise<string | null>>();
  private readonly memoryInference: MemoryInference | null;
  /** Held exchanges whose review is running in this process; the rest were left by one that stopped. */
  private readonly memoryExchangesInReview = new Set<string>();
  private timelineEventSink:
    | ((
        tx: Tx,
        input: {
          botId: string;
          clientId: string;
          event: AgentTimelineEvent;
          occurredAt?: Date;
        }
      ) => Promise<unknown>)
    | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    options: AgentDataStoreOptions = {}
  ) {
    this.root = resolve(
      options.root ?? process.env.OPENTEAM_AGENT_DATA_ROOT ?? "/home/box/agent-data"
    );
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? process.env.OPENTEAM_WORKSPACE_ROOT ?? "/workspace"
    );
    this.assetRoot = resolve(
      options.assetRoot ??
        process.env.OPENTEAM_ASSET_ROOT ??
        join(resolve(this.root, ".."), ".openteam-assets")
    );
    this.memoryInference = options.memoryInference ?? null;
  }

  setTimelineEventSink(
    sink: (
      tx: Tx,
      input: {
        botId: string;
        clientId: string;
        event: AgentTimelineEvent;
        occurredAt?: Date;
      }
    ) => Promise<unknown>
  ): void {
    this.timelineEventSink = sink;
  }

  private async withFileMutation<T>(
    botId: string,
    key: string,
    action: (tx: Tx) => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-file:${key}`}))`;
      return action(tx);
    }, timeoutMs ? { maxWait: 10_000, timeout: timeoutMs } : undefined);
  }

  private async withRootFileMutation<T>(key: string, action: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`root-file:${key}`}))`;
      return action(tx);
    });
  }

  botDirectory(botId: string): string {
    return join(this.root, "agents", safeFolderId(botId, "bot id"));
  }

  workflowsDirectory(): string {
    return join(this.root, "workflows");
  }

  managedSkillsDirectory(): string {
    return join(this.root, "managed-skills");
  }

  pluginSkillsDirectory(): string {
    return join(this.root, "plugin-skills");
  }

  pluginsDirectory(): string {
    return join(this.root, "plugins");
  }

  connectorSecretsDirectory(): string {
    return join(this.root, "connector-secrets");
  }

  async writeConnectorSecret(
    botId: string,
    platform: string,
    field: string,
    value: string
  ): Promise<void> {
    const safeBotId = safeFolderId(botId, "bot id");
    const safePlatform = safeFolderId(platform, "connector platform");
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field)) {
      throw new Error("Connector credential field is invalid");
    }
    const directory = join(this.connectorSecretsDirectory(), safeBotId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${safePlatform}.json`);
    const current = parseJsonObject((await readText(path)) ?? "{}", path);
    await atomicWrite(path, jsonFile({ ...current, [field]: value }), 0o600);
  }

  private async ensureSharedRoot(): Promise<void> {
    // Agent tools use a different UID in the shared group. They need traversal
    // to catalogued skills/profiles; private children keep their own modes.
    await mkdir(this.root, { recursive: true, mode: 0o710 });
    const mode = (await stat(this.root)).mode & 0o7777;
    if (!(mode & 0o010)) await chmod(this.root, mode | 0o010);
  }

  async ensureRuntimeDirectories(): Promise<void> {
    await this.ensureSharedRoot();
    const rootSettingsPath = join(this.root, "settings.json");
    if ((await readText(rootSettingsPath)) === null) {
      await atomicWrite(rootSettingsPath, jsonFile(defaultRootSettings()), 0o600);
    }
    await chmod(rootSettingsPath, 0o600);
    await Promise.all(
      [
        this.workflowsDirectory(),
        this.managedSkillsDirectory(),
        this.pluginSkillsDirectory(),
        this.pluginsDirectory(),
        this.connectorSecretsDirectory(),
      ].map((directory) => mkdir(directory, { recursive: true, mode: 0o755 }))
    );
    await chmod(this.connectorSecretsDirectory(), 0o700);
    await this.syncManagedSkills();
  }

  private async syncManagedSkills(): Promise<void> {
    const directory = this.managedSkillsDirectory();
    const enabled = process.env.OPENTEAM_MANAGED_SKILLS !== "false";
    const activeIds = new Set(enabled ? managedSkills.skills.map((skill) => skill.id) : []);
    // This directory is owned by the managed catalog. Retire removed workflows
    // before checking the cache, including when its metadata is missing or stale.
    for (const id of await listDirectories(directory)) {
      if (!activeIds.has(id)) await rm(join(directory, id), { recursive: true, force: true });
    }
    if (!enabled) {
      await atomicWrite(join(this.managedSkillsDirectory(), "cache.json"), jsonFile({ version: "disabled", skills: [] }), 0o444);
      return;
    }
    const cachePath = join(this.managedSkillsDirectory(), "cache.json");
    const current = await readText(cachePath);
    if (current) {
      try {
        if (JSON.parse(current).version === managedSkills.version && (await Promise.all(managedSkills.skills.map(async (skill) => (await readText(join(this.managedSkillsDirectory(), skill.id, "SKILL.md"))) === skill.content))).every(Boolean)) return;
      } catch { /* Repair an invalid or incomplete managed cache. */ }
    }
    const records = [];
    for (const skill of managedSkills.skills) {
      const filePath = join(this.managedSkillsDirectory(), skill.id, "SKILL.md");
      await mkdir(dirname(filePath), { recursive: true, mode: 0o755 });
      await atomicWrite(filePath, skill.content, 0o444);
      const parsed = parseSkillFile(skill.content, filePath);
      const agents = managedSkillAgents(skill);
      records.push({ id: skill.id, name: parsed.name, description: parsed.description, filePath, ...(agents ? { agents } : {}) });
    }
    await atomicWrite(cachePath, jsonFile({ version: managedSkills.version, fetchedAt: Date.now(), skills: records }), 0o444);
  }

  async syncPluginSkillCache(
    plugins: readonly {
      id: string;
      name: string;
      version?: string | null;
      publisher?: string | null;
      skills: readonly { name: string; description: string; body: string; path?: string }[];
      files?: Record<string, string>;
      binaryFiles?: Record<string, string>;
    }[],
    currentUserId = "openteam"
  ): Promise<void> {
    await this.ensureRuntimeDirectories();
    const fetchedAt = Date.now();
    const managedCachePath = join(this.managedSkillsDirectory(), "cache.json");
    if ((await readText(managedCachePath)) === null) {
      await atomicWrite(managedCachePath, jsonFile({ fetchedAt, skills: [] }), 0o600);
    }

    const records: Array<Record<string, unknown>> = [];
    const packages: Array<Record<string, unknown>> = [];
    for (const plugin of plugins) {
      const pluginId = slugify(plugin.id, "plugin");
      const revision = digest(
        JSON.stringify({ version: plugin.version ?? "0", skills: plugin.skills, files: plugin.files, binaryFiles: plugin.binaryFiles })
      ).slice(0, 16);
      const installPath = join(
        this.pluginsDirectory(),
        "cache",
        slugify(plugin.publisher || "openteam", "publisher"),
        pluginId,
        revision
      );
      packages.push({ pluginId: plugin.id, pluginVersion: plugin.version, installPath, revision });
      for (const [path, content] of Object.entries(plugin.files ?? {})) {
        await atomicWrite(join(installPath, safePackagePath(path)), content, content.startsWith("#!") ? 0o555 : 0o444);
      }
      for (const [path, content] of Object.entries(plugin.binaryFiles ?? {})) {
        await atomicWrite(join(installPath, safePackagePath(path)), Buffer.from(content, "base64"));
      }
      for (const skill of plugin.skills) {
        const id = slugify(`${pluginId}-${skill.name}`, "skill");
        const skillRelativePath = join(skill.path ? safePackagePath(skill.path) : join("skills", id), "SKILL.md");
        const filePath = join(installPath, skillRelativePath);
        await atomicWrite(
          filePath,
          originalSkillMarkdown(skill, plugin.files?.[skillRelativePath]) ?? renderSkillFile({
            name: skill.name,
            description: skill.description,
            body: skill.body,
          })
        );
        records.push({
          id,
          pluginId,
          pluginName: plugin.name,
          name: skill.name,
          description: skill.description,
          filePath,
          pluginVersion: plugin.version ?? undefined,
          installPath,
          skillRelativePath,
        });
      }
    }
    await atomicWrite(
      join(this.pluginSkillsDirectory(), "cache.json"),
      jsonFile({ fetchedAt, currentUserId, skills: records, packages, authBlocked: [] }),
      0o644 // Non-secret skill index must be readable by the unprivileged Bot process.
    );
  }

  async deleteAgentFiles(botId: string): Promise<void> {
    safeFolderId(botId, "bot id");
    const timer = this.watcherTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.watcherTimers.delete(botId);
    for (const key of this.pendingIdentityAnnouncements.keys()) {
      if (key.startsWith(`${botId}:`)) this.pendingIdentityAnnouncements.delete(key);
    }
    await this.withFileMutation(botId, "lifecycle", async (tx) => {
      await rm(this.botDirectory(botId), { recursive: true, force: true });
      await tx.agentFileState.deleteMany({ where: { botId } });
    });
  }

  /** A group room is a shared conversation: it neither reads nor writes the owner's shared user memory. */
  async isSharedConversation(botId: string, channelId?: string | null): Promise<boolean> {
    if (!channelId) return false;
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, members: { some: { botId } } },
      select: { kind: true },
    });
    if (!channel) throw new ApiError(403, "memory_context_unavailable", "Bot is not a member of this conversation");
    return channel.kind === "group";
  }

  async projectBot(botId: string): Promise<void> {
    await this.initializeBot(botId);
  }

  /** Copy only durable configuration into a newly created bot, never its working data. */
  async copyBotConfigurationFiles(tx: Tx, sourceId: string, targetId: string): Promise<void> {
    safeFolderId(sourceId, "source bot id");
    safeFolderId(targetId, "target bot id");
    if (sourceId === targetId) throw new Error("A duplicate must have a new bot id");
    const source = await tx.bot.findUniqueOrThrow({ where: { id: sourceId } });
    const target = await tx.bot.findUniqueOrThrow({ where: { id: targetId } });
    const directory = this.botDirectory(targetId);
    await ensureEditableBotDirectory(directory);
    await writeEditableBotFile(join(directory, "profile.json"), jsonFile(profileDocument(target)));
    const settingsText = await readText(join(this.botDirectory(sourceId), "settings.json"));
    let settings: Record<string, unknown> = {};
    try {
      if (settingsText) settings = parseJsonObject(settingsText, "settings.json");
    } catch {
      // Reconciliation already applied the host's defaults for invalid settings.
      // Keep the original file intact and give the copy a valid settings document.
    }
    await writeEditableBotFile(
      join(directory, "settings.json"),
      jsonFile({ ...settings, ...settingsDocument(target), hiddenFromSidebar: false })
    );
    if (source.avatarPath) {
      const avatar = await this.readStoredAvatar(sourceId, source.avatarPath);
      const path = join(directory, `avatar${avatar.extension}`);
      await atomicWrite(path, avatar.bytes);
      await tx.bot.update({ where: { id: targetId }, data: { avatarPath: path } });
    }
    // Saved skills and workspace files are already shared. Do not recursively copy
    // the source directory: it also contains memory, attachments, and transcripts.
    const routines = await tx.routine.findMany({ where: { botId: targetId, deletedAt: null } });
    for (const routine of routines) {
      await writeAutomationFiles(directory, { ...routine, runLedger: [] });
    }
  }

  async initializeBot(botId: string): Promise<void> {
    await this.withFileMutation(botId, "initialize", async (tx) => {
      const bot = await tx.bot.findUnique({
        where: { id: botId },
        include: { subagentIdentity: { select: { id: true } } },
      });
      if (!bot || bot.status === "archived" || bot.subagentIdentity) return;
      await this.ensureSharedRoot();
      const directory = this.botDirectory(botId);
      await ensureEditableBotDirectory(directory);
      if ((await readText(join(directory, "profile.json"))) === null) {
        await writeEditableBotFile(join(directory, "profile.json"), jsonFile(profileDocument(bot)));
      }
      if ((await readText(join(directory, "settings.json"))) === null) {
        await writeEditableBotFile(
          join(directory, "settings.json"),
          jsonFile({ notifyOnAgentUpdates: true })
        );
      }
      // Repair pre-existing server-owned projections as well as new bots.
      for (const file of ["profile.json", "settings.json"]) {
        const path = join(directory, file);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          const mode = info.mode & 0o7777;
          // An agent-owned file is already writable by the agent UID; the
          // server must not fail initialization trying to chmod another owner.
          if (info.isFile() && info.uid === process.getuid?.() && (mode & 0o060) !== 0o060)
            await handle.chmod(mode | 0o060);
        } finally { await handle.close(); }
      }
      if (bot.templateRecipe) {
        // The recipe lives in the creation transaction until all materialization
        // succeeds. Deterministic paths make retries after a crash idempotent.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:workflows'))`;
        const recipe = parseBotRecipe(bot.templateRecipe);
        const count = await tx.savedSkill.count();
        if (count + recipe.skills.length > MAX_SAVED_SKILLS) throw new Error(`Import would exceed the ${MAX_SAVED_SKILLS} saved-skill limit`);
        for (const memory of recipe.memory) {
          const date = memory.createdAt && Number.isFinite(Date.parse(memory.createdAt)) ? new Date(memory.createdAt) : bot.createdAt;
          await this.insertMemoryFact(tx, botId, {
            scope: "agent", tier: memory.kind ?? "profile", fact: memory.content, at: date,
          }, { source: "template" });
        }
        const skillPaths: string[] = [];
        for (const [index, skill] of recipe.skills.entries()) {
          const slug = `template-${botId}-${index}`;
          const input = { slug, name: skill.name, description: skill.description || `Reusable ${skill.name} workflow`, body: skill.content };
          const written = await writeSkillFile(this.workflowsDirectory(), input);
          await tx.savedSkill.upsert({ where: { slug }, create: { ...input, botId: null }, update: {} });
          skillPaths.push(`${skill.name}: ${written.path}`);
        }
        const routinePaths: string[] = [];
        for (const [index, routine] of recipe.routines.entries()) {
          const path = join(directory, "template-routines", `${index}-${slugify(routine.slug, "routine")}.md`);
          await atomicWrite(path, `# ${routine.name || routine.slug}\n\n${routine.description}\n\n${routine.content}\n`);
          routinePaths.push(path);
        }
        const additions = [skillPaths.length ? `Imported skills:\n${skillPaths.join("\n")}` : "", routinePaths.length ? `Proposed routines (not scheduled):\n${routinePaths.join("\n")}\nRead each workflow and configure its destinations and trigger with the user before enabling it.` : "", recipe.plugins.length ? `Plugin requirements (no account access granted by import): ${recipe.plugins.map((item) => item.pluginId).join(", ")}` : "", recipe.gettingStarted ? `On the first conversation, read the imported skill ${JSON.stringify(recipe.gettingStarted.skill)} and use it to guide setup with the user.` : ""].filter(Boolean).join("\n\n");
        await tx.bot.update({ where: { id: botId }, data: { templateRecipe: Prisma.DbNull, instructions: [bot.instructions, additions].filter(Boolean).join("\n\n") } });
        await this.writeBotFilesInTransaction(tx, botId, ["instructions"]);
      }
    });
  }

  async writeBotFiles(
    botId: string,
    targets: BotFileTarget[] = ["profile", "settings", "instructions", "avatar"]
  ): Promise<void> {
    await this.initializeBot(botId);
    await this.withFileMutation(botId, "bot-files", (tx) =>
      this.writeBotFilesInTransaction(tx, botId, targets)
    );
  }

  async mutateBotFiles<T>(
    botId: string,
    targets: BotFileTarget[],
    mutate: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    await this.initializeBot(botId);
    return this.withFileMutation(botId, "bot-files", async (tx) => {
      const result = await mutate(tx);
      await this.writeBotFilesInTransaction(tx, botId, targets);
      return result;
    });
  }

  private async writeBotFilesInTransaction(
    tx: Prisma.TransactionClient,
    botId: string,
    targets: BotFileTarget[]
  ): Promise<void> {
    const bot = await tx.bot.findUnique({
      where: { id: botId },
      include: { subagentIdentity: { select: { id: true } } },
    });
    if (!bot || !["active", "provisioning"].includes(bot.status) || bot.subagentIdentity) return;
    const directory = this.botDirectory(botId);
    if (targets.includes("profile")) {
      const path = join(directory, "profile.json");
      const current = await readText(path);
      let binding: Record<string, string> = {};
      if (current) {
        try {
          const value = parseJsonObject(current, "profile.json");
          const serverId =
            typeof value.serverId === "string" && value.serverId.trim()
              ? value.serverId.trim()
              : null;
          const harness =
            value.harness === "temporal" || value.harness === "box" ? value.harness : null;
          binding = {
            ...(serverId ? { serverId } : {}),
            ...(harness ? { harness } : {}),
          };
        } catch {
          binding = {};
        }
      }
      await writeEditableBotFile(path, jsonFile({ ...profileDocument(bot), ...binding }));
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
      await writeEditableBotFile(path, jsonFile({ ...value, ...settingsDocument(bot) }));
    }
    if (targets.includes("instructions")) {
      await rm(join(directory, "instructions.md"), { force: true });
    }
    if (targets.includes("avatar")) {
      const existing = await this.avatarFiles(botId);
      if (!bot.avatarPath) {
        await this.clearAvatarFiles(botId);
      } else if (existing.length === 0) {
        await this.installAvatarFromPath(botId, bot.avatarPath);
      }
    }
  }

  async writeBotSettings(
    botId: string,
    update: {
      notifyOnAgentUpdates?: boolean;
      hiddenFromSidebar?: boolean;
    }
  ): Promise<void> {
    await this.initializeBot(botId);
    await this.withFileMutation(botId, "settings", async (tx) => {
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) return;
      const path = join(this.botDirectory(botId), "settings.json");
      const current = await readText(path);
      let value: Record<string, unknown> = {};
      if (current !== null) {
        try {
          value = parseJsonObject(current, "settings.json");
        } catch {
          value = {};
        }
      }
      const definedUpdate = Object.fromEntries(
        Object.entries(update).filter(([, candidate]) => candidate !== undefined)
      );
      await writeEditableBotFile(path, jsonFile({ ...value, ...definedUpdate }));
    });
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
    return this.withFileMutation(botId, "avatar", async (tx) => {
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) {
        throw new Error("Cannot update the avatar for an inactive bot");
      }
      if (supplied === null) {
        await tx.bot.update({
          where: { id: botId },
          data: { avatarPath: null },
        });
        await this.clearAvatarFiles(botId);
        return { path: null, resolvedPath: null, bytes: 0 };
      }
      return this.installAvatarFromPath(botId, supplied);
    });
  }

  private async migrateBot(botId: string): Promise<void> {
    await this.withFileMutation(botId, "migration", async (tx) => {
      const migrationKey = `migration:file-native-v3:${botId}`;
      if (await tx.agentFileState.findUnique({ where: { path: migrationKey } })) return;
      const bot = await tx.bot.findUnique({ where: { id: botId } });
      if (!bot || bot.status === "archived") return;

      const migrated = { skills: 0, automations: 0 };

      const globalSkillRoot = this.workflowsDirectory();
      await mkdir(globalSkillRoot, { recursive: true, mode: 0o755 });
      const globalSkillFolders = new Set(await listDirectories(globalSkillRoot));
      const skills = await tx.savedSkill.findMany({
        where: { botId },
        orderBy: { createdAt: "asc" },
      });
      const legacyRoots = [
        join(this.botDirectory(botId), "skills"),
        join(this.botDirectory(botId), "workflows"),
      ];
      for (const legacyRoot of legacyRoots) {
        for (const sourceSlug of await listDirectories(legacyRoot)) {
          const sourcePath = join(legacyRoot, sourceSlug, "SKILL.md");
          const text = await readText(sourcePath, 116_384);
          if (text === null) continue;
          const parsed = parseSkillFile(text, `legacy skill ${sourceSlug}`);
          let targetSlug = sourceSlug;
          if (globalSkillFolders.has(targetSlug)) {
            const globalText = await readText(
              join(globalSkillRoot, targetSlug, "SKILL.md"),
              116_384
            );
            if (globalText === text) {
              await rm(join(legacyRoot, sourceSlug), { recursive: true, force: true });
              continue;
            }
            targetSlug = uniqueSlug(parsed.name, "skill", globalSkillFolders);
          }
          await rename(join(legacyRoot, sourceSlug), join(globalSkillRoot, targetSlug));
          globalSkillFolders.add(targetSlug);
          const existing = skills.find(
            (skill) => skill.slug === sourceSlug || skill.id === sourceSlug
          );
          if (existing) {
            await tx.savedSkill.update({
              where: { id: existing.id },
              data: {
                slug: targetSlug,
                botId: null,
                name: parsed.name,
                description: parsed.description,
                body: parsed.body,
                frontmatter: asInputJson(parsed.frontmatter),
              },
            });
          } else {
            await tx.savedSkill.create({
              data: {
                botId: null,
                slug: targetSlug,
                name: parsed.name,
                description: parsed.description,
                body: parsed.body,
                frontmatter: asInputJson(parsed.frontmatter),
              },
            });
          }
          migrated.skills += 1;
        }
        await rm(legacyRoot, { recursive: true, force: true });
      }
      for (const skill of skills) {
        const current = await tx.savedSkill.findUnique({ where: { id: skill.id } });
        if (!current || globalSkillFolders.has(current.slug)) continue;
        const targetSlug = uniqueSlug(current.name, "skill", globalSkillFolders);
        await writeSkillFile(globalSkillRoot, {
          slug: targetSlug,
          name: current.name,
          description: current.description,
          body: current.body,
          frontmatter:
            current.frontmatter &&
            typeof current.frontmatter === "object" &&
            !Array.isArray(current.frontmatter)
              ? (current.frontmatter as Record<string, unknown>)
              : undefined,
        });
        globalSkillFolders.add(targetSlug);
        if (current.slug !== targetSlug) {
          await tx.savedSkill.update({
            where: { id: current.id },
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

      const legacyManifest = join(this.botDirectory(botId), ".openteam-projection.json");
      await Promise.all([
        rm(join(this.botDirectory(botId), "instructions.md"), { force: true }),
        rm(legacyManifest, { force: true }),
        rm(join(this.botDirectory(botId), ".openteam-projection.legacy.json"), { force: true }),
      ]);
      await tx.agentFileState.upsert({
        where: { path: migrationKey },
        create: {
          path: migrationKey,
          botId,
          kind: "migration",
          digest: "3",
          validDigest: "3",
          exists: true,
        },
        update: {
          botId,
          kind: "migration",
          digest: "3",
          validDigest: "3",
          exists: true,
          error: null,
        },
      });
    });
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${botId}`}))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${AGENT_LOCK}:${botId}`}))`;
        const bot = await tx.bot.findUnique({ where: { id: botId } });
        if (!bot || bot.status === "archived") return;
        await this.reconcileProfile(tx, botId, warnings);
        await this.reconcileSettings(tx, botId, warnings);
        await this.reconcileAvatar(tx, botId, warnings);
        await this.reconcileConnectors(tx, botId, warnings);
        await this.reconcileSkills(tx, warnings);
        await this.reconcileAutomations(tx, botId, warnings);
        await this.reconcileGroups(tx, botId, warnings);
        await mkdir(this.workflowsDirectory(), { recursive: true, mode: 0o755 });
      },
      { maxWait: 10_000, timeout: 60_000 }
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
    const obsolete = await this.prisma.bot.findMany({
      where: { OR: [{ status: "archived" }, { subagentIdentity: { isNot: null } }] },
      select: { id: true },
    });
    for (const bot of obsolete) {
      await rm(this.botDirectory(bot.id), { recursive: true, force: true });
    }
    return { warnings: warnings.slice(0, 100) };
  }

  async reconcileAllAutomationFiles(): Promise<ReconcileResult> {
    const bots = await this.prisma.bot.findMany({
      where: { status: "active", subagentIdentity: { is: null } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const warnings: string[] = [];
    for (const bot of bots) {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${bot.id}`}))`;
          await this.reconcileAutomations(tx, bot.id, warnings);
        },
        { maxWait: 10_000, timeout: 60_000 }
      );
    }
    return { warnings: warnings.slice(0, MAX_FILE_WARNINGS) };
  }

  /**
   * Reconcile one bounded page of automation folders. The filesystem watcher is
   * the low-latency path; this round-robin scan is the recovery path for missed
   * or unavailable watcher events and deliberately caps database/file work.
   */
  async reconcileAutomationFilesBatch(
    afterBotId: string | null,
    limit: number
  ): Promise<AutomationReconcileBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("automation reconciliation batch size must be an integer from 1 to 100");
    }
    const bots = await this.prisma.bot.findMany({
      where: {
        status: "active",
        subagentIdentity: { is: null },
        ...(afterBotId ? { id: { gt: afterBotId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = bots.slice(0, limit);
    const warnings: string[] = [];
    for (const bot of page) {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-files:${bot.id}`}))`;
          await this.reconcileAutomations(tx, bot.id, warnings);
        },
        { maxWait: 10_000, timeout: 60_000 }
      );
    }
    return {
      warnings: warnings.slice(0, MAX_FILE_WARNINGS),
      reconciled: page.length,
      nextCursor: bots.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  startWatching(): Promise<void> {
    if (this.watcherStarting) return this.watcherStarting;
    if (this.watcher) return Promise.resolve();
    this.watcherStarting = this.openWatcher().finally(() => { this.watcherStarting = null; });
    return this.watcherStarting;
  }

  private async openWatcher(): Promise<void> {
    await this.ensureRuntimeDirectories();
    try {
      let snapshot = await snapshotWatchedFiles(this.root, privateRuntimePath);
      this.watcher = watch(this.root, {
        ignoreInitial: true,
        // The root-owned computer runtime maintains these private projections.
        // AgentDataStore never imports them, so recursive watches only create
        // permission errors for the unprivileged server process.
        ignored: [
          { path: join(this.root, "agent-transcripts"), recursive: true },
          { path: join(this.root, "transcript-publish"), recursive: true },
          // Ignore these before Chokidar creates an fs.watch handle. The
          // computer's SQLite snapshots can create and remove `-journal`
          // sidecars quickly enough for Bun on Docker shared volumes to return
          // EINVAL and leave the server's event loop unresponsive.
          (path) => privateRuntimePath(path),
        ],
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
      });
      const onFileChange = (_event: string, path: string) => {
        const normalized = relative(this.root, path).split(sep).join("/");
        if (privateRuntimePath(normalized)) return;
        const globalSkillScope = ["workflows", "managed-skills", "plugin-skills"].find((scope) =>
          normalized.startsWith(`${scope}/`)
        );
        if (globalSkillScope && !normalized.endsWith(".part")) {
          const key = `__global_${globalSkillScope}__`;
          const previous = this.watcherTimers.get(key);
          if (previous) clearTimeout(previous);
          this.watcherTimers.set(
            key,
            setTimeout(() => {
              this.watcherTimers.delete(key);
              const task = this.reconcileAllActiveBots()
                .then(async () => {
                  const botIds = (
                    await this.prisma.bot.findMany({
                      where: { status: "active", subagentIdentity: { is: null } },
                      select: { id: true },
                    })
                  ).map(({ id }) => id);
                  await this.prisma.event.create({
                    data: {
                      topic: "bot.state.filesystem_changed",
                      entityId: null,
                      payload: { scope: globalSkillScope, botIds, path: normalized },
                    },
                  });
                })
                .catch((error) => console.warn("global workflow watcher", error));
              this.watcherTasks.add(task);
              void task.then(() => this.watcherTasks.delete(task));
            }, 50)
          );
          return;
        }
        const botId = normalized.match(/^agents\/([^/]+)\//)?.[1];
        if (!botId || normalized.includes("/.openteam") || normalized.endsWith(".part")) return;
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
      };
      this.watcher.on("all", onFileChange);
      this.watcher.on("error", (error) => console.warn("agent-data watcher", error));
      // With ignoreInitial, edits made during Chokidar's initial scan can be
      // mistaken for initial contents and never emitted. Callers may edit as
      // soon as this method resolves, so wait until subscriptions are ready.
      const watcher = this.watcher;
      await new Promise<void>((resolveReady, rejectReady) => {
        const ready = () => {
          watcher.off("error", failed);
          resolveReady();
        };
        const failed = (error: unknown) => {
          watcher.off("ready", ready);
          rejectReady(error);
        };
        watcher.once("ready", ready);
        watcher.once("error", failed);
      });
      // Native notifications (and watchFile polling) can silently miss changes.
      // Compare metadata as a backstop; unchanged stores do no database work.
      this.watcherScanTimer = setInterval(() => {
        if (this.watcherScan) return;
        this.watcherScan = snapshotWatchedFiles(this.root, privateRuntimePath)
          .then((next) => {
            if (this.watcher !== watcher) return;
            for (const [path, signature] of next) {
              if (snapshot.get(path) !== signature) onFileChange("change", path);
            }
            for (const path of snapshot.keys()) {
              if (!next.has(path)) onFileChange("unlink", path);
            }
            snapshot = next;
          })
          .catch((error) => console.warn("agent-data watcher reconciliation", error))
          .finally(() => { this.watcherScan = null; });
      }, 1_000);
      this.watcherScanTimer.unref();
    } catch (error) {
      console.warn("agent-data recursive watch unavailable; turn-start scans remain active", error);
    }
  }

  private async reconcileWatchedFolder(folderId: string, normalizedPath: string): Promise<void> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: folderId, status: { not: "archived" } },
      select: { id: true, status: true, subagentIdentity: { select: { id: true } } },
    });
    let affectedBotIds: string[];
    if (bot?.subagentIdentity) {
      return;
    }
    if (bot) {
      if (
        bot.status === "provisioning" &&
        /^agents\/[^/]+\/(?:profile|settings)\.json$/.test(normalizedPath)
      ) {
        return;
      }
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
    await this.watcherStarting;
    if (this.watcherScanTimer) clearInterval(this.watcherScanTimer);
    this.watcherScanTimer = null;
    const watcher = this.watcher;
    this.watcher = null;
    await this.watcherScan;
    if (watcher) await watcher.close();
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    this.watcherTimers.clear();
    this.pendingIdentityAnnouncements.clear();
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
    const previous = await tx.bot.findUniqueOrThrow({ where: { id: botId } });
    let text = await readText(path);
    let value: unknown;
    try {
      if (text === null) throw new Error("missing");
      value = JSON.parse(text) as unknown;
    } catch {
      value = profileDocument({ ...previous, name: "New Bot" });
      text = jsonFile(value);
      await writeEditableBotFile(path, text);
    }
    const parsed = profileValues(value);
    await tx.bot.update({ where: { id: botId }, data: parsed });
    await tx.channel.updateMany({
      where: { directKey: `bot:${botId}`, name: { not: parsed.name } },
      data: { name: parsed.name },
    });
    if (previous.name && previous.name !== parsed.name && this.timelineEventSink) {
      await this.timelineEventSink(tx, {
        botId,
        clientId: `profile-file:${randomUUID()}`,
        event: { type: "name-changed", from: previous.name, to: parsed.name },
      });
    }
    await this.trackFile(tx, botId, "profile", path, text);
  }

  private async reconcileSettings(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const path = join(this.botDirectory(botId), "settings.json");
    let text = await readText(path);
    if (text === null) {
      text = jsonFile({ notifyOnAgentUpdates: true });
      await writeEditableBotFile(path, text);
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
        },
      });
      await this.trackFile(tx, botId, "settings", path, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx.bot.update({
        where: { id: botId },
        data: {
          notificationsEnabled: true,
          hiddenFromSidebar: false,
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
    supplied: string
  ): Promise<{ path: string; resolvedPath: string; bytes: number }> {
    const directory = this.botDirectory(botId);
    const canonical = await realpath(resolve(directory, supplied)).catch(() => null);
    const agentDirectory = await realpath(directory).catch(() => directory);
    const unreadable = `could not read "${basename(supplied)}" from your agent directory. The avatar source must stay inside ${directory}: write or copy the image there first, then pass that path.`;
    if (!canonical || !this.isInside(canonical, agentDirectory)) throw new Error(unreadable);
    const bytes = await readBytes(canonical, MAX_AVATAR_BYTES).catch((error: unknown) => {
      throw new Error(error instanceof Error && error.message.includes("is larger than") ? AVATAR_SIZE_REFUSAL : unreadable);
    });
    if (!bytes?.length) throw new Error(AVATAR_SIZE_REFUSAL);
    const extension = sniffAvatarExtension(bytes);
    if (!extension) throw new Error("that file is not a recognized image (png, jpg, webp, gif, or svg).");
    await this.clearAvatarFiles(botId);
    const destination = join(directory, `avatar${extension}`);
    await atomicWrite(destination, bytes);
    const resolvedPath = await realpath(destination);
    await this.prisma.bot.update({ where: { id: botId }, data: { avatarPath: resolvedPath } });
    return { path: supplied, resolvedPath, bytes: bytes.length };
  }

  private async reconcileConnectors(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const root = join(this.botDirectory(botId), "channels");
    const platforms = await listDirectories(root);
    if (!(await this.directoryExists(root))) return;
    for (const platform of platforms) {
      const path = join(root, platform, "connection.json");
      const text = await readText(path, 100_000);
      if (text === null) {
        await tx.botConnectorState.deleteMany({ where: { botId, platform } });
        continue;
      }
      try {
        const value = parseJsonObject(text, `channels/${platform}/connection.json`);
        if (value.platform !== undefined && value.platform !== platform) {
          throw new Error("connection platform must match its folder name");
        }
        if (typeof value.connected !== "boolean") {
          throw new Error("connection.json connected must be a boolean");
        }
        let disconnectedAt: Date | null = null;
        if (value.disconnectedAt !== undefined && value.disconnectedAt !== null) {
          if (typeof value.disconnectedAt !== "string") {
            throw new Error("connection.json disconnectedAt must be an ISO timestamp or null");
          }
          disconnectedAt = new Date(value.disconnectedAt);
          if (Number.isNaN(disconnectedAt.getTime())) {
            throw new Error("connection.json disconnectedAt must be an ISO timestamp or null");
          }
        }
        await tx.botConnectorState.upsert({
          where: { botId_platform: { botId, platform } },
          create: {
            botId,
            platform,
            connected: value.connected,
            disconnectedAt: value.connected ? null : (disconnectedAt ?? new Date()),
          },
          update: {
            connected: value.connected,
            disconnectedAt: value.connected ? null : (disconnectedAt ?? new Date()),
          },
        });
        await this.trackFile(tx, botId, "channel", path, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`channels/${platform}/connection.json: ${message}`);
        await this.trackFile(tx, botId, "channel", path, text, message);
      }
    }
    await tx.botConnectorState.deleteMany({
      where: { botId, platform: { notIn: platforms } },
    });
  }

  async writeConnectorFile(botId: string, platform: string): Promise<void> {
    safeFolderId(platform, "connector platform");
    const state = await this.prisma.botConnectorState.findUnique({
      where: { botId_platform: { botId, platform } },
    });
    const directory = join(this.botDirectory(botId), "channels", platform);
    if (!state) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    await this.withFileMutation(botId, `channel:${platform}`, async (tx) => {
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) return;
      await atomicWrite(
        join(directory, "connection.json"),
        jsonFile({
          platform,
          connected: state.connected,
          disconnectedAt: state.disconnectedAt?.toISOString() ?? null,
        })
      );
    });
  }

  private async reconcileSkills(tx: Tx, warnings: string[]): Promise<void> {
    const root = this.workflowsDirectory();
    const slugs = await listDirectories(root);
    const seen = new Set<string>();
    for (const slug of slugs) {
      const path = join(root, slug, "SKILL.md");
      const text = await readText(path, 116_384);
      if (text === null) continue;
      try {
        const parsed = parseSkillFile(text, `workflows/${slug}/SKILL.md`);
        seen.add(slug);
        await tx.savedSkill.upsert({
          where: { slug },
          create: {
            botId: null,
            slug,
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            frontmatter: asInputJson(parsed.frontmatter),
          },
          update: {
            botId: null,
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            frontmatter: asInputJson(parsed.frontmatter),
          },
        });
        await this.trackFile(tx, null, "skill", path, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`workflows/${slug}/SKILL.md: ${message}`);
        await this.trackFile(tx, null, "skill", path, text, message);
      }
    }
    if (await this.directoryExists(root)) {
      await tx.savedSkill.deleteMany({
        where: { slug: { notIn: [...seen] } },
      });
    }
  }

  private async reconcileAutomations(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    const root = join(this.botDirectory(botId), "automations");
    const slugs = await listDirectories(root);
    const seen = new Set<string>();
    for (const slug of slugs) {
      const path = join(root, slug, "automation.json");
      const text = await readText(path, Number.MAX_SAFE_INTEGER);
      if (text === null) continue;
      try {
        const parsed = await parseAutomationFile(
          path,
          text,
          process.env.OPENTEAM_TIME_ZONE ?? "UTC"
        );
        seen.add(slug);
        const existing = await tx.routine.findUnique({
          where: { botId_slug: { botId, slug } },
        });
        const authoredChanged =
          !existing ||
          existing.name !== parsed.name ||
          existing.prompt !== parsed.prompt ||
          triggerIdentity(existing.trigger as Record<string, unknown>) !==
            triggerIdentity(parsed.trigger);
        const enabledChanged = Boolean(existing) && existing?.enabled !== parsed.enabled;
        const changed = authoredChanged || enabledChanged;
        const revision = existing ? existing.revision + Number(changed) : 1;
        const schedule = parsed.schedule ?? {
          scheduleText: JSON.stringify(parsed.trigger),
          scheduleKind: "event" as const,
          cronExpression: null,
          intervalSeconds: null,
          timezoneMode: "installation" as const,
          timezone: process.env.OPENTEAM_TIME_ZONE ?? "UTC",
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
          pausedAt: parsed.enabled ? null : (existing?.pausedAt ?? new Date()),
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
        if (changed && this.timelineEventSink) {
          await this.timelineEventSink(tx, {
            botId,
            clientId: `automation-file:${randomUUID()}`,
            event: {
              type: "automation-changed",
              action: !existing
                ? "created"
                : authoredChanged
                  ? "updated"
                  : parsed.enabled
                    ? "enabled"
                    : "disabled",
              automationId: routine.id,
              automationName: routine.name,
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
      const removed = await tx.routine.findMany({
        where: { botId, deletedAt: null, slug: { notIn: [...seen] } },
        select: { id: true, name: true },
      });
      for (const routine of removed) {
        await tx.routine.update({
          where: { id: routine.id },
          data: { enabled: false, nextRunAt: null, deletedAt: new Date() },
        });
        if (this.timelineEventSink) {
          await this.timelineEventSink(tx, {
            botId,
            clientId: `automation-file:${randomUUID()}`,
            event: {
              type: "automation-changed",
              action: "deleted",
              automationId: routine.id,
              automationName: routine.name,
            },
          });
        }
      }
    }
  }

  private async reconcileGroups(tx: Tx, botId: string, warnings: string[]): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
            data: { name: profile.name, description: profile.description },
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
        await writeEditableBotFile(
          join(directory, "profile.json"),
          jsonFile({ name: group.name, description: group.description })
        );
      }
      if ((await readText(join(directory, "settings.json"))) === null) {
        await writeEditableBotFile(
          join(directory, "settings.json"),
          jsonFile({ notifyOnAgentUpdates: true })
        );
      }
    }
  }

  private async requireManagedMemoryBot(tx: Tx, botId: string): Promise<void> {
    if (!UUID_FOLDER.test(botId)) throw new ApiError(404, "bot_not_found", "Bot not found");
    const bot = await tx.bot.findFirst({
      where: { id: botId, status: "active", subagentIdentity: { is: null } }, select: { id: true },
    });
    if (!bot) throw new ApiError(404, "bot_not_found", "Bot not found");
  }

  /** The Memories panel lists the bot's own facts, the same rows RecallMemory and the prompt read. */
  private async managedMemoryList(tx: Tx, botId: string): Promise<BotMemoryList> {
    const facts = await tx.memoryFact.findMany({
      where: { namespace: memoryNamespace(botId, "agent") },
      orderBy: [{ createdAt: "desc" }, { sourceOrdinal: "desc" }],
      select: { logicalId: true, fact: true, tier: true, createdAt: true },
    });
    const unique = new Map<string, BotMemoryEntry>();
    for (const fact of [...facts].sort((a, b) => Number(b.tier === "profile") - Number(a.tier === "profile"))) {
      if (!unique.has(fact.logicalId)) unique.set(fact.logicalId, {
        id: fact.logicalId, content: fact.fact, createdAt: fact.createdAt.getTime(),
        kind: fact.tier === "profile" ? "profile" : "log",
      });
    }
    const memories = [...unique.values()].sort((a, b) =>
      Number(b.kind === "profile") - Number(a.kind === "profile") || b.createdAt - a.createdAt);
    return { botId, memories: memories.slice(0, BOT_MEMORY_LIST_LIMIT), total: memories.length, limit: BOT_MEMORY_LIST_LIMIT };
  }

  async listBotMemories(botId: string): Promise<BotMemoryList> {
    await this.requireManagedMemoryBot(this.prisma, botId);
    return this.managedMemoryList(this.prisma, botId);
  }

  /** Omitted id clears the bot's own facts, never shared user memory or pending learning. */
  async deleteBotMemories(botId: string, memoryId?: string): Promise<BotMemoryList> {
    if (memoryId !== undefined && !/^[a-f0-9]{16}$/.test(memoryId))
      throw new ApiError(400, "invalid_memory_id", "Invalid memory id");
    return this.prisma.$transaction(async (tx) => {
      await this.requireManagedMemoryBot(tx, botId);
      const namespace = memoryNamespace(botId, "agent");
      await lockMemoryNamespace(tx, namespace);
      const { count } = await tx.memoryFact.deleteMany({ where: { namespace, ...(memoryId ? { logicalId: memoryId } : {}) } });
      if (count > 0) await tx.event.create({ data: { topic: "memory.changed", entityId: botId, payload: { botId } } });
      // The owner's deletion reaches the bot at once: unpin memory in every conversation, even on an idempotent clear.
      await tx.$executeRaw`UPDATE "AgentPromptSnapshot" SET "promptSections" = "promptSections" - 'memory' WHERE "botId" = ${botId}::uuid`;
      await tx.$executeRaw`UPDATE "ContextPromptSnapshot" SET "promptSections" = "promptSections" - 'memory' WHERE "contextSessionId" IN (SELECT "id" FROM "ContextSession" WHERE "botId" = ${botId}::uuid)`;
      return this.managedMemoryList(tx, botId);
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  /** Append one fact unless the namespace already records the same text. The caller checks the bot is active. */
  private async insertMemoryFact(
    tx: Tx,
    botId: string,
    input: { scope: MemoryScope; tier: "profile" | "log"; fact: string; at?: Date },
    provenance: MemoryProvenance
  ): Promise<{ saved: boolean; logicalId: string; content: string }> {
    const content = normalizeMemoryContent(input.fact);
    const logicalId = memoryLogicalId(content);
    const namespace = memoryNamespace(botId, input.scope);
    if (!content) return { saved: false, logicalId, content };
    await lockMemoryNamespace(tx, namespace);
    if (await tx.memoryFact.findFirst({ where: { namespace, logicalId }, select: { id: true } }))
      return { saved: false, logicalId, content };
    const last = await tx.memoryFact.aggregate({ where: { namespace }, _max: { sourceOrdinal: true } });
    await tx.memoryFact.create({
      data: {
        namespace,
        scope: input.scope,
        tier: memoryTier(content, input.tier),
        fact: content,
        factHash: createHash("sha256").update(content).digest("hex"),
        logicalId,
        sourceOrdinal: (last._max.sourceOrdinal ?? -1) + 1,
        importance: memoryImportance(content),
        origin: provenance.source,
        turnId: provenance.turnId ?? null,
        writtenByBotId: botId,
        createdAt: input.at ?? new Date(),
      },
    });
    // A content-free invalidation reaches every connected client.
    if (input.scope === "agent") await tx.event.create({ data: { topic: "memory.changed", entityId: botId, payload: { botId } } });
    return { saved: true, logicalId, content };
  }

  private async deleteMemoryFact(tx: Tx, botId: string, scope: MemoryScope, fact: string): Promise<boolean> {
    const namespace = memoryNamespace(botId, scope);
    await lockMemoryNamespace(tx, namespace);
    const { count } = await tx.memoryFact.deleteMany({ where: { namespace, logicalId: memoryLogicalId(fact) } });
    if (count > 0 && scope === "agent") await tx.event.create({ data: { topic: "memory.changed", entityId: botId, payload: { botId } } });
    return count > 0;
  }

  async writeMemory(
    botId: string,
    input: {
      scope: MemoryScope;
      tier: "profile" | "log";
      fact: string;
      at?: Date;
    },
    provenance: MemoryProvenance = { source: "tool" }
  ): Promise<{ saved: boolean; logicalId: string; content: string }> {
    return this.prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findUnique({ where: { id: botId }, select: { status: true } });
      if (!bot || bot.status !== "active") throw new Error("Cannot write memory for an inactive bot");
      return this.insertMemoryFact(tx, botId, input, provenance);
    });
  }

  async forgetMemory(
    botId: string,
    input: {
      scope: MemoryScope;
      fact: string;
    }
  ): Promise<{ forgotten: boolean; logicalId: string; content: string }> {
    const content = normalizeMemoryContent(input.fact);
    // Like a write, a forget shows in the pinned memory after the next summary; the tool result reports it now.
    const forgotten = await this.prisma.$transaction((tx) => this.deleteMemoryFact(tx, botId, input.scope, content));
    return { forgotten, logicalId: memoryLogicalId(content), content };
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
    const written = await this.withRootFileMutation("workflows", async (tx) => {
      if ((await tx.bot.count({ where: { id: botId, status: "active" } })) === 0) {
        throw new Error("Cannot write a skill for an inactive bot");
      }
      const existing = input.id
        ? await tx.savedSkill.findFirst({
            where: UUID_FOLDER.test(input.id)
              ? { OR: [{ id: input.id }, { slug: input.id }] }
              : { slug: input.id },
          })
        : null;
      if (input.id && !existing) throw new Error("Skill not found");
      if (!existing && (await tx.savedSkill.count()) >= MAX_SAVED_SKILLS) {
        throw new Error(`The global workflow library may have at most ${MAX_SAVED_SKILLS} skills`);
      }
      const existingFrontmatter =
        existing?.frontmatter &&
        typeof existing.frontmatter === "object" &&
        !Array.isArray(existing.frontmatter)
          ? (existing.frontmatter as Record<string, unknown>)
          : {};
      const result = await writeSkillFile(this.workflowsDirectory(), {
        slug: existing?.slug,
        name: input.name,
        description: input.description,
        body: input.body,
        frontmatter: {
          ...existingFrontmatter,
          ...(input.frontmatter ?? {}),
          name: input.name,
          description: input.description,
        },
      });
      await tx.savedSkill.upsert({
        where: { slug: result.slug },
        create: {
          botId: null,
          slug: result.slug,
          name: input.name,
          description: input.description,
          body: input.body,
          frontmatter: asInputJson({
            ...existingFrontmatter,
            ...(input.frontmatter ?? {}),
            name: input.name,
            description: input.description,
          }),
        },
        update: {
          botId: null,
          name: input.name,
          description: input.description,
          body: input.body,
          frontmatter: asInputJson({
            ...existingFrontmatter,
            ...(input.frontmatter ?? {}),
            name: input.name,
            description: input.description,
          }),
        },
      });
      return result;
    });
    await this.reconcileBot(botId);
    return this.prisma.savedSkill.findUniqueOrThrow({
      where: { slug: written.slug },
    });
  }

  async deleteSkill(botId: string, id: string): Promise<boolean> {
    await this.reconcileBot(botId);
    return this.withRootFileMutation("workflows", async (tx) => {
      const skill = await tx.savedSkill.findFirst({
        where: UUID_FOLDER.test(id) ? { OR: [{ id }, { slug: id }] } : { slug: id },
      });
      if (!skill) return false;
      await deleteSkillFolder(this.workflowsDirectory(), skill.slug);
      await tx.savedSkill.delete({ where: { id: skill.id } });
      return true;
    });
  }

  async writeRoutine(botId: string, id: string, transaction?: Tx): Promise<void> {
    const write = async (tx: Tx): Promise<void> => {
      const routine = await tx.routine.findFirst({
        where: { id, botId, deletedAt: null, bot: { status: "active" } },
      });
      if (!routine) return;
      await writeAutomationFiles(this.botDirectory(botId), {
        ...routine,
        slug: routine.slug,
        runLedger: routine.runLedger,
      });
    };
    if (transaction) return write(transaction);
    await this.withFileMutation(botId, `routine:${id}`, write);
  }

  async listRoutineFolderIds(botId: string): Promise<string[]> {
    safeFolderId(botId, "bot id");
    return listDirectories(join(this.botDirectory(botId), "automations"));
  }

  async deleteRoutine(botId: string, id: string, transaction?: Tx): Promise<void> {
    const remove = async (tx: Tx): Promise<void> => {
      const routine = await tx.routine.findFirst({
        where: { id, botId },
      });
      if (routine) await deleteAutomationFolder(this.botDirectory(botId), routine.slug);
    };
    if (transaction) return remove(transaction);
    await this.withFileMutation(botId, `routine:${id}`, remove);
  }

  async promptContext(botId: string, contextSessionId?: string, channelId?: string | null): Promise<AgentPromptContext> {
    const reconciliation = await this.reconcileBot(botId);
    const bot = await this.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { conversation: true },
    });
    const contextSession = contextSessionId
      ? await this.prisma.contextSession.findFirstOrThrow({
          where: { id: contextSessionId, botId },
        })
      : null;
    const epoch = contextSession?.compactionEpoch ?? bot.conversation?.compactionEpoch ?? 0;
    const announcementKey = `${botId}:${contextSessionId ?? "legacy"}`;
    const liveProfile = [
      `You are ${bot.name}, a durable OpenTeam agent.`,
      bot.title ? `Your title is: ${bot.title}` : "",
      bot.description ? `Your description is:\n${bot.description}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    let snapshot = contextSessionId
      ? await this.prisma.contextPromptSnapshot.findUnique({ where: { contextSessionId } })
      : await this.prisma.agentPromptSnapshot.findUnique({ where: { botId } });
    let profileSection: string;
    let identityAnnouncement = "";
    if (!snapshot || snapshot.profileEpoch !== epoch) {
      const snapshotData = {
        profileEpoch: epoch,
        profileSection: liveProfile,
        systemName: bot.name,
        systemDescription: bot.description,
        announcedName: bot.name,
        announcedDescription: bot.description,
      };
      snapshot = contextSessionId
        ? await this.prisma.contextPromptSnapshot.upsert({
            where: { contextSessionId },
            create: { contextSessionId, ...snapshotData },
            update: snapshotData,
          })
        : await this.prisma.agentPromptSnapshot.upsert({
            where: { botId },
            create: { botId, ...snapshotData },
            update: snapshotData,
          });
      profileSection = liveProfile;
      this.pendingIdentityAnnouncements.delete(announcementKey);
    } else {
      profileSection = snapshot.profileSection;
      if (
        snapshot.announcedName !== bot.name ||
        snapshot.announcedDescription !== bot.description
      ) {
        identityAnnouncement = renderAgentProfileUpdate(bot.name, bot.description);
        this.pendingIdentityAnnouncements.set(announcementKey, {
          epoch,
          profileSection: snapshot.profileSection,
          systemName: snapshot.systemName,
          systemDescription: snapshot.systemDescription,
          announcedName: bot.name,
          announcedDescription: bot.description,
          previousName: snapshot.announcedName,
          previousDescription: snapshot.announcedDescription,
        });
      } else {
        this.pendingIdentityAnnouncements.delete(announcementKey);
      }
    }

    const sharedConversation = await this.isSharedConversation(botId, channelId);
    const memory = await this.renderMemory(botId, sharedConversation);

    let skillRender: string;
    if (snapshot.skillEpoch === epoch) {
      skillRender = snapshot.skillRender;
    } else {
      const liveSkills = await this.renderSkills(botId);
      skillRender = liveSkills;
      const data = { skillEpoch: epoch, skillRender: liveSkills };
      if (contextSessionId) {
        await this.prisma.contextPromptSnapshot.update({ where: { contextSessionId }, data });
      } else {
        await this.prisma.agentPromptSnapshot.update({ where: { botId }, data });
      }
    }
    // Installed capabilities can change between turns without compaction.
    // Keep user workflows frozen, but never freeze a missing managed or plugin catalog.
    // The reference lists managed skills first, then plugin, then the user's own.
    skillRender = [await this.renderManagedSkills(), await this.renderPluginSkills(botId), skillRender]
      .filter(Boolean)
      .join("\n\n");
    return {
      compactionEpoch: epoch,
      profileSection,
      profileSnapshot: {
        version: 1,
        profileSection,
        systemIdentity: {
          name: snapshot.systemName,
          description: snapshot.systemDescription,
        },
        announcedIdentity: {
          name: snapshot.announcedName,
          description: snapshot.announcedDescription,
        },
        compactionEpoch: epoch,
      },
      identityAnnouncement,
      identityReceipt: this.pendingIdentityAnnouncements.get(announcementKey),
      memory,
      skillRender,
      warnings: reconciliation.warnings,
    };
  }

  async preparePlatformSections(
    botId: string,
    contextSessionId: string | undefined,
    epoch: number,
    live: Record<string, string>,
    memory?: MemoryContextLive
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`prompt-sections:${contextSessionId ?? botId}`}))`;
      const snapshot = contextSessionId
        ? await tx.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId } })
        : await tx.agentPromptSnapshot.findUniqueOrThrow({ where: { botId } });
      const result = preparePromptSections(snapshot.promptSections, epoch, live);
      const pinned = memory ? prepareMemoryContext(result.snapshots, epoch, memory) : undefined;
      const data = { promptSections: JSON.parse(JSON.stringify(result.snapshots)) as Prisma.InputJsonValue };
      if (contextSessionId) await tx.contextPromptSnapshot.update({ where: { contextSessionId }, data });
      else await tx.agentPromptSnapshot.update({ where: { botId }, data });
      return {
        ...result,
        memory: pinned && {
          facts: pinned.facts,
          update: pinned.changed ? renderOtherAssistantMemoryUpdate(memory?.otherAgents?.render ?? "") : null,
          receipt: pinned.receipt,
        },
      };
    });
  }

  async acknowledgePlatformSections(
    botId: string,
    contextSessionId: string | undefined,
    receipts: readonly PromptSectionReceipt[],
    memory?: MemoryContextReceipt
  ) {
    if (!receipts.length && !memory) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`prompt-sections:${contextSessionId ?? botId}`}))`;
      const snapshot = contextSessionId
        ? await tx.contextPromptSnapshot.findUniqueOrThrow({ where: { contextSessionId } })
        : await tx.agentPromptSnapshot.findUniqueOrThrow({ where: { botId } });
      const acknowledged = acknowledgePromptSections(snapshot.promptSections, receipts);
      const sections = memory ? acknowledgeMemoryContext(acknowledged, memory) : acknowledged;
      const data = { promptSections: JSON.parse(JSON.stringify(sections)) as Prisma.InputJsonValue };
      if (contextSessionId) await tx.contextPromptSnapshot.update({ where: { contextSessionId }, data });
      else await tx.agentPromptSnapshot.update({ where: { botId }, data });
    });
  }

  async acknowledgeIdentityAnnouncement(botId: string, contextSessionId?: string, receipt?: PendingIdentityAnnouncement): Promise<void> {
    const announcementKey = `${botId}:${contextSessionId ?? "legacy"}`;
    const pending = receipt ?? this.pendingIdentityAnnouncements.get(announcementKey);
    if (!pending) return;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`identity-announcement:${botId}`}))`;
        const snapshot = contextSessionId
          ? await tx.contextPromptSnapshot.findUnique({ where: { contextSessionId } })
          : await tx.agentPromptSnapshot.findUnique({ where: { botId } });
        if (
          !snapshot ||
          snapshot.profileEpoch !== pending.epoch ||
          snapshot.profileSection !== pending.profileSection ||
          snapshot.systemName !== pending.systemName ||
          snapshot.systemDescription !== pending.systemDescription ||
          snapshot.announcedName !== pending.previousName ||
          snapshot.announcedDescription !== pending.previousDescription
        ) {
          return;
        }
        const data = {
          announcedName: pending.announcedName,
          announcedDescription: pending.announcedDescription,
        };
        if (contextSessionId) {
          await tx.contextPromptSnapshot.update({ where: { contextSessionId }, data });
        } else {
          await tx.agentPromptSnapshot.update({ where: { botId }, data });
        }
      });
    } finally {
      if (this.pendingIdentityAnnouncements.get(announcementKey) === pending) {
        this.pendingIdentityAnnouncements.delete(announcementKey);
      }
    }
  }

  async recallMemory(botId: string, input: unknown, channelId?: string | null): Promise<string> {
    const args = parseRecallInput(input);
    const userVisible = !(await this.isSharedConversation(botId, channelId));
    const facts = await this.prisma.memoryFact.findMany({
      where: { OR: [
        { namespace: memoryNamespace(botId, "agent") },
        ...(userVisible ? [{ namespace: { startsWith: "user:agent:" } }] : []),
      ] },
      orderBy: [{ createdAt: "desc" }, { sourceOrdinal: "desc" }],
    });
    const writers = await this.prisma.bot.findMany({
      where: { id: { in: [...new Set(facts.flatMap((fact) => fact.writtenByBotId ? [fact.writtenByBotId] : []))] } },
      select: { id: true, name: true },
    });
    const names = new Map(writers.map((writer) => [writer.id, writer.name]));
    const own = facts.filter((fact) => fact.scope !== "user").sort((a, b) =>
      Number(b.tier === "profile") - Number(a.tier === "profile") || b.createdAt.getTime() - a.createdAt.getTime() ||
      b.sourceOrdinal - a.sourceOrdinal);
    const shared = new Map<string, (typeof facts)[number]>();
    for (const fact of facts.filter((fact) => fact.scope === "user").sort((a, b) => (a.writtenByBotId ?? "").localeCompare(b.writtenByBotId ?? ""))) {
      const key = normalizeMemoryContent(fact.fact).toLowerCase();
      const previous = shared.get(key);
      if (!previous || fact.createdAt > previous.createdAt) shared.set(key, fact);
    }
    const candidates = [...own, ...[...shared.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0))];
    return recallMemoryResult(args, candidates.map((fact) => ({
      content: fact.fact, createdAt: fact.createdAt, tier: fact.tier,
      scope: fact.scope === "user" ? "user" : "agent",
      via: fact.writtenByBotId ? names.get(fact.writtenByBotId) ?? fact.writtenByBotId : undefined,
    })));
  }

  async listSections(): Promise<RootSidebarSection[]> {
    const root = await this.loadRootSettings();
    if (!root.valid) throw new Error(root.error ?? "Sidebar settings are invalid");
    return (root.settings.sidebarSections ?? []).filter((section) => section.id !== AGENTS_SECTION_ID);
  }

  async assignAgentSection(botId: string, sectionId: string) {
    await this.withRootFileMutation("settings", async () => {
      const current = await this.loadRootSettings();
      if (!current.valid) throw new Error(current.error ?? "Sidebar settings are invalid");
      const sections = current.settings.sidebarSections ?? [];
      if (!sections.some((section) => section.id === sectionId && section.id !== AGENTS_SECTION_ID)) throw new Error(`No sidebar section found with id ${sectionId}`);
      const next = { ...current.settings, sidebarSections: sections.map((section) => ({
        ...section, agentIds: [...section.agentIds.filter((id) => id !== botId), ...(section.id === sectionId ? [botId] : [])],
      })) };
      await atomicWrite(join(this.root, "settings.json"), jsonFile(next), 0o600);
    });
  }

  /** The memory policy for the system prompt, and the facts for <memory_context>. A group room sees no shared user memory. */
  private async renderMemory(botId: string, sharedConversation: boolean): Promise<LiveMemory> {
    const userVisible = !sharedConversation;
    const all = await this.prisma.memoryFact.findMany({
      where: {
        OR: [
          { namespace: memoryNamespace(botId, "agent") },
          ...(userVisible ? [{ namespace: { startsWith: "user:agent:" } }] : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { sourceOrdinal: "desc" }],
    });
    const writerIds = [
      ...new Set(
        all
          .map((fact) => fact.writtenByBotId)
          .filter((writer): writer is string => typeof writer === "string")
      ),
    ];
    const writerNames = new Map(
      (
        await this.prisma.bot.findMany({
          where: { id: { in: writerIds } },
          select: { id: true, name: true },
        })
      ).map((writer) => [writer.id, writer.name])
    );
    type Fact = (typeof all)[number];
    const record = (fact: Fact): PromptMemoryRecord => ({
      content: fact.fact, createdAt: fact.createdAt.getTime(),
      via: fact.writtenByBotId ? writerNames.get(fact.writtenByBotId) ?? fact.writtenByBotId : "",
    });
    const own = all.filter((fact) => fact.namespace === memoryNamespace(botId, "agent"));
    const recency = (a: Fact, b: Fact) => b.createdAt.getTime() - a.createdAt.getTime() || b.sourceOrdinal - a.sourceOrdinal;
    const ownFacts = renderMemoryFactSnapshot({
      profile: own.filter((fact) => fact.tier === "profile").sort(recency).slice(0, MEMORY_PROFILE_PROMPT_LIMIT).map(record),
      recent: own.filter((fact) => fact.tier !== "profile").sort((a, b) => scoreFact(b) - scoreFact(a) || recency(a, b)).slice(0, MEMORY_RECENT_PROMPT_LIMIT).map(record),
    });
    const ownPolicy = `${MEMORY_HEADING}\n${renderMemorySystemPolicyPrompt()}`;
    if (!userVisible) return { policy: ownPolicy, facts: ownFacts };

    // Shards merge with the newest copy winning; other assistants' part is fingerprinted for change notes.
    const sharedSelection = (facts: Fact[]) => {
      const merged = mergeWriterShards(facts, MEMORY_USER_RECENT_PROMPT_LIMIT);
      return {
        profile: selectFacts(merged.filter((fact) => fact.tier === "profile"), MEMORY_USER_PROFILE_PROMPT_LIMIT, Number.MAX_SAFE_INTEGER).selected,
        recent: selectFacts(merged.filter((fact) => fact.tier !== "profile"), MEMORY_USER_RECENT_PROMPT_LIMIT, Number.MAX_SAFE_INTEGER, { rankByImportance: true }).selected,
      };
    };
    const records = (selection: { profile: Fact[]; recent: Fact[] }) => ({
      profile: selection.profile.map(record),
      recent: selection.recent.map(record),
    });
    const shared = all.filter((fact) => fact.scope === "user");
    const others = sharedSelection(shared.filter((fact) => fact.writtenByBotId !== botId));
    const otherFacts = [...others.profile, ...others.recent];
    return {
      policy: `${SHARED_USER_MEMORY_HEADING}\n${renderUserMemorySystemPolicyPrompt()}\n\n${ownPolicy}`,
      facts: `${renderUserMemoryFactSnapshot(records(sharedSelection(shared)))}\n\n${ownFacts}`,
      otherAgents: {
        render: otherFacts.length ? renderUserMemoryFactSnapshot(records(others)) : "",
        fingerprint: createHash("sha256")
          .update(JSON.stringify(otherFacts.map((fact) => [fact.writtenByBotId, fact.logicalId, fact.tier === "profile" ? "profile" : "log", fact.createdAt.getTime(), fact.fact])))
          .digest("hex"),
      },
    };
  }

  private async renderManagedSkills(): Promise<string> {
    if (process.env.OPENTEAM_MANAGED_SKILLS === "false") return "";
    const text = await readText(join(this.managedSkillsDirectory(), "cache.json"));
    if (!text) return "";
    try {
      const cache = JSON.parse(text);
      if (!Array.isArray(cache.skills)) return "";
      // Skills for a worker type (such as knowledgeWork) stay out of the main agent's catalog.
      const allowed = new Set(managedSkills.skills.filter(managedSkillIsForMain).map((skill) => skill.id));
      const blocks: string[] = [];
      for (const skill of cache.skills.slice(0, MAX_SAVED_SKILLS)) {
        if (!skill || !allowed.has(skill.id) || typeof skill.name !== "string" ||
            typeof skill.description !== "string") continue;
        const path = join(this.managedSkillsDirectory(), skill.id, "SKILL.md");
        if (!(await stat(path).catch(() => null))?.isFile()) continue;
        blocks.push(agentSkillItem(path, skill.description));
      }
      return blocks.join("\n\n");
    } catch { return ""; }
  }

  // Plugin skills join the same catalog once the plugin service has written
  // their files to the computer; until then the worker gives their full text.
  private async renderPluginSkills(botId: string): Promise<string> {
    const text = await readText(join(this.pluginSkillsDirectory(), "cache.json"));
    if (!text) return "";
    let cache: PluginSkillCache;
    try {
      cache = JSON.parse(text) as PluginSkillCache;
    } catch {
      return "";
    }
    const [installations, privateSkills] = await Promise.all([
      this.prisma.pluginInstallation.findMany({ where: { status: "installed" } }),
      this.prisma.pluginPrivateSkill.findMany({
        where: { enabledBotIds: { array_contains: [botId] } },
      }),
    ]);
    return renderPluginSkillCatalog(pluginSkillsForAgent(cache, installations, privateSkills, "main"));
  }

  /** The agent_skills catalog of a worker type that carries managed skills of its own. */
  async renderWorkerSkillCatalog(agent: string): Promise<string> {
    if (process.env.OPENTEAM_MANAGED_SKILLS === "false") return "";
    const text = await readText(join(this.managedSkillsDirectory(), "cache.json"));
    if (!text) return "";
    let records: unknown[];
    try {
      const cache = JSON.parse(text);
      records = Array.isArray(cache.skills) ? cache.skills : [];
    } catch {
      return "";
    }
    const entries: string[] = [];
    for (const record of records) {
      const skill = record as Record<string, unknown>;
      if (!Array.isArray(skill.agents) || !skill.agents.includes(agent)) continue;
      if (typeof skill.filePath !== "string" || typeof skill.description !== "string") continue;
      if (!(await stat(skill.filePath).catch(() => null))?.isFile()) continue;
      entries.push(agentSkillItem(skill.filePath, skill.description));
    }
    return entries.length ? renderAgentSkillsSection(entries.join("\n\n")) : "";
  }

  private async renderSkills(botId: string): Promise<string> {
    void botId;
    const [skills, total] = await Promise.all([
      this.prisma.savedSkill.findMany({
        orderBy: { updatedAt: "desc" },
        take: MAX_SAVED_SKILLS,
      }),
      this.prisma.savedSkill.count(),
    ]);
    const blocks = skills.map((skill) =>
      agentSkillItem(join(this.workflowsDirectory(), skill.slug, "SKILL.md"), skill.description)
    );
    const omitted = Math.max(0, total - blocks.length);
    if (omitted > 0) blocks.push(omittedSkillsNotice(omitted, [this.workflowsDirectory()]));
    return blocks.join("\n\n");
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

  private async mapSidebarIds(
    ids: readonly string[],
    direction: "channel-to-agent" | "agent-to-channel"
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    const uuids = unique.filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    );
    if (uuids.length === 0) return [...ids];
    const channels = await this.prisma.channel.findMany({
      where:
        direction === "channel-to-agent"
          ? { id: { in: uuids } }
          : {
              OR: [{ id: { in: uuids } }, { directKey: { in: uuids.map((id) => `bot:${id}`) } }],
            },
      select: { id: true, directKey: true },
    });
    const mapping = new Map<string, string>();
    for (const channel of channels) {
      const botId = channel.directKey?.startsWith("bot:")
        ? channel.directKey.slice("bot:".length)
        : null;
      if (direction === "channel-to-agent") mapping.set(channel.id, botId || channel.id);
      else mapping.set(botId || channel.id, channel.id);
    }
    return ids.map((id) => mapping.get(id) ?? id);
  }

  async loadRootSettingsForClient(): Promise<{
    settings: RootSettings;
    valid: boolean;
    error?: string;
  }> {
    const result = await this.loadRootSettings();
    const ids = [
      ...(result.settings.pinnedAgentIds ?? []),
      ...(result.settings.sidebarSections ?? []).flatMap((section) => section.agentIds),
    ];
    const mapped = await this.mapSidebarIds(ids, "agent-to-channel");
    const mapping = new Map(ids.map((id, index) => [id, mapped[index] ?? id]));
    return {
      ...result,
      settings: {
        ...result.settings,
        ...(result.settings.pinnedAgentIds
          ? {
              pinnedAgentIds: result.settings.pinnedAgentIds.map((id) => mapping.get(id) ?? id),
            }
          : {}),
        ...(result.settings.sidebarSections
          ? {
              sidebarSections: result.settings.sidebarSections.map((section) => ({
                ...section,
                agentIds: section.agentIds.map((id) => mapping.get(id) ?? id),
              })),
            }
          : {}),
      },
    };
  }

  async loadInferenceSettings(
    options: { allowUnconfigured?: boolean } = {}
  ): Promise<ServerInferenceSettings> {
    const root = await this.loadRootSettings();
    if (!root.valid) throw new Error(root.error ?? "Server settings are invalid");
    if (!root.settings.inference.modelId && !options.allowUnconfigured) {
      throw new Error("Choose and save an inference model in model settings before starting a task.");
    }
    return root.settings.inference;
  }

  async loadTaskConfiguration(): Promise<TaskConfiguration> {
    const row = await this.prisma.taskSettings.findUnique({ where: { id: "global" } });
    return row ? parseTaskConfiguration(row.configuration) : defaultTaskConfiguration();
  }

  async writeTaskConfiguration(input: unknown): Promise<TaskConfiguration> {
    const configuration = parseTaskConfiguration(input);
    await this.prisma.taskSettings.upsert({
      where: { id: "global" },
      create: { id: "global", configuration: JSON.parse(JSON.stringify(configuration)) },
      update: { configuration: JSON.parse(JSON.stringify(configuration)) },
    });
    return configuration;
  }

  async writeRootSettings(input: Partial<RootSettings>): Promise<RootSettings> {
    return this.withRootFileMutation("settings", async () => {
      const current = await this.loadRootSettings();
      const next = parseRootSettings({
        ...current.settings,
        ...input,
        version: 1,
      });
      await atomicWrite(join(this.root, "settings.json"), jsonFile(next), 0o600);
      return next;
    });
  }

  async writeInferenceSettings(input: ServerInferenceSettings): Promise<ServerInferenceSettings> {
    const settings = await this.writeRootSettings({ inference: input });
    return settings.inference;
  }

  async writeSidebarPreferences(input: unknown): Promise<SidebarPreferences> {
    const sidebarPreferences = parseSidebarPreferences(input);
    const channelIds = [
      ...sidebarPreferences.pinnedIds,
      ...Object.keys(sidebarPreferences.sectionByChannel),
    ];
    const agentIds = await this.mapSidebarIds(channelIds, "channel-to-agent");
    const idMapping = new Map(
      channelIds.map((channelId, index) => [channelId, agentIds[index] ?? channelId])
    );
    await this.writeRootSettings({
      pinnedAgentIds: sidebarPreferences.pinnedIds.map(
        (channelId) => idMapping.get(channelId) ?? channelId
      ),
      sidebarSections: normalizeSidebarSections(
        sidebarPreferences.sections.map((section) => ({
          id: section.id,
          name: section.name,
          agentIds: Object.entries(sidebarPreferences.sectionByChannel)
            .filter(([, sectionId]) => sectionId === section.id)
            .map(([channelId]) => idMapping.get(channelId) ?? channelId),
          isCollapsed: section.collapsed,
        }))
      ),
    });
    return sidebarPreferences;
  }

  async loadActiveAgentId(): Promise<string | null> {
    const text = await readText(join(this.root, "agents", "active-agent.json"));
    if (text === null) return null;
    try {
      const value = parseJsonObject(text, "active-agent.json");
      return typeof value.activeAgentId === "string" && value.activeAgentId.length > 0
        ? value.activeAgentId
        : null;
    } catch {
      return null;
    }
  }

  async writeActiveAgentId(activeAgentId: string): Promise<void> {
    try {
      safeFolderId(activeAgentId, "active agent id");
    } catch {
      throw new ApiError(400, "invalid_active_agent", "activeAgentId must be a safe folder id");
    }
    await this.withRootFileMutation("active-agent", async () => {
      await atomicWrite(
        join(this.root, "agents", "active-agent.json"),
        jsonFile({ activeAgentId })
      );
    });
  }

  async repairActiveAgentAfterDeletion(deletedBotId: string): Promise<string | null> {
    return this.withRootFileMutation("active-agent", async (tx) => {
      if ((await this.loadActiveAgentId()) !== deletedBotId) return null;
      const successor = await tx.bot.findFirst({
        where: {
          id: { not: deletedBotId },
          status: "active",
          subagentIdentity: null,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (successor) {
        await atomicWrite(
          join(this.root, "agents", "active-agent.json"),
          jsonFile({ activeAgentId: successor.id })
        );
        return successor.id;
      }
      await rm(join(this.root, "agents", "active-agent.json"), { force: true });
      return null;
    });
  }

  async writeGroupFilesForBot(botId: string, tx?: Tx): Promise<void> {
    if (!tx) return this.withRootFileMutation("groups", (locked) => this.writeGroupFilesForBot(botId, locked));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('root-file:groups'))`;
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
      await atomicWrite(
        join(directory, "group.json"),
        jsonFile({
          version: 1,
          memberIds: group.members.map((member) => member.botId),
        })
      );
      await writeEditableBotFile(
        join(directory, "profile.json"),
        jsonFile({ name: group.name, description: group.description })
      );
      if ((await readText(join(directory, "settings.json"))) === null) {
        await writeEditableBotFile(
          join(directory, "settings.json"),
          jsonFile({ notifyOnAgentUpdates: true })
        );
      }
    }
  }

  async appendAudit(botId: string, entry: Record<string, unknown>): Promise<void> {
    try {
      await this.withFileMutation(botId, "audit", async (tx) => {
        const active = await tx.bot.count({ where: { id: botId, status: "active" } });
        if (active === 0) return;
        const path = join(this.botDirectory(botId), "audit.jsonl");
        await mkdir(this.botDirectory(botId), { recursive: true });
        await appendFile(
          path,
          `${JSON.stringify({ ts: new Date().toISOString(), agentId: botId, ...entry })}\n`,
          {
            encoding: "utf8",
            mode: 0o644,
          }
        );
      });
    } catch {
      // Best effort: audit forwarding must not fail the requested action.
    }
  }

  private async inferMemory(
    request: Omit<MemoryInferenceRequest, "timeoutMs">,
    deadlineAt = Date.now() + MEMORY_INFERENCE_DEADLINE_MS
  ): Promise<string | null> {
    if (!this.memoryInference) return null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      try {
        return await this.memoryInference({ ...request, timeoutMs: remaining });
      } catch (error) {
        lastError = error;
        if (attempt >= 2) break;
        const delay = Math.min(2_000 * 2 ** attempt, 30_000, Math.max(0, remaining - 1));
        if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Memory inference failed");
  }

  private async runMemoryExtraction(
    botId: string,
    input: { exchange: MemoryExchange; earlier: readonly MemoryExchange[]; occurredAt: number; timeZone: string; runId?: string }
  ): Promise<void> {
    const facts = await this.prisma.memoryFact.findMany({
      where: { namespace: memoryNamespace(botId, "agent") },
      orderBy: { sourceOrdinal: "asc" },
      select: { fact: true, tier: true, createdAt: true, importance: true },
    });
    const existing = gatherExtractionMemories(
      facts.map((fact) => ({ ...fact, content: fact.fact })),
      [...input.earlier, input.exchange].map((held) => `${held.user}\n${held.agent}`).join("\n")
    );
    const response = await this.inferMemory({
      kind: "extraction",
      instructions: MEMORY_EXTRACTION_SYSTEM_PROMPT,
      prompt: buildExtractionUserPrompt(
        input.exchange.user,
        input.exchange.agent,
        existing,
        input.earlier,
        renderTurnMemoryDate(new Date(input.occurredAt), input.timeZone)
      ),
    });
    if (!response) return;
    const extraction = parseExtractedMemories(response, existing);
    if (!extraction.additions.length && !extraction.removals.length) return;
    const known = new Set(existing.map((fact) => memoryLogicalId(fact)));
    await this.prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findUnique({ where: { id: botId }, select: { status: true } });
      if (!bot || bot.status !== "active") return;
      // Only a fact the learner was shown can be retired; it cannot invent removals.
      for (const removal of extraction.removals) {
        if (known.has(memoryLogicalId(removal))) await this.deleteMemoryFact(tx, botId, "agent", removal);
      }
      for (const addition of extraction.additions) {
        await this.insertMemoryFact(tx, botId, {
          scope: "agent", tier: addition.kind, fact: addition.content, at: new Date(input.occurredAt),
        }, { source: "extract", turnId: input.runId });
      }
    });
  }

  /** Record the exchange before extraction runs; take over earlier ones an interrupted review left unreviewed. */
  private async holdMemoryExchange(
    botId: string,
    exchange: HeldMemoryExchange,
    claimed: string[]
  ): Promise<HeldMemoryExchange[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memory-exchanges:${botId}`}))`;
      const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId }, select: { pendingMemoryExchanges: true } });
      const held = parseHeldMemoryExchanges(bot.pendingMemoryExchanges).filter((entry) => entry.id !== exchange.id);
      // An exchange another review here still owns stays with it; any other was left by a stopped process.
      const inReview = held.filter((entry) => this.memoryExchangesInReview.has(entry.id));
      const earlier = held.filter((entry) => !this.memoryExchangesInReview.has(entry.id)).slice(-(MAX_HELD_MEMORY_EXCHANGES - 1));
      // Claimed under the lock, so a concurrent hold here sees them as owned.
      claimed.push(exchange.id, ...earlier.map((entry) => entry.id));
      for (const id of claimed) this.memoryExchangesInReview.add(id);
      await tx.bot.update({
        where: { id: botId },
        data: {
          pendingMemoryExchanges: asInputJson(
            [...inReview, ...earlier, holdMemoryExchange(exchange)].slice(-MAX_HELD_MEMORY_EXCHANGES)
          ),
        },
      });
      return earlier;
    });
  }

  private async releaseMemoryExchanges(botId: string, ids: readonly string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memory-exchanges:${botId}`}))`;
      const bot = await tx.bot.findUnique({ where: { id: botId }, select: { pendingMemoryExchanges: true } });
      if (!bot) return;
      const remaining = parseHeldMemoryExchanges(bot.pendingMemoryExchanges).filter((held) => !ids.includes(held.id));
      await tx.bot.update({ where: { id: botId }, data: { pendingMemoryExchanges: asInputJson(remaining) } });
    });
  }

  /** After a completed user or group turn, learn lasting profile facts from it. */
  async recordTurnMemory(
    botId: string,
    input: {
      user: string;
      assistant: string;
      hidden?: boolean;
      occurredAt?: number;
      runId?: string;
      timeZone?: string;
    }
  ): Promise<void> {
    if (!this.memoryInference || input.hidden || !input.user.trim()) return;
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      select: { status: true },
    });
    if (!bot || bot.status !== "active") return;
    if (!isMemorableExchange(input.user)) return;
    const exchange = { id: input.runId ?? randomUUID(), user: input.user, agent: input.assistant };
    const claimed: string[] = [];
    try {
      const earlier = await this.holdMemoryExchange(botId, exchange, claimed);
      try {
        await this.runMemoryExtraction(botId, {
          exchange,
          earlier,
          occurredAt: input.occurredAt ?? Date.now(),
          timeZone: input.timeZone ?? resolveTimeZone(),
          runId: input.runId,
        });
      } catch (error) {
        console.warn(`memory extraction for ${botId}`, error);
      }
      // Reviewed or failed, these are done. Only a process that stops mid-extraction leaves one held.
      await this.releaseMemoryExchanges(botId, claimed);
    } finally {
      for (const id of claimed) this.memoryExchangesInReview.delete(id);
    }
  }

  async materializeAttachments(
    botId: string,
    messageId: string,
    attachments: readonly AssetRef[]
  ): Promise<string[]> {
    void messageId;
    if (attachments.length === 0) return [];
    if (
      (await this.prisma.bot.count({
        where: { id: botId, status: { in: ["active", "provisioning"] } },
      })) === 0
    ) {
      return [];
    }
    const directory = join(this.botDirectory(botId), "attachments");
    const stagingDirectory = join(this.root, ".attachment-staging");
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const staged: Array<{ assetId: string; temporary: string; path: string }> = [];
    try {
      for (const attachment of attachments) {
        if (!/^[a-f0-9]{64}$/.test(attachment.assetId)) continue;
        if (
          !Number.isSafeInteger(attachment.byteSize) ||
          attachment.byteSize < 0 ||
          attachment.byteSize > MAX_MATERIALIZED_ATTACHMENT_BYTES
        ) {
          continue;
        }
        const source = join(this.assetRoot, `${attachment.assetId}.blob`);
        try {
          const file = await stat(source);
          if (!file.isFile() || file.size !== attachment.byteSize) continue;
        } catch {
          continue;
        }
        const candidateExtension = extname(attachment.fileName).toLowerCase();
        const extension = /^\.[a-z0-9]{1,12}$/.test(candidateExtension)
          ? candidateExtension
          : ".bin";
        const temporary = join(stagingDirectory, `.attachment-part-${randomUUID()}`);
        if (
          !(await stageAttachmentCopy({
            source,
            temporary,
            expectedAssetId: attachment.assetId,
            expectedByteSize: attachment.byteSize,
          }))
        ) {
          continue;
        }
        staged.push({
          assetId: attachment.assetId,
          temporary,
          path: join(directory, `${attachment.assetId}${extension}`),
        });
      }
      if (staged.length === 0) return [];
      const paths = await this.withFileMutation(botId, `attachments:${botId}`, async (tx) => {
        if (
          (await tx.bot.count({
            where: { id: botId, status: { in: ["active", "provisioning"] } },
          })) === 0
        ) {
          return [];
        }
        await mkdir(directory, { recursive: true, mode: 0o755 });
        const paths: string[] = [];
        for (const entry of staged) {
          await rename(entry.temporary, entry.path);
          paths.push(entry.path);
        }
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        return paths;
      });
      for (const entry of staged) {
        if (paths.includes(entry.path)) this.rememberAgentAttachmentPath(entry.assetId, entry.path);
      }
      return paths;
    } finally {
      await Promise.all(
        staged.map(({ temporary }) => rm(temporary, { force: true }).catch(() => undefined))
      );
    }
  }

  async agentAttachmentPath(assetId: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(assetId)) return null;
    const cached = this.agentAttachmentPaths.get(assetId);
    if (cached) {
      const canonical = await this.validAgentAttachmentPath(cached);
      if (canonical) {
        this.rememberAgentAttachmentPath(assetId, cached);
        return canonical;
      }
      this.agentAttachmentPaths.delete(assetId);
    }
    const activeLookup = this.agentAttachmentPathLookups.get(assetId);
    if (activeLookup) return activeLookup;
    const lookup = this.findAgentAttachmentPath(assetId);
    this.agentAttachmentPathLookups.set(assetId, lookup);
    try {
      return await lookup;
    } finally {
      if (this.agentAttachmentPathLookups.get(assetId) === lookup) {
        this.agentAttachmentPathLookups.delete(assetId);
      }
    }
  }

  private async findAgentAttachmentPath(assetId: string): Promise<string | null> {
    const agentsRoot = join(this.root, "agents");
    for (const agentId of await listDirectories(agentsRoot)) {
      const attachments = join(agentsRoot, agentId, "attachments");
      const match = (await readdir(attachments).catch(() => []))
        .filter((name) => name.startsWith(`${assetId}.`))
        .sort()[0];
      if (!match) continue;
      const candidate = join(attachments, match);
      const canonical = await this.validAgentAttachmentPath(candidate);
      if (canonical) {
        this.rememberAgentAttachmentPath(assetId, candidate);
        return canonical;
      }
    }
    return null;
  }

  private async validAgentAttachmentPath(candidate: string): Promise<string | null> {
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical) return null;
    const attachments = dirname(candidate);
    const canonicalRoot = await realpath(attachments).catch(() => attachments);
    return this.isInside(canonical, canonicalRoot) ? canonical : null;
  }

  private rememberAgentAttachmentPath(assetId: string, candidate: string): void {
    this.agentAttachmentPaths.delete(assetId);
    this.agentAttachmentPaths.set(assetId, candidate);
    while (this.agentAttachmentPaths.size > MAX_AGENT_ATTACHMENT_PATH_CACHE_ENTRIES) {
      const oldest = this.agentAttachmentPaths.keys().next().value;
      if (oldest === undefined) break;
      this.agentAttachmentPaths.delete(oldest);
    }
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

export { memoryLogicalId, renderSkillFile, slugify };
