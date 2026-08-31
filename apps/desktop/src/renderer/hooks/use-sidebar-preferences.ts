import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../client/openbot-api";

const STORAGE_KEY = "openbot:sidebar-preferences";

export const PINNED_GROUP_ID = "__pinned";
export const UNASSIGNED_GROUP_ID = "__unassigned";

export type SidebarSection = {
  id: string;
  name: string;
  collapsed: boolean;
};

export type SidebarPreferences = {
  version: 2;
  pinnedIds: string[];
  unreadIds: string[];
  unassignedCollapsed: boolean;
  sections: SidebarSection[];
  sectionByChannel: Record<string, string>;
  channelOrderByGroup: Record<string, string[]>;
};

const EMPTY_PREFERENCES: SidebarPreferences = {
  version: 2,
  pinnedIds: [],
  unreadIds: [],
  unassignedCollapsed: false,
  sections: [],
  sectionByChannel: {},
  channelOrderByGroup: {},
};

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const stringRecord = (value: unknown) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};

function readPreferences(input?: unknown): SidebarPreferences {
  try {
    const value =
      input === undefined
        ? (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown)
        : input;
    if (!value || typeof value !== "object") return EMPTY_PREFERENCES;
    const record = value as Record<string, unknown>;
    const pinnedIds = stringArray(record.pinnedIds);
    const unreadIds = stringArray(record.unreadIds);
    const storedMapping = stringRecord(record.sectionByChannel);

    if (record.version === 2 && Array.isArray(record.sections)) {
      const sections = record.sections.flatMap((section) => {
        if (!section || typeof section !== "object") return [];
        const candidate = section as Record<string, unknown>;
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
        return [
          {
            id: candidate.id,
            name: candidate.name,
            collapsed: candidate.collapsed === true,
          },
        ];
      });
      const sectionIds = new Set(sections.map((section) => section.id));
      const channelOrderByGroup =
        record.channelOrderByGroup && typeof record.channelOrderByGroup === "object"
          ? Object.fromEntries(
              Object.entries(record.channelOrderByGroup).map(([groupId, ids]) => [
                groupId,
                stringArray(ids),
              ])
            )
          : {};
      return {
        version: 2,
        pinnedIds,
        unreadIds,
        unassignedCollapsed: record.unassignedCollapsed === true,
        sections,
        sectionByChannel: Object.fromEntries(
          Object.entries(storedMapping).filter(([, sectionId]) => sectionIds.has(sectionId))
        ),
        channelOrderByGroup,
      };
    }

    const legacyNames = Array.from(new Set(Object.values(storedMapping)));
    const sections = legacyNames.map((name, index) => ({
      id: `legacy-section-${index}`,
      name,
      collapsed: false,
    }));
    const idByName = new Map(sections.map((section) => [section.name, section.id]));
    return {
      version: 2,
      pinnedIds,
      unreadIds,
      unassignedCollapsed: false,
      sections,
      sectionByChannel: Object.fromEntries(
        Object.entries(storedMapping).map(([channelId, name]) => [channelId, idByName.get(name)!])
      ),
      channelOrderByGroup: {},
    };
  } catch {
    return EMPTY_PREFERENCES;
  }
}

const withoutChannel = (orders: Record<string, string[]>, channelId: string) =>
  Object.fromEntries(
    Object.entries(orders).map(([groupId, ids]) => [groupId, ids.filter((id) => id !== channelId)])
  );

const withHostSettings = (
  local: SidebarPreferences,
  settings: {
    pinnedAgentIds?: string[];
    sidebarSections?: Array<{
      id: string;
      name: string;
      agentIds: string[];
      isCollapsed: boolean;
    }>;
  }
): SidebarPreferences => {
  const hostSections = settings.sidebarSections
    ?.filter((section) => section.id !== "__agents__")
    .map((section) => ({
      id: section.id,
      name: section.name,
      collapsed: section.isCollapsed,
    }));
  const hostSectionIds = new Set(hostSections?.map((section) => section.id) ?? []);
  return {
    ...local,
    ...(settings.pinnedAgentIds ? { pinnedIds: stringArray(settings.pinnedAgentIds) } : {}),
    ...(hostSections
      ? {
          sections: hostSections,
          sectionByChannel: Object.fromEntries(
            (settings.sidebarSections ?? []).flatMap((section) =>
              section.id === "__agents__" || !hostSectionIds.has(section.id)
                ? []
                : section.agentIds.map((agentId) => [agentId, section.id])
            )
          ),
        }
      : {}),
  };
};

