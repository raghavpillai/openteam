import type { BotView } from "@openbot/contracts";
import { GROUP_MEMBER_LIMIT, toggleBoundedSelection } from "@openbot/product-core/selection";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { router } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMark } from "../src/components/bot-mark";
import { IconButton } from "../src/components/icon-button";
import {
  BOT_ROSTER_SEARCH_THRESHOLD,
  filterBotRoster,
  MOBILE_VIRTUAL_LIST_TUNING,
} from "../src/list-scale";
import { useOpenBot } from "../src/state/openbot-context";
import { metrics, useTheme } from "../src/theme";

type CreationMode = "bot" | "group";

interface MemberRowProps {
  bot: BotView;
  first: boolean;
  last: boolean;
  selected: boolean;
  onToggle: (botId: string) => void;
}

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
        first && styles.memberFirst,
        last && styles.memberLast,
      ]}
    >
      <BotMark color={bot.color} icon={bot.icon} size={38} />
      <Text numberOfLines={1} style={[styles.memberName, { color: theme.text }]}>
        {bot.name}
      </Text>
      <View
        style={[
          styles.check,
          {
            backgroundColor: selected ? theme.text : "transparent",
            borderColor: selected ? theme.text : theme.textFaint,
          },
        ]}
      >
        {selected ? <Text style={[styles.checkmark, { color: theme.background }]}>✓</Text> : null}
      </View>
    </Pressable>
  );
});

