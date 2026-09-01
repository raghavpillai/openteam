import type { BotView, RoutineView } from "@openbot/contracts";
import type { BotAvatarShape } from "@openbot/contracts/bot-avatar";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { GROUP_MEMBER_LIMIT, toggleBoundedSelection } from "@openbot/product-core/selection";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMark } from "../../src/components/bot-mark";
import { BotProfileScreen } from "../../src/components/bot-profile-screen";
import { IconButton } from "../../src/components/icon-button";
import { RoutineEditorSheet } from "../../src/components/routine-editor-sheet";
import { TextEditorSheet } from "../../src/components/text-editor-sheet";
import {
  BOT_ROSTER_SEARCH_THRESHOLD,
  filterBotRoster,
  MOBILE_VIRTUAL_LIST_TUNING,
} from "../../src/list-scale";
import {
  clearRoutineNavigation,
  pendingRoutineId,
  routineIdFromPathname,
} from "../../src/routine-route";
import { useOpenBot } from "../../src/state/openbot-context";
import { metrics, useTheme } from "../../src/theme";

const routineDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// UIKit will reject a page-sheet presentation while the native stack is still
// replacing the Search modal. Let that transition settle before opening the
// routine editor so the first presentation is not permanently lost.
const ROUTINE_EDITOR_NAVIGATION_DELAY_MS = 450;

interface RoutineRowProps {
  routine: RoutineView;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onOpen: (routine: RoutineView) => void;
  onToggle: (routine: RoutineView, enabled: boolean) => void;
}

const RoutineRow = memo(function RoutineRow({
  routine,
  first,
  last,
  disabled,
  onOpen,
  onToggle,
}: RoutineRowProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.routine,
        {
          backgroundColor: theme.surfaceElevated,
          borderColor: theme.border,
          borderBottomColor: last ? theme.border : theme.separator,
        },
        first && styles.listRowFirst,
        last && styles.listRowLast,
      ]}
    >
      <Pressable
        accessibilityLabel={`Open ${routine.name} routine`}
        accessibilityRole="button"
        onPress={() => onOpen(routine)}
        style={({ pressed }) => [styles.routineCopy, pressed && styles.pressed]}
      >
        <Text style={[styles.routineName, { color: theme.text }]}>{routine.name}</Text>
        <Text style={[styles.routineSchedule, { color: theme.textMuted }]}>
          {routine.schedule || "Event-triggered"}
          {routine.nextRunAt
            ? ` · Next ${routineDateFormatter.format(new Date(routine.nextRunAt))}`
            : ""}
        </Text>
        <Text numberOfLines={3} style={[styles.routinePrompt, { color: theme.textMuted }]}>
          {routine.prompt}
        </Text>
      </Pressable>
      <Switch
        accessibilityLabel={`${routine.name} active`}
        disabled={disabled}
        onValueChange={(enabled) => onToggle(routine, enabled)}
        trackColor={{ false: theme.surfacePressed, true: theme.text }}
        value={routine.enabled}
      />
    </View>
  );
});

interface MemberRowProps {
  bot: BotView;
  first: boolean;
  last: boolean;
  selected: boolean;
  onToggle: (botId: string) => void;
}

type GroupDetailRow =
  | { kind: "routine"; key: string; routine: RoutineView; index: number }
  | { kind: "empty-routines"; key: string }
  | { kind: "members-heading"; key: string }
  | { kind: "member"; key: string; bot: BotView; index: number }
  | { kind: "empty-members"; key: string };

const MemberRow = memo(function MemberRow({
  bot,
  first,
  last,
  selected,
  onToggle,
}: MemberRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${selected ? "Remove" : "Add"} ${bot.name}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={() => onToggle(bot.id)}
      style={[
        styles.member,
        {
          backgroundColor: theme.surfaceElevated,
          borderColor: theme.border,
          borderBottomColor: last ? theme.border : theme.separator,
        },
        first && styles.listRowFirst,
        last && styles.listRowLast,
      ]}
    >
      <BotMark color={bot.color} icon={bot.icon} size={38} />
      <Text numberOfLines={1} style={[styles.memberName, { color: theme.text }]}>
        {bot.name}
      </Text>
      <Text style={[styles.memberState, { color: selected ? theme.text : theme.textFaint }]}>
        {selected ? "✓" : ""}
      </Text>
    </Pressable>
  );
});