export function useSidebarPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);

  useEffect(() => {
    let cancelled = false;
    void api
      .rootSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.valid) {
          const remote = withHostSettings(readPreferences(), result.settings);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
          setPreferences(remote);
          return;
        }
        setPreferences((current) => {
          void api.updateSidebarPreferences(current).catch(() => undefined);
          return current;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((change: (current: SidebarPreferences) => SidebarPreferences) => {
    setPreferences((current) => {
      const next = change(current);
      if (next === current) return current;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      void api.updateSidebarPreferences(next).catch(() => undefined);
      return next;
    });
  }, []);

  const togglePinned = useCallback(
    (channelId: string) => {
      update((current) => ({
        ...current,
        pinnedIds: current.pinnedIds.includes(channelId)
          ? current.pinnedIds.filter((id) => id !== channelId)
          : [...current.pinnedIds, channelId],
      }));
    },
    [update]
  );

  const toggleUnread = useCallback(
    (channelId: string) => {
      update((current) => ({
        ...current,
        unreadIds: current.unreadIds.includes(channelId)
          ? current.unreadIds.filter((id) => id !== channelId)
          : [...current.unreadIds, channelId],
      }));
    },
    [update]
  );

  const markRead = useCallback(
    (channelId: string) => {
      update((current) =>
        current.unreadIds.includes(channelId)
          ? {
              ...current,
              unreadIds: current.unreadIds.filter((id) => id !== channelId),
            }
          : current
      );
    },
    [update]
  );

  const markUnread = useCallback(
    (channelId: string) => {
      update((current) =>
        current.unreadIds.includes(channelId)
          ? current
          : { ...current, unreadIds: [...current.unreadIds, channelId] }
      );
    },
    [update]
  );

  const moveToSection = useCallback(
    (channelId: string, sectionId: string | null) => {
      update((current) => {
        const sectionByChannel = { ...current.sectionByChannel };
        if (sectionId) sectionByChannel[channelId] = sectionId;
        else delete sectionByChannel[channelId];
        const targetGroup = sectionId ?? UNASSIGNED_GROUP_ID;
        const channelOrderByGroup = withoutChannel(current.channelOrderByGroup, channelId);
        channelOrderByGroup[targetGroup] = [...(channelOrderByGroup[targetGroup] ?? []), channelId];
        return {
          ...current,
          pinnedIds: current.pinnedIds.filter((id) => id !== channelId),
          sectionByChannel,
          channelOrderByGroup,
        };
      });
    },
    [update]
  );

  const createSection = useCallback(
    (channelId?: string) => {
      const section: SidebarSection = {
        id: crypto.randomUUID(),
        name: "New section",
        collapsed: false,
      };
      update((current) => ({
        ...current,
        sections: [...current.sections, section],
        pinnedIds: channelId
          ? current.pinnedIds.filter((id) => id !== channelId)
          : current.pinnedIds,
        sectionByChannel: channelId
          ? { ...current.sectionByChannel, [channelId]: section.id }
          : current.sectionByChannel,
        channelOrderByGroup: channelId
          ? {
              ...withoutChannel(current.channelOrderByGroup, channelId),
              [section.id]: [channelId],
            }
          : current.channelOrderByGroup,
      }));
      return section.id;
    },
    [update]
  );

  const renameSection = useCallback(
    (sectionId: string, name: string) => {
      const trimmed = name.trim().slice(0, 48);
      if (!trimmed) return;
      update((current) => ({
        ...current,
        sections: current.sections.map((section) =>
          section.id === sectionId ? { ...section, name: trimmed } : section
        ),
      }));
    },
    [update]
  );

  const toggleSection = useCallback(
    (sectionId: string) => {
      update((current) => ({
        ...current,
        sections: current.sections.map((section) =>
          section.id === sectionId ? { ...section, collapsed: !section.collapsed } : section
        ),
      }));
    },
    [update]
  );

  const toggleUnassigned = useCallback(() => {
    update((current) => ({
      ...current,
      unassignedCollapsed: !current.unassignedCollapsed,
    }));
  }, [update]);

  const deleteSection = useCallback(
    (sectionId: string) => {
      update((current) => {
        const sectionChannels = Object.entries(current.sectionByChannel)
          .filter(([, currentSectionId]) => currentSectionId === sectionId)
          .map(([channelId]) => channelId);
        const sectionByChannel = Object.fromEntries(
          Object.entries(current.sectionByChannel).filter(
            ([, currentSectionId]) => currentSectionId !== sectionId
          )
        );
        const channelOrderByGroup = { ...current.channelOrderByGroup };
        delete channelOrderByGroup[sectionId];
        channelOrderByGroup[UNASSIGNED_GROUP_ID] = Array.from(
          new Set([...(channelOrderByGroup[UNASSIGNED_GROUP_ID] ?? []), ...sectionChannels])
        );
        return {
          ...current,
          sections: current.sections.filter((section) => section.id !== sectionId),
          sectionByChannel,
          channelOrderByGroup,
        };
      });
    },
    [update]
  );

  const moveSection = useCallback(
    (sectionId: string, direction: -1 | 1) => {
      update((current) => {
        const from = current.sections.findIndex((section) => section.id === sectionId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= current.sections.length) return current;
        const sections = [...current.sections];
        const [section] = sections.splice(from, 1);
        sections.splice(to, 0, section!);
        return { ...current, sections };
      });
    },
    [update]
  );

  const reorderSection = useCallback(
    (initialIndex: number, index: number) => {
      update((current) => {
        if (initialIndex === index) return current;
        const sections = [...current.sections];
        const [section] = sections.splice(initialIndex, 1);
        if (!section) return current;
        sections.splice(index, 0, section);
        return { ...current, sections };
      });
    },
    [update]
  );

  const moveChannel = useCallback(
    (input: { channelId: string; group: string }) => {
      update((current) => {
        const sectionByChannel = { ...current.sectionByChannel };
        if (input.group === UNASSIGNED_GROUP_ID) delete sectionByChannel[input.channelId];
        else if (input.group !== PINNED_GROUP_ID) sectionByChannel[input.channelId] = input.group;

        const pinnedIds = current.pinnedIds.filter((id) => id !== input.channelId);
        if (input.group === PINNED_GROUP_ID) pinnedIds.push(input.channelId);
        return {
          ...current,
          channelOrderByGroup: withoutChannel(current.channelOrderByGroup, input.channelId),
          sectionByChannel,
          pinnedIds,
        };
      });
    },
    [update]
  );

  const pinnedIds = useMemo(() => new Set(preferences.pinnedIds), [preferences.pinnedIds]);
  const unreadIds = useMemo(() => new Set(preferences.unreadIds), [preferences.unreadIds]);

  return useMemo(
    () => ({
      createSection,
      deleteSection,
      markRead,
      markUnread,
      moveChannel,
      moveSection,
      moveToSection,
      pinnedIds,
      renameSection,
      reorderSection,
      sectionByChannel: preferences.sectionByChannel,
      sections: preferences.sections,
      togglePinned,
      toggleSection,
      toggleUnassigned,
      toggleUnread,
      unassignedCollapsed: preferences.unassignedCollapsed,
      unreadIds,
    }),
    [
      createSection,
      deleteSection,
      markRead,
      markUnread,
      moveChannel,
      moveSection,
      moveToSection,
      pinnedIds,
      preferences.sectionByChannel,
      preferences.sections,
      renameSection,
      reorderSection,
      togglePinned,
      toggleSection,
      toggleUnassigned,
      toggleUnread,
      preferences.unassignedCollapsed,
      unreadIds,
    ]
  );
}

export type SidebarPreferencesController = ReturnType<typeof useSidebarPreferences>;
