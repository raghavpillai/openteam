import {
  addSidebarUnread,
  emptySidebarPreferences,
  normalizeSidebarPreferences,
  removeSidebarUnread,
  toggleSidebarPinned,
  toggleSidebarUnread,
  type SidebarPreferences,
  type SidebarSectionPreference,
} from "@openteam/contracts/client-preferences";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../client/openteam-api";

const STORAGE_KEY = "openteam:sidebar-preferences";
const REMOTE_SAVE_DELAY_MS = 250;

export const PINNED_GROUP_ID = "__pinned";
export const UNASSIGNED_GROUP_ID = "__unassigned";

export type SidebarSection = SidebarSectionPreference;
export type { SidebarPreferences } from "@openteam/contracts/client-preferences";

const EMPTY_PREFERENCES = emptySidebarPreferences();

function readPreferences(input?: unknown): SidebarPreferences {
  try {
    const value =
      input === undefined
        ? (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown)
        : input;
    return normalizeSidebarPreferences(value, EMPTY_PREFERENCES);
  } catch {
    return EMPTY_PREFERENCES;
  }
}

const withoutChannel = (orders: Record<string, string[]>, channelId: string) =>
  Object.fromEntries(
    Object.entries(orders).map(([groupId, ids]) => [groupId, ids.filter((id) => id !== channelId)])
  );

export function useSidebarPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const pendingRemote = useRef<SidebarPreferences | null>(null);
  const remoteTimer = useRef<number | null>(null);
  const remoteSaving = useRef(false);
  const localRevision = useRef(0);

  const drainRemote = useCallback(async () => {
    if (remoteSaving.current) return;
    remoteSaving.current = true;
    try {
      while (pendingRemote.current) {
        const next = pendingRemote.current;
        pendingRemote.current = null;
        await api.updateSidebarPreferences(next).catch(() => undefined);
      }
    } finally {
      remoteSaving.current = false;
    }
  }, []);

  const scheduleRemote = useCallback(
    (next: SidebarPreferences) => {
      pendingRemote.current = next;
      if (remoteTimer.current !== null) window.clearTimeout(remoteTimer.current);
      remoteTimer.current = window.setTimeout(() => {
        remoteTimer.current = null;
        void drainRemote();
      }, REMOTE_SAVE_DELAY_MS);
    },
    [drainRemote]
  );

  useEffect(() => {
    let cancelled = false;
    const revisionAtStart = localRevision.current;
    void api
      .rootSettings()
      .then((result) => {
        if (cancelled || localRevision.current !== revisionAtStart) return;
        if (result.valid && result.settings.sidebarPreferences) {
          const remote = readPreferences(result.settings.sidebarPreferences);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
          setPreferences(remote);
          return;
        }
        setPreferences((current) => {
          scheduleRemote(current);
          return current;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scheduleRemote]);

  useEffect(
    () => () => {
      if (remoteTimer.current !== null) window.clearTimeout(remoteTimer.current);
      const final = pendingRemote.current;
      pendingRemote.current = null;
      if (final) void api.updateSidebarPreferences(final).catch(() => undefined);
    },
    []
  );

  const update = useCallback(
    (change: (current: SidebarPreferences) => SidebarPreferences) => {
      setPreferences((current) => {
        const next = change(current);
        if (next === current) return current;
        localRevision.current += 1;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        scheduleRemote(next);
        return next;
      });
    },
    [scheduleRemote]
  );

  const togglePinned = useCallback(
    (channelId: string) => {
      update((current) => toggleSidebarPinned(current, channelId));
    },
    [update]
  );

  const toggleUnread = useCallback(
    (channelId: string) => {
      update((current) => toggleSidebarUnread(current, channelId));
    },
    [update]
  );

  const markRead = useCallback(
    (channelId: string) => {
      update((current) => removeSidebarUnread(current, [channelId]));
    },
    [update]
  );

  const markReadMany = useCallback(
    (channelIds: Iterable<string>) => update((current) => removeSidebarUnread(current, channelIds)),
    [update]
  );

  const markUnread = useCallback(
    (channelId: string) => {
      update((current) => addSidebarUnread(current, [channelId]));
    },
    [update]
  );

  const markUnreadMany = useCallback(
    (channelIds: Iterable<string>) => update((current) => addSidebarUnread(current, channelIds)),
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
      markReadMany,
      markUnread,
      markUnreadMany,
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
      markReadMany,
      markUnread,
      markUnreadMany,
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
