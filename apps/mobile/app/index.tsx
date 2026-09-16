import type { BotView, SidebarPreferences } from "@openteam/contracts";
import { toggleSidebarUnread } from "@openteam/contracts/client-preferences";
import { channelMessageSummary } from "@openteam/product-core/channel-events";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import type { ChannelRowProjection } from "@openteam/product-core/snapshot";
import { formatRosterTimestamp } from "@openteam/product-core/timestamps";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "../src/haptics";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { memo, useEffect, useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotAvatar } from "../src/components/bot-avatar";
import {
  ConversationContextMenu,
  type MoveDestination,
} from "../src/components/conversation-context-menu";
import type { OpenTeamAuthUser } from "@openteam/client-core/auth";
import { authenticatedUserForServer } from "../src/auth";
import { accountInitials } from "../src/account-display";
import {
  NativeContextMenu,
  NativeContextMenuHost,
  NativeToolbarButton,
  type NativeMenuAction,
} from "../src/components/native-controls";
import { MOBILE_VIRTUAL_LIST_TUNING, selectPinnedRows } from "../src/list-scale";
import { networkFailureMessage } from "../src/network-error";
import { useOpenTeam } from "../src/state/openteam-context";
import { metrics, useTheme } from "../src/theme";

const timeLabel = formatRosterTimestamp;

type ConversationItem =
  | { kind: "channel"; row: ChannelRowProjection }
  | { kind: "empty"; id: string };

interface ConversationSection {
  collapsed: boolean;
  data: ConversationItem[];
  id: string | null;
  itemCount: number;
  title: string;
}

interface ChannelRowProps {
  botById: ReadonlyMap<string, BotView>;
  menuJSON: string;
  onMenuAction: (row: ChannelRowProjection, id: string) => void;
  manualUnread: boolean;
  onHide: (row: ChannelRowProjection) => void;
  onLongPress: (row: ChannelRowProjection) => void;
  onTogglePinned: (channelId: string) => void;
  pinned: boolean;
  row: ChannelRowProjection;
  selected: boolean;
}

const sameVisibleRow = (left: ChannelRowProjection, right: ChannelRowProjection): boolean =>
  left.channel.id === right.channel.id &&
  left.channel.name === right.channel.name &&
  left.channel.createdAt === right.channel.createdAt &&
  left.channel.unreadCount === right.channel.unreadCount &&
  left.bot?.id === right.bot?.id &&
  left.bot?.name === right.bot?.name &&
  left.bot?.title === right.bot?.title &&
  left.bot?.color === right.bot?.color &&
  left.bot?.icon === right.bot?.icon &&
  left.bot?.hasAvatar === right.bot?.hasAvatar &&
  left.bot?.updatedAt === right.bot?.updatedAt &&
  left.latest?.id === right.latest?.id &&
  left.latest?.content === right.latest?.content &&
  left.latest?.createdAt === right.latest?.createdAt &&
  Boolean(left.activeRun) === Boolean(right.activeRun) &&
  left.hasApproval === right.hasApproval;

function ConversationMark({
  botById,
  row,
}: {
  botById: ReadonlyMap<string, BotView>;
  row: ChannelRowProjection;
}) {
  if (row.bot) return <BotAvatar bot={row.bot} size={48} />;
  const members = row.channel.members
    .map((member) => botById.get(member.botId))
    .filter((bot): bot is BotView => Boolean(bot))
    .slice(0, 2);
  if (members.length < 2) {
    const member = members[0];
    return <BotAvatar bot={member} color={member?.color ?? "#858580"} size={48} />;
  }
  return (
    <View style={styles.groupMark}>
      <View style={styles.groupMarkBack}>
        <BotAvatar bot={members[0]} size={34} />
      </View>
      <View style={styles.groupMarkFront}>
        <BotAvatar bot={members[1]} size={34} />
      </View>
    </View>
  );
}

function SwipeAction({
  color,
  icon,
  label,
  onPress,
  swipeable,
}: {
  color: string;
  icon: "pin.fill" | "eye.slash";
  label: string;
  onPress: () => void;
  swipeable: SwipeableMethods;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={() => {
        swipeable.close();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.swipeCircle,
        { backgroundColor: color },
        pressed && { opacity: 0.72, transform: [{ scale: 0.94 }] },
      ]}
    >
      <SymbolView name={icon} size={18} tintColor="#fff" weight="semibold" />
    </Pressable>
  );
}

