export interface SidebarSectionPreference {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface SidebarPreferences {
  version: 2;
  pinnedIds: string[];
  unreadIds: string[];
  unassignedCollapsed: boolean;
  sections: SidebarSectionPreference[];
  sectionByChannel: Record<string, string>;
  channelOrderByGroup: Record<string, string[]>;
}

export interface LegacyRootSidebarSection {
  id: string;
  name: string;
  agentIds: string[];
  isCollapsed: boolean;
}

export interface RootSettingsView {
  settings: {
    sidebarPreferences?: SidebarPreferences;
    pinnedAgentIds?: string[];
    sidebarSections?: LegacyRootSidebarSection[];
  };
  valid: boolean;
  error?: string;
}

const record = (input: unknown, label: string): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
};

const strings = (input: unknown, label: string): string[] => {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...new Set(input)];
};

export const emptySidebarPreferences = (): SidebarPreferences => ({
  version: 2,
  pinnedIds: [],
  unreadIds: [],
  unassignedCollapsed: false,
  sections: [],
  sectionByChannel: {},
  channelOrderByGroup: {},
});

export const toggleSidebarPinned = (
  preferences: SidebarPreferences,
  channelId: string
): SidebarPreferences => ({
  ...preferences,
  pinnedIds: preferences.pinnedIds.includes(channelId)
    ? preferences.pinnedIds.filter((id) => id !== channelId)
    : [...preferences.pinnedIds, channelId],
});

export const addSidebarUnread = <T extends { unreadIds: string[] }>(
  preferences: T,
  channelIds: Iterable<string>
): T => {
  const unread = new Set(preferences.unreadIds);
  const before = unread.size;
  for (const channelId of channelIds) unread.add(channelId);
  return unread.size === before ? preferences : { ...preferences, unreadIds: [...unread] };
};

export const removeSidebarUnread = <T extends { unreadIds: string[] }>(
  preferences: T,
  channelIds: Iterable<string>
): T => {
  const removed = new Set(channelIds);
  if (!preferences.unreadIds.some((channelId) => removed.has(channelId))) return preferences;
  return {
    ...preferences,
    unreadIds: preferences.unreadIds.filter((channelId) => !removed.has(channelId)),
  };
};

export const toggleSidebarUnread = (
  preferences: SidebarPreferences,
  channelId: string
): SidebarPreferences =>
  preferences.unreadIds.includes(channelId)
    ? removeSidebarUnread(preferences, [channelId])
    : addSidebarUnread(preferences, [channelId]);

/** Strict parser for the persisted/API representation. */
export const parseSidebarPreferences = (input: unknown): SidebarPreferences => {
  if (input === undefined) return emptySidebarPreferences();
  const value = record(input, "sidebarPreferences");
  if (value.version !== 2) throw new Error("sidebarPreferences.version must be 2");
  if (!Array.isArray(value.sections)) {
    throw new Error("sidebarPreferences.sections must be an array");
  }
  const sections = value.sections.map((inputSection) => {
    const section = record(inputSection, "sidebar section");
    if (
      typeof section.id !== "string" ||
      typeof section.name !== "string" ||
      typeof section.collapsed !== "boolean"
    ) {
      throw new Error("sidebar section requires string id/name and boolean collapsed");
    }
    return { id: section.id, name: section.name, collapsed: section.collapsed };
  });
  const sectionByChannel = record(value.sectionByChannel, "sectionByChannel");
  if (Object.values(sectionByChannel).some((item) => typeof item !== "string")) {
    throw new Error("sectionByChannel values must be strings");
  }
  const channelOrderByGroup = record(value.channelOrderByGroup, "channelOrderByGroup");
  if (
    Object.values(channelOrderByGroup).some(
      (item) => !Array.isArray(item) || item.some((id) => typeof id !== "string")
    )
  ) {
    throw new Error("channelOrderByGroup values must be string arrays");
  }
  return {
    version: 2,
    pinnedIds: strings(value.pinnedIds, "sidebarPreferences.pinnedIds"),
    unreadIds: strings(value.unreadIds, "sidebarPreferences.unreadIds"),
    unassignedCollapsed: value.unassignedCollapsed === true,
    sections,
    sectionByChannel: sectionByChannel as Record<string, string>,
    channelOrderByGroup: channelOrderByGroup as Record<string, string[]>,
  };
};

/** Lenient client-side normalization, including the pre-v2 name-based format. */
export const normalizeSidebarPreferences = (
  input: unknown,
  fallback = emptySidebarPreferences()
): SidebarPreferences => {
  try {
    return parseSidebarPreferences(input);
  } catch {
    if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
    const value = input as Record<string, unknown>;
    const pinnedIds = Array.isArray(value.pinnedIds)
      ? value.pinnedIds.filter((item): item is string => typeof item === "string")
      : [];
    const unreadIds = Array.isArray(value.unreadIds)
      ? value.unreadIds.filter((item): item is string => typeof item === "string")
      : [];
    const mapping =
      value.sectionByChannel &&
      typeof value.sectionByChannel === "object" &&
      !Array.isArray(value.sectionByChannel)
        ? Object.fromEntries(
            Object.entries(value.sectionByChannel).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : {};
    const names = [...new Set(Object.values(mapping))];
    const sections = names.map((name, index) => ({
      id: `legacy-section-${index}`,
      name,
      collapsed: false,
    }));
    const idByName = new Map(sections.map((section) => [section.name, section.id]));
    return {
      version: 2,
      pinnedIds: [...new Set(pinnedIds)],
      unreadIds: [...new Set(unreadIds)],
      unassignedCollapsed: value.unassignedCollapsed === true,
      sections,
      sectionByChannel: Object.fromEntries(
        Object.entries(mapping).flatMap(([channelId, name]) => {
          const sectionId = idByName.get(name);
          return sectionId ? [[channelId, sectionId]] : [];
        })
      ),
      channelOrderByGroup: {},
    };
  }
};

export const sidebarPreferencesFromRootSettings = (
  root: RootSettingsView,
  fallback: SidebarPreferences
): SidebarPreferences | null => {
  if (!root.valid) return null;
  if (root.settings.sidebarPreferences) {
    return normalizeSidebarPreferences(root.settings.sidebarPreferences, fallback);
  }
  const pinnedIds = root.settings.pinnedAgentIds;
  const sidebarSections = root.settings.sidebarSections;
  if (!pinnedIds && !sidebarSections) return null;
  const sections = (sidebarSections ?? []).map((section) => ({
    id: section.id,
    name: section.name,
    collapsed: section.isCollapsed,
  }));
  return {
    ...fallback,
    pinnedIds: pinnedIds ?? [],
    sections,
    sectionByChannel: Object.fromEntries(
      (sidebarSections ?? []).flatMap((section) =>
        section.agentIds.map((channelId) => [channelId, section.id] as const)
      )
    ),
  };
};