export default function ConversationDetailsScreen() {
  const theme = useTheme();
  const pathname = usePathname();
  const { channelId, routineId } = useLocalSearchParams<{
    channelId: string;
    routineId?: string;
  }>();
  const {
    snapshot,
    updateBot,
    updateChannelProfile,
    setChannelMembers,
    setBotNotifications,
    archiveBot,
    routines: loadRoutines,
    setRoutineEnabled,
  } = useOpenBot();
  const channel = snapshot.channels.find((candidate) => candidate.id === channelId);
  const isBot = channel?.kind === "bot_dm";
  const botId = isBot ? channel.members[0]?.botId : undefined;
  const bot = snapshot.bots.find((candidate) => candidate.id === botId);
  const availableBots = useMemo(
    () => snapshot.bots.filter((candidate) => candidate.status !== "archived"),
    [snapshot.bots]
  );
  const [name, setName] = useState(bot?.name ?? channel?.name ?? "");
  const [title, setTitle] = useState(bot?.title ?? "");
  const [description, setDescription] = useState(bot?.description ?? channel?.description ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(
    channel?.members.map((member) => member.botId) ?? []
  );
  const [botQuery, setBotQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [botRoutines, setBotRoutines] = useState<RoutineView[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [routineMutationId, setRoutineMutationId] = useState<string | null>(null);
  const [routineEditorOpen, setRoutineEditorOpen] = useState(false);
  const [instructionsEditorOpen, setInstructionsEditorOpen] = useState(false);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const handledRoutineDeepLink = useRef<string | null>(null);
  const formDirtyRef = useRef(false);
  const filteredBots = useMemo(
    () => filterBotRoster(availableBots, botQuery),
    [availableBots, botQuery]
  );
  const memberIdSet = useMemo(() => new Set(memberIds), [memberIds]);
  const groupDetailRows = useMemo<GroupDetailRow[]>(() => {
    const rows: GroupDetailRow[] = botRoutines.map((routine, index) => ({
      kind: "routine",
      key: `routine:${routine.id}`,
      routine,
      index,
    }));
    if (botRoutines.length === 0 && !routinesLoading) {
      rows.push({ kind: "empty-routines", key: "empty-routines" });
    }
    rows.push({ kind: "members-heading", key: "members-heading" });
    if (filteredBots.length > 0) {
      rows.push(
        ...filteredBots.map((candidate, index) => ({
          kind: "member" as const,
          key: `member:${candidate.id}`,
          bot: candidate,
          index,
        }))
      );
    } else {
      rows.push({ kind: "empty-members", key: "empty-members" });
    }
    return rows;
  }, [botRoutines, filteredBots, routinesLoading]);

  const formEntityKey = bot ? `bot:${bot.id}` : `channel:${channel?.id ?? channelId}`;
  const authoritativeMemberIds = channel?.members.map((member) => member.botId) ?? [];
  const authoritativeMemberIdsKey = authoritativeMemberIds.join("\0");
  const authoritativeFormRef = useRef({
    name: bot?.name ?? channel?.name ?? "",
    title: bot?.title ?? "",
    description: bot?.description ?? channel?.description ?? "",
    instructions: bot?.instructions ?? "",
    memberIds: authoritativeMemberIds,
  });
  authoritativeFormRef.current = {
    name: bot?.name ?? channel?.name ?? "",
    title: bot?.title ?? "",
    description: bot?.description ?? channel?.description ?? "",
    instructions: bot?.instructions ?? "",
    memberIds: authoritativeMemberIds,
  };
  const previousFormEntityKey = useRef(formEntityKey);

  // Incoming messages and notification changes also advance updatedAt. Reset only for an entity
  // switch or an actual form-field change, and never overwrite an in-progress local edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The ref carries the latest values; these dependencies deliberately trigger form synchronization when server fields change.
  useEffect(() => {
    const entityChanged = previousFormEntityKey.current !== formEntityKey;
    previousFormEntityKey.current = formEntityKey;
    if (!entityChanged && formDirtyRef.current) return;
    const authoritative = authoritativeFormRef.current;
    setName(authoritative.name);
    setTitle(authoritative.title);
    setDescription(authoritative.description);
    setInstructions(authoritative.instructions);
    setMemberIds(authoritative.memberIds);
    formDirtyRef.current = false;
  }, [
    bot?.description,
    bot?.instructions,
    bot?.name,
    bot?.title,
    channel?.description,
    channel?.name,
    authoritativeMemberIdsKey,
    formEntityKey,
  ]);

  const routineOwnerId = botId ?? (channel?.kind === "group" ? channel.id : null);
  const routineOwnerKind = botId ? "bot" : "group";
  useEffect(() => {
    if (!routineOwnerId) {
      setBotRoutines([]);
      return;
    }
    let active = true;
    setRoutinesLoading(true);
    void loadRoutines(routineOwnerId, routineOwnerKind)
      .then((next) => {
        if (active) setBotRoutines(next);
      })
      .catch((cause) => {
        if (active) {
          setError(clientErrorMessage(cause, "OpenBot could not load routines."));
        }
      })
      .finally(() => {
        if (active) setRoutinesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadRoutines, routineOwnerId, routineOwnerKind]);

  useEffect(() => {
    const availableRoutineIds = new Set(botRoutines.map((candidate) => candidate.id));
    const requestedRoutineId =
      routineIdFromPathname(pathname) ??
      (Array.isArray(routineId) ? routineId[0] : routineId) ??
      pendingRoutineId(channelId);
    const targetRoutineId =
      requestedRoutineId && availableRoutineIds.has(requestedRoutineId) ? requestedRoutineId : null;
    if (!targetRoutineId || handledRoutineDeepLink.current === targetRoutineId) {
      return;
    }
    const timer = setTimeout(() => {
      clearRoutineNavigation(channelId, targetRoutineId);
      handledRoutineDeepLink.current = targetRoutineId;
      router.replace({
        pathname: "/routine/[channelId]/[routineId]",
        params: { channelId, routineId: targetRoutineId },
      });
    }, ROUTINE_EDITOR_NAVIGATION_DELAY_MS);
    return () => clearTimeout(timer);
  }, [botRoutines, channelId, pathname, routineId]);

  const toggleRoutine = useCallback(
    async (routine: RoutineView, enabled: boolean) => {
      setRoutineMutationId(routine.id);
      setError(null);
      try {
        const updated = await setRoutineEnabled(routine, enabled);
        setBotRoutines((current) =>
          current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
        );
      } catch (cause) {
        setError(clientErrorMessage(cause, "OpenBot could not update this routine."));
      } finally {
        setRoutineMutationId(null);
      }
    },
    [setRoutineEnabled]
  );

  const toggleMember = useCallback((candidateId: string) => {
    formDirtyRef.current = true;
    setSaved(false);
    setMemberIds((current) => [
      ...toggleBoundedSelection(current, candidateId, { min: 1, max: GROUP_MEMBER_LIMIT }),
    ]);
  }, []);

  const save = async () => {
    if (!channel || !name.trim() || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (bot) {
        await updateBot(bot.id, {
          name: name.trim(),
          title: title.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
        });
      } else {
        if (memberIds.length === 0) throw new Error("A group needs at least one Bot.");
        if (channel.name !== name.trim() || channel.description !== description.trim()) {
          await updateChannelProfile(channel.id, name.trim(), description.trim());
        }
        const previousMembers = channel.members.map((member) => member.botId);
        if (
          previousMembers.length !== memberIds.length ||
          previousMembers.some((id, index) => id !== memberIds[index])
        ) {
          await setChannelMembers(channel.id, memberIds);
        }
      }
      formDirtyRef.current = false;
      setSaved(true);
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not save these changes."));
    } finally {
      setSaving(false);
    }
  };

  const renderRoutine = useCallback(
    ({ item, index }: { item: RoutineView; index: number }) => (
      <RoutineRow
        routine={item}
        first={index === 0}
        last={index === botRoutines.length - 1}
        disabled={routineMutationId === item.id}
        onOpen={(candidate) => {
          setSelectedRoutineId(candidate.id);
          setRoutineEditorOpen(true);
        }}
        onToggle={toggleRoutine}
      />
    ),
    [botRoutines.length, routineMutationId, toggleRoutine]
  );
  const renderMember = useCallback(
    ({ item, index }: { item: BotView; index: number }) => (
      <MemberRow
        bot={item}
        first={index === 0}
        last={index === filteredBots.length - 1}
        selected={memberIdSet.has(item.id)}
        onToggle={toggleMember}
      />
    ),
    [filteredBots.length, memberIdSet, toggleMember]
  );
  const renderGroupDetailRow = useCallback(
    ({ item }: { item: GroupDetailRow }) => {
      if (item.kind === "routine") {
        return renderRoutine({ item: item.routine, index: item.index });
      }
      if (item.kind === "empty-routines") {
        return (
          <Text
            style={[
              styles.emptyRoutines,
              {
                backgroundColor: theme.surfaceElevated,
                borderColor: theme.border,
                color: theme.textMuted,
              },
            ]}
          >
            No routines
          </Text>
        );
      }
      if (item.kind === "members-heading") {
        return (
          <>
            <View style={styles.membersHeading}>
              <Text style={[styles.eyebrow, { color: theme.textMuted }]}>MEMBERS</Text>
              <Text style={[styles.memberCount, { color: theme.textFaint }]}>
                {memberIds.length}/{GROUP_MEMBER_LIMIT}
              </Text>
            </View>
            {availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD ? (
              <TextInput
                accessibilityLabel="Search Bots"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                maxLength={120}
                onChangeText={setBotQuery}
                placeholder="Search Bots"
                placeholderTextColor={theme.textFaint}
                returnKeyType="search"
                style={[
                  styles.search,
                  {
                    backgroundColor: theme.field,
                    borderColor: theme.border,
                    color: theme.text,
                  },
                ]}
                value={botQuery}
              />
            ) : null}
          </>
        );
      }
      if (item.kind === "member") {
        return renderMember({ item: item.bot, index: item.index });
      }
      return (
        <Text
          style={[
            styles.emptyMembers,
            {
              backgroundColor: theme.surfaceElevated,
              borderColor: theme.border,
              color: theme.textMuted,
            },
          ]}
        >
          {availableBots.length === 0 ? "No Bots available" : "No Bots match this search."}
        </Text>
      );
    },
    [
      availableBots.length,
      botQuery,
      memberIds.length,
      renderMember,
      renderRoutine,
      theme.border,
      theme.field,
      theme.surfaceElevated,
      theme.text,
      theme.textFaint,
      theme.textMuted,
    ]
  );

  if (!channel) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={styles.header}>
          <IconButton
            label="Back"
            name="chevron.left"
            onPress={() => router.back()}
            tone="surface"
          />
        </View>
        <Text style={[styles.missing, { color: theme.textMuted }]}>Conversation not found.</Text>
      </SafeAreaView>
    );
  }

  if (bot) {
    const openRoutine = (candidate: RoutineView) => {
      router.push({
        pathname: "/routine/[channelId]/[routineId]",
        params: { channelId, routineId: candidate.id },
      });
    };
    const deleteBot = () =>
      Alert.alert(
        `Delete ${bot.name}?`,
        "This archives the Bot and removes its conversation from every client.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete Bot",
            style: "destructive",
            onPress: () =>
              void archiveBot(bot.id)
                .then(() => router.replace("/"))
                .catch((cause) =>
                  setError(clientErrorMessage(cause, "OpenBot could not delete this Bot."))
                ),
          },
        ]
      );
    const createRoutine = () => {
      setSelectedRoutineId(null);
      setRoutineEditorOpen(true);
    };
    const toggleNotifications = () =>
      void setBotNotifications(bot.id, !bot.notificationsEnabled).catch((cause) =>
        setError(clientErrorMessage(cause, "OpenBot could not update notifications."))
      );
    const openMore = () => {
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [
              bot.notificationsEnabled ? "Turn Off Notifications" : "Turn On Notifications",
              "New Routine",
              "Delete Bot",
              "Cancel",
            ],
            cancelButtonIndex: 3,
            destructiveButtonIndex: 2,
            userInterfaceStyle: theme.dark ? "dark" : "light",
          },
          (index) => {
            if (index === 0) toggleNotifications();
            if (index === 1) createRoutine();
            if (index === 2) deleteBot();
          }
        );
        return;
      }
      Alert.alert(bot.name, undefined, [
        {
          text: bot.notificationsEnabled ? "Turn Off Notifications" : "Turn On Notifications",
          onPress: toggleNotifications,
        },
        { text: "New Routine", onPress: createRoutine },
        { text: "Delete Bot", style: "destructive", onPress: deleteBot },
        { text: "Cancel", style: "cancel" },
      ]);
    };

    return (
      <>
        <BotProfileScreen
          bot={bot}
          error={error}
          onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          onMore={openMore}
          onOpenInstructions={() => setInstructionsEditorOpen(true)}
          onOpenRoutine={openRoutine}
          onSaveIdentity={async (nextName, nextTitle) => {
            setError(null);
            setName(nextName);
            setTitle(nextTitle);
            try {
              await updateBot(bot.id, { name: nextName, title: nextTitle });
              formDirtyRef.current = false;
            } catch (cause) {
              setError(clientErrorMessage(cause, "OpenBot could not save these changes."));
              throw cause;
            }
          }}
          onUpdateAvatar={async (icon: BotAvatarShape, color: string) => {
            setError(null);
            try {
              await updateBot(bot.id, { icon, color });
            } catch (cause) {
              setError(clientErrorMessage(cause, "OpenBot could not update this character."));
              throw cause;
            }
          }}
          routines={botRoutines}
          routinesLoading={routinesLoading}
        />
        <TextEditorSheet
          label="Instructions"
          onClose={() => setInstructionsEditorOpen(false)}
          onSave={async (nextInstructions) => {
            setError(null);
            const normalized = nextInstructions.trim();
            try {
              await updateBot(bot.id, { instructions: normalized });
              setInstructions(normalized);
              formDirtyRef.current = false;
            } catch (cause) {
              setError(clientErrorMessage(cause, "OpenBot could not save these instructions."));
              throw cause;
            }
          }}
          value={instructions}
          visible={instructionsEditorOpen}
        />
        {routineOwnerId && routineEditorOpen ? (
          <RoutineEditorSheet
            onClose={() => setRoutineEditorOpen(false)}
            onDeleted={(deletedRoutineId) =>
              setBotRoutines((current) =>
                current.filter((routine) => routine.id !== deletedRoutineId)
              )
            }
            onSaved={(savedRoutine) => setBotRoutines((current) => [...current, savedRoutine])}
            ownerId={routineOwnerId}
            ownerKind={routineOwnerKind}
            routine={null}
            visible
          />
        ) : null}
      </>
    );
  }

  const showStickySaveAction = !bot && availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD;
  const footer = (
    <>
      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
      {saved ? <Text style={[styles.saved, { color: theme.success }]}>Saved</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!name.trim() || saving}
        onPress={() => void save()}
        style={({ pressed }) => [
          styles.save,
          { backgroundColor: theme.text },
          pressed && styles.pressed,
          (!name.trim() || saving) && styles.disabled,
        ]}
      >
        {saving ? (
          <ActivityIndicator color={theme.background} />
        ) : (
          <Text style={[styles.saveLabel, { color: theme.background }]}>Save changes</Text>
        )}
      </Pressable>
    </>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Back"
          name="chevron.left"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          size={38}
          symbolSize={18}
          tone="surface"
        />
        <Text style={[styles.headerTitle, { color: theme.text }]}>Group details</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList<GroupDetailRow>
        data={groupDetailRows}
        extraData={memberIds}
        keyExtractor={(row) => row.key}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        renderItem={renderGroupDetailRow}
        style={styles.list}
        {...MOBILE_VIRTUAL_LIST_TUNING}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <Field
              label="NAME"
              maxLength={80}
              value={name}
              onChangeText={(value) => {
                formDirtyRef.current = true;
                setName(value);
                setSaved(false);
              }}
            />
            <Field
              label="DESCRIPTION"
              maxLength={2_000}
              multiline
              value={description}
              onChangeText={(value) => {
                formDirtyRef.current = true;
                setDescription(value);
                setSaved(false);
              }}
            />
            <View style={styles.routineHeading}>
              <Text style={[styles.eyebrow, { color: theme.textMuted }]}>ROUTINES</Text>
              <View style={styles.routineHeadingActions}>
                {routinesLoading ? (
                  <ActivityIndicator color={theme.textMuted} size="small" />
                ) : null}
                <Pressable
                  accessibilityLabel="Create group routine"
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedRoutineId(null);
                    setRoutineEditorOpen(true);
                  }}
                  style={({ pressed }) => [styles.routineAdd, pressed && styles.pressed]}
                >
                  <Text style={[styles.routineAddLabel, { color: theme.accent }]}>New</Text>
                </Pressable>
              </View>
            </View>
          </>
        }
        ListFooterComponent={showStickySaveAction ? null : footer}
      />
      {showStickySaveAction ? (
        <View
          style={[
            styles.actionSurface,
            { backgroundColor: theme.background, borderColor: theme.separator },
          ]}
        >
          {footer}
        </View>
      ) : null}
      {routineOwnerId && routineEditorOpen ? (
        <RoutineEditorSheet
          onClose={() => setRoutineEditorOpen(false)}
          onDeleted={(routineId) =>
            setBotRoutines((current) => current.filter((routine) => routine.id !== routineId))
          }
          onSaved={(savedRoutine) =>
            setBotRoutines((current) => {
              const exists = current.some((routine) => routine.id === savedRoutine.id);
              return exists
                ? current.map((routine) =>
                    routine.id === savedRoutine.id ? savedRoutine : routine
                  )
                : [...current, savedRoutine];
            })
          }
          ownerId={routineOwnerId}
          ownerKind={routineOwnerKind}
          routine={
            selectedRoutineId
              ? (botRoutines.find((routine) => routine.id === selectedRoutineId) ?? null)
              : null
          }
          visible
        />
      ) : null}
    </SafeAreaView>
  );
}

