import type { MobileChannelRow } from "@openbot/client-core";
import type { ChannelMessageView } from "@openbot/contracts";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMark } from "../src/components/bot-mark";
import { GlassSurface } from "../src/components/glass-surface";
import { IconButton } from "../src/components/icon-button";
import { useOpenBot } from "../src/state/openbot-context";
import { useTheme } from "../src/theme";

type SearchItem =
  | { kind: "conversation"; id: string; row: MobileChannelRow }
  | {
      kind: "message";
      id: string;
      message: ChannelMessageView;
      row: MobileChannelRow;
    };

const includesQuery = (value: string | null | undefined, query: string) =>
  value?.toLocaleLowerCase().includes(query) ?? false;

export default function SearchScreen() {
  const theme = useTheme();
  const { rows, snapshot } = useOpenBot();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const rowsByChannel = useMemo(() => new Map(rows.map((row) => [row.channel.id, row])), [rows]);
  const sections = useMemo(() => {
    const conversations = rows
      .filter(
        (row) =>
          !normalized ||
          [row.bot?.name, row.channel.name, row.latest?.content].some((value) =>
            includesQuery(value, normalized)
          )
      )
      .map<SearchItem>((row) => ({ kind: "conversation", id: row.channel.id, row }));
    const messages = normalized
      ? snapshot.channelMessages.flatMap<SearchItem>((message) => {
          if (!includesQuery(message.content, normalized)) return [];
          const row = rowsByChannel.get(message.channelId);
          return row ? [{ kind: "message", id: message.id, message, row }] : [];
        })
      : [];
    return [
      {
        title: normalized ? "Conversations" : "Recent conversations",
        data: conversations,
      },
      ...(messages.length > 0 ? [{ title: "Messages", data: messages }] : []),
    ].filter((section) => section.data.length > 0);
  }, [normalized, rows, rowsByChannel, snapshot.channelMessages]);

  const open = (item: SearchItem) => {
    router.replace({
      pathname: "/chat/[channelId]",
      params: {
        channelId: item.row.channel.id,
        ...(item.kind === "message" ? { messageId: item.message.id } : {}),
      },
    });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Close search"
          name="chevron.left"
          onPress={() => router.back()}
          symbolSize={18}
          tone="surface"
        />
        <GlassSurface
          fallbackColor={theme.surface}
          interactive
          style={[styles.search, { borderColor: theme.border }]}
        >
          <SymbolView name="magnifyingglass" size={17} tintColor={theme.textMuted} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.textFaint}
            selectionColor={theme.accent}
            style={[styles.input, { color: theme.text }]}
            value={query}
          />
        </GlassSurface>
      </View>

      <SectionList
        contentContainerStyle={styles.results}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => `${item.kind}-${item.id}`}
        sections={sections}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
          >
            <BotMark color={item.row.bot?.color ?? "#858580"} icon={item.row.bot?.icon} size={42} />
            <View style={styles.copy}>
              <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                {item.row.bot?.name ?? item.row.channel.name}
              </Text>
              <Text numberOfLines={2} style={[styles.subtitle, { color: theme.textMuted }]}>
                {item.kind === "message"
                  ? item.message.content
                  : (item.row.latest?.content ?? "No messages yet")}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <SymbolView name="magnifyingglass" size={25} tintColor={theme.textFaint} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No results</Text>
            <Text style={[styles.emptyCopy, { color: theme.textMuted }]}>
              Try a Bot name or a phrase from a message.
            </Text>
          </View>
        }
        stickySectionHeadersEnabled={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    minHeight: 60,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  search: {
    flex: 1,
    height: 42,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  input: { flex: 1, height: 40, paddingVertical: 0, fontSize: 16, lineHeight: 21 },
  results: { paddingHorizontal: 16, paddingBottom: 34 },
  sectionTitle: {
    paddingTop: 17,
    paddingBottom: 7,
    paddingHorizontal: 6,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  row: {
    minHeight: 68,
    borderRadius: 16,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  copy: { flex: 1, gap: 3 },
  title: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  subtitle: { fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { marginTop: 12, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  emptyCopy: { marginTop: 4, textAlign: "center", fontSize: 14, lineHeight: 19 },
});