const ChannelRow = memo(function ChannelRow({
  botById,
  menuJSON,
  onMenuAction,
  manualUnread,
  onHide,
  onLongPress,
  onTogglePinned,
  pinned,
  row,
  selected,
}: ChannelRowProps) {
  const theme = useTheme();
  const swipeableRef = useRef<SwipeableMethods>(null);
  const name = row.bot?.name ?? row.channel.name;
  const working = Boolean(row.activeRun);
  const unreadCount = row.channel.unreadCount ?? 0;
  const unread = unreadCount > 0 || manualUnread;
  const accessibilityStatus = [
    unread
      ? `${Math.max(1, unreadCount)} unread ${Math.max(1, unreadCount) === 1 ? "message" : "messages"}`
      : "No unread messages",
    working ? "Working" : null,
    row.hasApproval ? "Approval required" : null,
    row.latest ? channelMessageSummary(row.latest) : "No messages yet",
  ]
    .filter((value): value is string => value !== null)
    .join(". ");

  const renderRightActions = useCallback(
    (_progress: unknown, _translation: unknown, swipeable: SwipeableMethods) => (
      <View style={styles.swipeActions}>
        <SwipeAction
          color="#505055"
          icon="pin.fill"
          label={pinned ? "Unpin conversation" : "Pin conversation"}
          onPress={() => onTogglePinned(row.channel.id)}
          swipeable={swipeable}
        />
        <SwipeAction
          color="#ff4654"
          icon="eye.slash"
          label="Hide conversation"
          onPress={() => onHide(row)}
          swipeable={swipeable}
        />
      </View>
    ),
    [onHide, onTogglePinned, pinned, row]
  );

  return (
    <ReanimatedSwipeable
      friction={1.6}
      overshootRight={false}
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={48}
    >
      <NativeContextMenuHost
        accessible={Boolean(NativeContextMenu)}
        accessibilityLabel={`${name}. ${accessibilityStatus}`}
        onActivate={() =>
          router.push({ pathname: "/chat/[channelId]", params: { channelId: row.channel.id } })
        }
        dark={theme.dark}
        menuJSON={menuJSON}
        onAction={({ nativeEvent }) => onMenuAction(row, nativeEvent.id)}
      >
        <Pressable
          accessible={!NativeContextMenu}
          accessibilityElementsHidden={Boolean(NativeContextMenu)}
          accessibilityLabel={`${name}. ${accessibilityStatus}`}
          accessibilityActions={[
            { name: "showMenu", label: "Show conversation menu" },
            { name: "showSwipeActions", label: "Show swipe actions" },
          ]}
          accessibilityRole="button"
          accessibilityState={{ busy: working }}
          delayLongPress={320}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "showMenu") onLongPress(row);
            if (nativeEvent.actionName === "showSwipeActions") swipeableRef.current?.openRight();
          }}
          onLongPress={NativeContextMenu ? undefined : () => onLongPress(row)}
          onPress={() =>
            router.push({ pathname: "/chat/[channelId]", params: { channelId: row.channel.id } })
          }
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: selected ? theme.surfacePressed : theme.background,
            },
            pressed && { backgroundColor: theme.surface },
          ]}
        >
          <ConversationMark botById={botById} row={row} />
          <View style={styles.rowCopy}>
            <View style={styles.rowTitleLine}>
              <Text
                numberOfLines={1}
                style={[styles.rowTitle, unread && styles.rowTitleUnread, { color: theme.text }]}
              >
                {name}
              </Text>
              {row.bot?.title ? (
                <View style={[styles.titlePill, { backgroundColor: theme.surface }]}>
                  <Text
                    numberOfLines={1}
                    style={[styles.titlePillText, { color: theme.textMuted }]}
                  >
                    {row.bot.title}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.time, { color: theme.textFaint }]}>
                {timeLabel(row.latest?.createdAt ?? row.channel.createdAt)}
              </Text>
            </View>
            <View style={styles.previewLine}>
              {row.hasApproval ? (
                <View style={[styles.attentionDot, { backgroundColor: theme.danger }]} />
              ) : null}
              {working ? (
                <View style={[styles.workingDot, { backgroundColor: theme.success }]} />
              ) : null}
              <Text numberOfLines={1} style={[styles.preview, { color: theme.textMuted }]}>
                {working ? "Working…" : row.latest ? channelMessageSummary(row.latest) : ""}
              </Text>
              {unread ? <View style={styles.unreadDot} /> : null}
            </View>
          </View>
        </Pressable>
      </NativeContextMenuHost>
    </ReanimatedSwipeable>
  );
}, areChannelRowPropsEqual);