export default function NewConversationScreen() {
  const theme = useTheme();
  const { snapshot, createBot, createGroup, isFixture } = useOpenBot();
  const [mode, setMode] = useState<CreationMode>("bot");
  const [name, setName] = useState("");
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [botQuery, setBotQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availableBots = useMemo(
    () => snapshot.bots.filter((bot) => bot.status !== "archived" && !bot.hiddenFromSidebar),
    [snapshot.bots]
  );
  const filteredBots = useMemo(
    () => filterBotRoster(availableBots, botQuery),
    [availableBots, botQuery]
  );
  const selectedBotIdSet = useMemo(() => new Set(selectedBotIds), [selectedBotIds]);
  const canCreate =
    !creating && name.trim().length > 0 && (mode === "bot" || selectedBotIds.length > 0);
  const showStickyCreateAction =
    mode === "group" && availableBots.length > BOT_ROSTER_SEARCH_THRESHOLD;

  const toggleBot = useCallback((botId: string) => {
    setSelectedBotIds((current) => [
      ...toggleBoundedSelection(current, botId, { max: GROUP_MEMBER_LIMIT }),
    ]);
  }, []);

  const submit = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const channelId =
        mode === "bot" ? await createBot(name) : await createGroup(name, selectedBotIds);
      router.replace({ pathname: "/chat/[channelId]", params: { channelId } });
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not create this conversation."));
    } finally {
      setCreating(false);
    }
  };

  const renderMember = useCallback(
    ({ item, index }: { item: BotView; index: number }) => (
      <MemberRow
        bot={item}
        first={index === 0}
        last={index === filteredBots.length - 1}
        selected={selectedBotIdSet.has(item.id)}
        onToggle={toggleBot}
      />
    ),
    [filteredBots.length, selectedBotIdSet, toggleBot]
  );

  const footer = (
    <>
      {isFixture ? (
        <Text style={[styles.warning, { color: theme.textMuted }]}>
          Connect a server in Settings before creating conversations.
        </Text>
      ) : null}
      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

      <Pressable
        accessibilityRole="button"
        disabled={!canCreate}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.create,
          { backgroundColor: theme.text },
          pressed && styles.pressed,
          !canCreate && styles.disabled,
        ]}
      >
        {creating ? (
          <ActivityIndicator color={theme.background} />
        ) : (
          <Text style={[styles.createLabel, { color: theme.background }]}>Create {mode}</Text>
        )}
      </Pressable>
    </>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safe}
      >
        <View style={styles.header}>
          <IconButton
            label="Cancel"
            name="xmark"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
            size={38}
            symbolSize={17}
            tone="surface"
          />
          <Text style={[styles.headerTitle, { color: theme.text }]}>New</Text>
          <View style={styles.headerSpacer} />
        </View>

        <FlatList
          data={mode === "group" ? filteredBots : []}
          extraData={selectedBotIds}
          keyExtractor={(bot) => bot.id}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={renderMember}
          style={styles.list}
          {...MOBILE_VIRTUAL_LIST_TUNING}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <>
              <View style={[styles.segment, { backgroundColor: theme.surface }]}>
                {(["bot", "group"] as const).map((candidate) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: mode === candidate }}
                    key={candidate}
                    onPress={() => {
                      setMode(candidate);
                      setError(null);
                    }}
                    style={[
                      styles.segmentButton,
                      mode === candidate && { backgroundColor: theme.surfaceElevated },
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentLabel,
                        { color: mode === candidate ? theme.text : theme.textMuted },
                      ]}
                    >
                      {candidate === "bot" ? "Bot" : "Group"}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[styles.eyebrow, { color: theme.textMuted }]}>NAME</Text>
              <TextInput
                autoFocus
                maxLength={80}
                onChangeText={setName}
                onSubmitEditing={() => void submit()}
                placeholder={mode === "bot" ? "Research Bot" : "Launch team"}
                placeholderTextColor={theme.textFaint}
                returnKeyType={mode === "bot" ? "done" : "next"}
                style={[
                  styles.field,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={name}
              />

              {mode === "group" ? (
                <>
                  <View style={styles.memberHeading}>
                    <Text style={[styles.eyebrow, { color: theme.textMuted }]}>MEMBERS</Text>
                    <Text style={[styles.count, { color: theme.textFaint }]}>
                      {selectedBotIds.length}/{GROUP_MEMBER_LIMIT}
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
              ) : (
                <Text style={[styles.explanation, { color: theme.textMuted }]}>
                  A new Bot gets its own conversation and shared computer.
                </Text>
              )}
            </>
          }
          ListEmptyComponent={
            mode === "group" ? (
              <Text
                style={[
                  styles.empty,
                  {
                    backgroundColor: theme.surfaceElevated,
                    borderColor: theme.border,
                    color: theme.textMuted,
                  },
                ]}
              >
                {availableBots.length === 0 ? "Create a Bot first." : "No Bots match this search."}
              </Text>
            ) : null
          }
          ListFooterComponent={showStickyCreateAction ? null : footer}
        />
        {showStickyCreateAction ? (
          <View
            style={[
              styles.actionSurface,
              { backgroundColor: theme.background, borderColor: theme.separator },
            ]}
          >
            {footer}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  content: { paddingHorizontal: metrics.pageGutter, paddingTop: 20, paddingBottom: 40 },
  list: { flex: 1 },
  actionSurface: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: metrics.pageGutter,
    paddingBottom: 8,
  },
  segment: { flexDirection: "row", borderRadius: 13, padding: 3, marginBottom: 28 },
  segmentButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600", textTransform: "capitalize" },
  eyebrow: { marginLeft: 4, marginBottom: 8, fontSize: 11, lineHeight: 14, fontWeight: "600" },
  field: {
    minHeight: 48,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 15,
    fontSize: 16,
  },
  explanation: { marginTop: 12, marginHorizontal: 4, fontSize: 13, lineHeight: 18 },
  memberHeading: { marginTop: 28, flexDirection: "row", justifyContent: "space-between" },
  count: { marginRight: 4, fontSize: 11, lineHeight: 14 },
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
  memberFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  memberLast: { borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  memberName: { flex: 1, fontSize: 15, lineHeight: 19, fontWeight: "500" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkmark: { fontSize: 14, lineHeight: 16, fontWeight: "700" },
  empty: {
    padding: 18,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    textAlign: "center",
    fontSize: 14,
  },
  warning: { marginTop: 22, textAlign: "center", fontSize: 12, lineHeight: 17 },
  error: { marginTop: 16, textAlign: "center", fontSize: 13, lineHeight: 18 },
  create: {
    minHeight: 48,
    marginTop: 24,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  createLabel: { fontSize: 15, lineHeight: 19, fontWeight: "700", textTransform: "capitalize" },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.38 },
});
