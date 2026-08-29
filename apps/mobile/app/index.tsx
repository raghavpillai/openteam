import type { MobileChannelRow } from "@openbot/client-core";
import { router } from "expo-router";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMark } from "../src/components/bot-mark";
import { IconButton } from "../src/components/icon-button";
import { useOpenBot } from "../src/state/openbot-context";
import { metrics, useTheme } from "../src/theme";

const timeLabel = (date: string | undefined): string => {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(date)
  );
};

function ChannelRow({ row }: { row: MobileChannelRow }) {
  const theme = useTheme();
  const name = row.bot?.name ?? row.channel.name;
  const working = Boolean(row.activeRun);
  return (
    <Pressable
      accessibilityLabel={`${name}. ${row.latest?.content ?? "No messages yet"}`}
      accessibilityRole="button"
      onPress={() =>
        router.push({ pathname: "/chat/[channelId]", params: { channelId: row.channel.id } })
      }
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <BotMark color={row.bot?.color ?? "#858580"} icon={row.bot?.icon} size={48} />
      <View style={styles.rowCopy}>
        <View style={styles.rowTitleLine}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
            {name}
          </Text>
          <Text style={[styles.time, { color: theme.textMuted }]}>
            {timeLabel(row.latest?.createdAt)}
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
            {working ? "Working…" : (row.latest?.content ?? "Start a conversation")}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const theme = useTheme();
  const { rows, refreshing, refresh, error, isFixture } = useOpenBot();
  const pinned = rows.slice(0, 3);
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.channel.id}
        renderItem={({ item }) => <ChannelRow row={item} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.textMuted}
          />
        }
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <IconButton
                label="Open settings"
                name="person.fill"
                size={38}
                symbolSize={17}
                tone="surface"
              />
              <View style={styles.headerActions}>
                <IconButton
                  label="Search"
                  name="magnifyingglass"
                  onPress={() => router.push("/search")}
                  size={38}
                  symbolSize={19}
                  tone="surface"
                />
                <IconButton
                  label="New bot or group"
                  name="plus"
                  size={38}
                  symbolSize={20}
                  tone="surface"
                />
              </View>
            </View>

            {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

            <FlatList
              horizontal
              data={pinned}
              keyExtractor={(row) => `pinned-${row.channel.id}`}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pinnedList}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/chat/[channelId]",
                      params: { channelId: item.channel.id },
                    })
                  }
                  style={({ pressed }) => [styles.pinned, pressed && { opacity: 0.7 }]}
                >
                  <BotMark color={item.bot?.color ?? "#858580"} icon={item.bot?.icon} size={68} />
                  <Text numberOfLines={1} style={[styles.pinnedName, { color: theme.text }]}>
                    {item.bot?.name ?? item.channel.name}
                  </Text>
                </Pressable>
              )}
            />
          </>
        }
        ListFooterComponent={
          isFixture ? (
            <Text style={[styles.fixtureNote, { color: theme.textFaint }]}>
              Preview data · connect a trusted OpenBot server for live conversations
            </Text>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { paddingHorizontal: metrics.pageGutter, paddingBottom: 32 },
  header: {
    minHeight: 64,
    paddingTop: 8,
    paddingBottom: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerActions: { flexDirection: "row", gap: 2 },
  error: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  pinnedList: { gap: 8, paddingTop: 8, paddingBottom: 11, paddingRight: 18 },
  pinned: {
    width: 102,
    minHeight: 94,
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 6,
  },
  pinnedName: {
    width: 102,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "500",
  },
  row: {
    minHeight: 70,
    marginHorizontal: -8,
    paddingHorizontal: 8,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  rowCopy: { flex: 1, gap: 4 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { flex: 1, fontSize: 16, lineHeight: 20, fontWeight: "600" },
  time: { fontSize: 12, lineHeight: 16 },
  previewLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  preview: { flex: 1, fontSize: 14, lineHeight: 18 },
  attentionDot: { width: 7, height: 7, borderRadius: 4 },
  workingDot: { width: 7, height: 7, borderRadius: 4 },
  fixtureNote: { paddingTop: 24, textAlign: "center", fontSize: 11, lineHeight: 15 },
});