function areChannelRowPropsEqual(previous: ChannelRowProps, next: ChannelRowProps): boolean {
  return (
    previous.botById === next.botById &&
    previous.menuJSON === next.menuJSON &&
    previous.onMenuAction === next.onMenuAction &&
    previous.manualUnread === next.manualUnread &&
    previous.pinned === next.pinned &&
    previous.selected === next.selected &&
    previous.onTogglePinned === next.onTogglePinned &&
    previous.onLongPress === next.onLongPress &&
    previous.onHide === next.onHide &&
    sameVisibleRow(previous.row, next.row)
  );
}

const reorderedPreferences = (
  preferences: SidebarPreferences,
  channelId: string,
  sectionId: string | null
): SidebarPreferences => {
  const sectionByChannel = { ...preferences.sectionByChannel };
  if (sectionId) sectionByChannel[channelId] = sectionId;
  else delete sectionByChannel[channelId];
  const channelOrderByGroup = Object.fromEntries(
    Object.entries(preferences.channelOrderByGroup).map(([key, ids]) => [
      key,
      ids.filter((id) => id !== channelId),
    ])
  );
  const groupKey = sectionId ?? "unassigned";
  channelOrderByGroup[groupKey] = [...(channelOrderByGroup[groupKey] ?? []), channelId];
  return { ...preferences, sectionByChannel, channelOrderByGroup };
};