function Field({
  label,
  multiline = false,
  tall = false,
  ...props
}: {
  label: string;
  multiline?: boolean;
  tall?: boolean;
  value: string;
  maxLength: number;
  onChangeText: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.fieldGroup}>
      <Text style={[styles.eyebrow, { color: theme.textMuted }]}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        multiline={multiline}
        placeholderTextColor={theme.textFaint}
        style={[
          styles.field,
          multiline && styles.multiline,
          tall && styles.tall,
          { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
        ]}
        textAlignVertical={multiline ? "top" : "center"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    height: 56,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
  headerSpacer: { width: 44 },
  content: { paddingHorizontal: metrics.pageGutter, paddingTop: 18, paddingBottom: 50 },
  list: { flex: 1 },
  actionSurface: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: metrics.pageGutter,
    paddingBottom: 8,
  },
  identity: { alignItems: "center", gap: 9, marginBottom: 28 },
  identityName: { fontSize: 19, lineHeight: 24, fontWeight: "600" },
  fieldGroup: { marginBottom: 20 },
  eyebrow: { marginLeft: 4, marginBottom: 8, fontSize: 11, lineHeight: 14, fontWeight: "600" },
  field: {
    minHeight: 48,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 15,
    fontSize: 15,
  },
  multiline: { minHeight: 92, paddingTop: 13, paddingBottom: 13 },
  tall: { minHeight: 160 },
  setting: {
    minHeight: 68,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  settingCopy: { flex: 1, gap: 2 },
  settingTitle: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  settingDetail: { fontSize: 12, lineHeight: 16 },
  routineHeading: {
    marginTop: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  routineHeadingActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  routineAdd: { minWidth: 44, minHeight: 36, alignItems: "center", justifyContent: "center" },
  routineAddLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  routine: {
    minHeight: 78,
    padding: 14,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  routineCopy: { flex: 1, gap: 3 },
  routineName: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  routineSchedule: { fontSize: 12, lineHeight: 16 },
  routinePrompt: { marginTop: 2, fontSize: 12, lineHeight: 17 },
  emptyRoutines: {
    padding: 18,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    textAlign: "center",
    fontSize: 14,
  },
  membersHeading: { marginTop: 8, flexDirection: "row", justifyContent: "space-between" },
  memberCount: { marginRight: 4, fontSize: 11, lineHeight: 14 },
  search: {
    minHeight: 44,
    marginBottom: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  member: {
    minHeight: 58,
    paddingHorizontal: 13,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  listRowFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  listRowLast: { borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  memberName: { flex: 1, fontSize: 15, lineHeight: 19, fontWeight: "500" },
  memberState: { width: 22, fontSize: 17, lineHeight: 22, textAlign: "center", fontWeight: "700" },
  emptyMembers: {
    padding: 18,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    textAlign: "center",
    fontSize: 14,
  },
  error: { marginTop: 18, textAlign: "center", fontSize: 13, lineHeight: 18 },
  saved: { marginTop: 18, textAlign: "center", fontSize: 13, lineHeight: 18 },
  save: {
    minHeight: 48,
    marginTop: 18,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  saveLabel: { fontSize: 15, lineHeight: 19, fontWeight: "700" },
  delete: { minHeight: 48, marginTop: 12, alignItems: "center", justifyContent: "center" },
  deleteLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.38 },
  missing: { marginTop: 40, textAlign: "center", fontSize: 15 },
});