export default function HomeScreen() {
  const theme = useTheme();
  const {
    connection,
    archiveBot,
    deleteGroup,
    duplicateBot,
    error,
    isFixture,
    loading,
    refresh,
    refreshing,
    rows,
    setBotHidden,
    setChannelHidden,
    sidebarPreferences,
    snapshot,
    togglePinned,
    updateSidebarPreferences,
  } = useOpenTeam();
  const [account, setAccount] = useState<OpenTeamAuthUser | null>(null);
  useEffect(() => {
    let active = true;
    setAccount(null);
    void authenticatedUserForServer(connection.serverUrl)
      .then((user) => {
        if (active) setAccount(user);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connection.serverUrl]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionRow, setActionRow] = useState<ChannelRowProjection | null>(null);
  const openConversationMenu = useCallback((row: ChannelRowProjection) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionRow(row);
  }, []);
  const duplicatingBotIds = useRef(new Set<string>());
  const pinnedIds = sidebarPreferences.pinnedIds;
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const unreadIdSet = useMemo(
    () => new Set(sidebarPreferences.unreadIds),
    [sidebarPreferences.unreadIds]
  );
  const botById = useMemo(
    () => new Map(snapshot.bots.map((bot) => [bot.id, bot])),
    [snapshot.bots]
  );
  const pinned = useMemo(() => selectPinnedRows(rows, pinnedIds), [pinnedIds, rows]);
  const pinRank = useMemo(
    () => new Map(pinned.map((row, index) => [row.channel.id, index])),
    [pinned]
  );

  const perform = useCallback(async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setActionError(clientErrorMessage(cause, "OpenTeam could not update this conversation."));
    }
  }, []);

  const sortRows = useCallback(
    (items: ChannelRowProjection[]) =>
      [...items].sort((left, right) => {
        const leftRank = pinRank.get(left.channel.id);
        const rightRank = pinRank.get(right.channel.id);
        if (leftRank !== undefined || rightRank !== undefined) {
          if (leftRank === undefined) return 1;
          if (rightRank === undefined) return -1;
          return leftRank - rightRank;
        }
        return rows.indexOf(left) - rows.indexOf(right);
      }),
    [pinRank, rows]
  );

  const sections = useMemo<ConversationSection[]>(() => {
    const validSectionIds = new Set(sidebarPreferences.sections.map((section) => section.id));
    const assigned = new Map<string, ChannelRowProjection[]>();
    const unassigned: ChannelRowProjection[] = [];
    for (const row of rows) {
      const sectionId = sidebarPreferences.sectionByChannel[row.channel.id];
      if (!sectionId || !validSectionIds.has(sectionId)) {
        unassigned.push(row);
        continue;
      }
      const current = assigned.get(sectionId);
      if (current) current.push(row);
      else assigned.set(sectionId, [row]);
    }
    const mapped = sidebarPreferences.sections.map<ConversationSection>((section) => {
      const sectionRows = sortRows(assigned.get(section.id) ?? []);
      return {
        collapsed: section.collapsed,
        data: section.collapsed
          ? []
          : sectionRows.length
            ? sectionRows.map((row) => ({ kind: "channel" as const, row }))
            : [{ kind: "empty" as const, id: section.id }],
        id: section.id,
        itemCount: sectionRows.length,
        title: section.name,
      };
    });
    return [
      ...mapped,
      {
        collapsed: sidebarPreferences.unassignedCollapsed,
        data: sidebarPreferences.unassignedCollapsed
          ? []
          : sortRows(unassigned).map((row) => ({
              kind: "channel" as const,
              row,
            })),
        id: null,
        itemCount: unassigned.length,
        title: "Unassigned",
      },
    ];
  }, [rows, sidebarPreferences, sortRows]);

  const moveDestinations = useMemo<MoveDestination[]>(
    () => [
      ...sidebarPreferences.sections.map((section) => ({
        id: section.id,
        name: section.name,
      })),
      { id: null, name: "Unassigned" },
    ],
    [sidebarPreferences.sections]
  );

  const handleTogglePinned = useCallback(
    (channelId: string) => void perform(() => togglePinned(channelId)),
    [perform, togglePinned]
  );
  const handleHide = useCallback(
    (row: ChannelRowProjection) => {
      void perform(() =>
        row.bot ? setBotHidden(row.bot.id, true) : setChannelHidden(row.channel.id, true)
      );
    },
    [perform, setBotHidden, setChannelHidden]
  );
  const handleToggleUnread = useCallback(
    (channelId: string) =>
      void perform(() =>
        updateSidebarPreferences(toggleSidebarUnread(sidebarPreferences, channelId))
      ),
    [perform, sidebarPreferences, updateSidebarPreferences]
  );
  const handleMove = useCallback(
    (channelId: string, sectionId: string | null) =>
      void perform(() =>
        updateSidebarPreferences(reorderedPreferences(sidebarPreferences, channelId, sectionId))
      ),
    [perform, sidebarPreferences, updateSidebarPreferences]
  );
  const handleNewSection = useCallback(
    (row: ChannelRowProjection) => {
      Alert.prompt("New Section", "Name this section", (value) => {
        const name = value?.trim();
        if (!name) return;
        const id = `section-${Date.now().toString(36)}`;
        const next: SidebarPreferences = reorderedPreferences(
          {
            ...sidebarPreferences,
            sections: [...sidebarPreferences.sections, { id, name, collapsed: false }],
          },
          row.channel.id,
          id
        );
        void perform(() => updateSidebarPreferences(next));
      });
    },
    [perform, sidebarPreferences, updateSidebarPreferences]
  );
  const handleDuplicate = useCallback(
    (row: ChannelRowProjection) => {
      const botId = row.bot?.id;
      if (!botId || duplicatingBotIds.current.has(botId)) return;
      duplicatingBotIds.current.add(botId);
      void perform(async () => {
        try {
          const channelId = await duplicateBot(botId);
          router.push({ pathname: "/chat/[channelId]", params: { channelId } });
        } finally {
          duplicatingBotIds.current.delete(botId);
        }
      });
    },
    [duplicateBot, perform]
  );
  const handleDelete = useCallback(
    (row: ChannelRowProjection) => {
      const name = row.bot?.name ?? row.channel.name;
      Alert.alert(`Delete ${name}?`, "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void perform(() => (row.bot ? archiveBot(row.bot.id) : deleteGroup(row.channel.id))),
        },
      ]);
    },
    [archiveBot, deleteGroup, perform]
  );
  const toggleSection = useCallback(
    (section: ConversationSection) => {
      const next = section.id
        ? {
            ...sidebarPreferences,
            sections: sidebarPreferences.sections.map((candidate) =>
              candidate.id === section.id
                ? { ...candidate, collapsed: !candidate.collapsed }
                : candidate
            ),
          }
        : {
            ...sidebarPreferences,
            unassignedCollapsed: !sidebarPreferences.unassignedCollapsed,
          };
      void perform(() => updateSidebarPreferences(next));
    },
    [perform, sidebarPreferences, updateSidebarPreferences]
  );
  const openCreation = useCallback((mode: "bot" | "group") => {
    router.push({ pathname: "/new", params: { mode } });
  }, []);

  const handleMenuAction = useCallback(
    (row: ChannelRowProjection, id: string) => {
      if (id === "unread") handleToggleUnread(row.channel.id);
      else if (id === "pin") handleTogglePinned(row.channel.id);
      else if (id === "hide") handleHide(row);
      else if (id === "duplicate") handleDuplicate(row);
      else if (id === "copy") void Clipboard.setStringAsync(row.channel.id);
      else if (id === "delete") handleDelete(row);
      else if (id === "new-section") handleNewSection(row);
      else if (id.startsWith("move:")) handleMove(row.channel.id, id.slice(5) || null);
      else if (id === "siri")
        Alert.alert(
          "Ask Siri",
          "Add OpenTeam actions from the Shortcuts app to use them with Siri."
        );
    },
    [
      handleToggleUnread,
      handleTogglePinned,
      handleHide,
      handleDuplicate,
      handleDelete,
      handleNewSection,
      handleMove,
    ]
  );
  const menus = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          row.channel.id,
          JSON.stringify([
            {
              id: "unread",
              title:
                unreadIdSet.has(row.channel.id) || (row.channel.unreadCount ?? 0) > 0
                  ? "Mark Read"
                  : "Mark Unread",
              symbol: "bubble.left",
            },
            { id: "pin", title: pinnedIdSet.has(row.channel.id) ? "Unpin" : "Pin", symbol: "pin" },
            {
              id: "move",
              title: "Move to",
              symbol: "folder",
              children: [
                ...moveDestinations.map((destination) => ({
                  id: `move:${destination.id ?? ""}`,
                  title: destination.name,
                  selected:
                    (sidebarPreferences.sectionByChannel[row.channel.id] ?? null) ===
                    destination.id,
                })),
                { id: "new-section", title: "New Section", symbol: "folder.badge.plus" },
              ],
            },
            { id: "hide", title: "Hide", symbol: "eye.slash", destructive: true },
            {
              id: "more",
              title: "More",
              symbol: "ellipsis",
              children: [
                ...(row.bot
                  ? [{ id: "duplicate", title: "Duplicate", symbol: "plus.square.on.square" }]
                  : []),
                { id: "copy", title: "Copy ID", symbol: "doc.on.doc" },
                { id: "delete", title: "Delete", symbol: "trash", destructive: true },
              ],
            },
            {
              id: "system",
              title: "",
              inline: true,
              children: [{ id: "siri", title: "Ask Siri", symbol: "apple.intelligence" }],
            },
          ] as NativeMenuAction[]),
        ])
      ),
    [rows, unreadIdSet, pinnedIdSet, moveDestinations, sidebarPreferences.sectionByChannel]
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationItem }) => {
      if (item.kind === "empty") {
        return <Text style={[styles.emptySection, { color: theme.textFaint }]}>No chats</Text>;
      }
      return (
        <ChannelRow
          botById={botById}
          menuJSON={menus.get(item.row.channel.id) ?? "[]"}
          onMenuAction={handleMenuAction}
          manualUnread={unreadIdSet.has(item.row.channel.id)}
          onHide={handleHide}
          onLongPress={openConversationMenu}
          onTogglePinned={handleTogglePinned}
          pinned={pinnedIdSet.has(item.row.channel.id)}
          row={item.row}
          selected={actionRow?.channel.id === item.row.channel.id}
        />
      );
    },
    [
      actionRow?.channel.id,
      menus,
      handleMenuAction,
      botById,
      handleHide,
      handleTogglePinned,
      openConversationMenu,
      pinnedIdSet,
      theme.textFaint,
      unreadIdSet,
    ]
  );

  const activeSectionId = actionRow
    ? (sidebarPreferences.sectionByChannel[actionRow.channel.id] ?? null)
    : null;

  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.safe, { backgroundColor: theme.background }]}
    >
      <View style={styles.header}>
        <NativeToolbarButton
          label="Open settings"
          name="person.crop.circle"
          onPress={() => router.push("/settings")}
          symbolSize={22}
          initials={accountInitials(account)}
        />
        <View style={styles.statusTitle}>
          {loading || refreshing ? (
            <>
              <ActivityIndicator color={theme.textMuted} size="small" />
              <Text style={[styles.statusText, { color: theme.textMuted }]}>Loading</Text>
            </>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          <NativeToolbarButton
            label="Search"
            name="magnifyingglass"
            onPress={() => router.push("/search")}
          />
          <NativeToolbarButton
            label="New bot or group chat"
            name="plus"
            actions={[
              { id: "bot", title: "New Bot" },
              { id: "group", title: "New Group Chat" },
            ]}
            onAction={(id) => {
              if (id === "bot" || id === "group") openCreation(id);
            }}
          />
        </View>
      </View>

      <SectionList
        {...MOBILE_VIRTUAL_LIST_TUNING}
        contentContainerStyle={styles.content}
        keyExtractor={(item) =>
          item.kind === "channel" ? item.row.channel.id : `empty-${item.id}`
        }
        refreshControl={
          <RefreshControl
            onRefresh={() => void refresh()}
            refreshing={refreshing}
            tintColor={theme.textMuted}
          />
        }
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Pressable
            accessibilityLabel={`${section.title} section`}
            accessibilityRole="button"
            onPress={() => toggleSection(section)}
            style={styles.sectionHeader}
          >
            <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>
              {section.collapsed ? `${section.title} ${section.itemCount}` : section.title}
            </Text>
            <SymbolView
              name={section.collapsed ? "chevron.right" : "chevron.down"}
              size={11}
              tintColor={theme.textFaint}
              weight="medium"
            />
          </Pressable>
        )}
        sections={sections}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          error || actionError ? (
            <>
              {error ? (
                <Text style={[styles.error, { color: theme.danger }]}>
                  {networkFailureMessage(error) ?? error}
                </Text>
              ) : null}
              {actionError ? (
                <Text style={[styles.error, { color: theme.danger }]}>{actionError}</Text>
              ) : null}
            </>
          ) : null
        }
        ListFooterComponent={
          isFixture ? (
            <Text style={[styles.fixtureNote, { color: theme.textFaint }]}>Preview data</Text>
          ) : null
        }
      />

      {actionRow ? (
        <ConversationContextMenu
          currentSectionId={activeSectionId}
          isPinned={pinnedIdSet.has(actionRow.channel.id)}
          isUnread={unreadIdSet.has(actionRow.channel.id)}
          moveDestinations={moveDestinations}
          onAskSiri={() =>
            Alert.alert(
              "Ask Siri",
              "Add OpenTeam actions from the Shortcuts app to use them with Siri."
            )
          }
          onClose={() => setActionRow(null)}
          onCopyId={() => void Clipboard.setStringAsync(actionRow.channel.id)}
          onDelete={() => handleDelete(actionRow)}
          onDuplicate={actionRow.bot ? () => handleDuplicate(actionRow) : undefined}
          onHide={() => handleHide(actionRow)}
          onMove={(sectionId) => handleMove(actionRow.channel.id, sectionId)}
          onNewSection={() => handleNewSection(actionRow)}
          onTogglePinned={() => handleTogglePinned(actionRow.channel.id)}
          onToggleUnread={() => handleToggleUnread(actionRow.channel.id)}
          visible
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { paddingHorizontal: metrics.pageGutter, paddingBottom: 32 },
  header: {
    height: 54,
    marginHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  statusTitle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingLeft: 6,
  },
  statusText: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  headerActions: { flexDirection: "row", gap: 4 },
  error: { fontSize: 13, lineHeight: 18, marginBottom: 8 },
  sectionHeader: {
    height: 48,
    paddingTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  sectionTitle: { fontSize: 14, lineHeight: 19, fontWeight: "400" },
  emptySection: { height: 36, fontSize: 14, lineHeight: 19, paddingTop: 2 },
  row: {
    minHeight: 80,
    marginHorizontal: -4,
    paddingHorizontal: 4,
    borderRadius: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  groupMark: { width: 48, height: 48 },
  groupMarkBack: { position: "absolute", left: 1, top: 1 },
  groupMarkFront: { position: "absolute", right: 0, bottom: 0 },
  rowCopy: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowTitle: { flexShrink: 1, fontSize: 17, lineHeight: 20, fontWeight: "500" },
  rowTitleUnread: { fontWeight: "500" },
  titlePill: {
    maxWidth: 70,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  titlePillText: { fontSize: 11, lineHeight: 14, fontWeight: "500" },
  time: { marginLeft: "auto", fontSize: 13, lineHeight: 16 },
  previewLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  preview: { flex: 1, fontSize: 15, lineHeight: 18 },
  attentionDot: { width: 7, height: 7, borderRadius: 4 },
  workingDot: { width: 7, height: 7, borderRadius: 4 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 2, backgroundColor: "#0A84FF" },
  swipeActions: {
    width: 108,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    paddingRight: 2,
  },
  swipeCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  fixtureNote: {
    paddingTop: 24,
    textAlign: "center",
    fontSize: 11,
    lineHeight: 15,
  },
});
