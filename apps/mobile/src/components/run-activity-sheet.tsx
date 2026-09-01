import type { BotView, RunItemView, RunView, SubagentActivityView } from "@openbot/contracts";
import { activityContentSummary, activityRows } from "@openbot/product-core/activity";
import { useMemo } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MOBILE_VIRTUAL_LIST_TUNING } from "../list-scale";
import { useTheme } from "../theme";

const activityDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function RunActivitySheet({
  bots,
  items,
  onClose,
  runs,
  subagents,
  truncated,
  visible,
}: {
  bots: readonly BotView[];
  items: readonly RunItemView[];
  onClose: () => void;
  runs: readonly RunView[];
  subagents: readonly SubagentActivityView[];
  truncated?: boolean;
  visible: boolean;
}) {
  const theme = useTheme();
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name] as const)), [bots]);
  const rows = useMemo(() => activityRows(runs, items, subagents), [items, runs, subagents]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <View style={styles.headerSide} />
          <Text style={[styles.headerTitle, { color: theme.text }]}>Run activity</Text>
          <Pressable
            accessible
            accessibilityLabel="Close run activity"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.headerSide}
          >
            <Text style={[styles.done, { color: theme.accent }]}>Done</Text>
          </Pressable>
        </View>
        <FlatList
          {...MOBILE_VIRTUAL_LIST_TUNING}
          contentContainerStyle={styles.content}
          data={rows}
          keyExtractor={(row) => row.key}
          ListEmptyComponent={
            <Text style={[styles.emptyPage, { color: theme.textMuted }]}>No run activity yet.</Text>
          }
          ListHeaderComponent={
            truncated ? (
              <Text
                style={[styles.notice, { backgroundColor: theme.surface, color: theme.textMuted }]}
              >
                Older activity is available on the server but omitted from this bounded mobile view.
              </Text>
            ) : null
          }
          renderItem={({ item: row, index }) => {
            if (row.type === "run") {
              const { run, itemCount } = row;
              return (
                <View
                  style={[
                    styles.runHeader,
                    index > 0 && styles.sectionGap,
                    itemCount === 0 && styles.runHeaderOnly,
                    { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                  ]}
                >
                  <View style={styles.titleLine}>
                    <View style={styles.flex}>
                      <Text style={[styles.runTitle, { color: theme.text }]}>
                        {botNames.get(run.botId) ?? "Bot"} · {run.origin.replace("_", " ")}
                      </Text>
                      <Text style={[styles.date, { color: theme.textMuted }]}>
                        {activityDate.format(new Date(run.createdAt))}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.status,
                        {
                          color:
                            run.status === "completed"
                              ? theme.success
                              : run.status === "failed"
                                ? theme.danger
                                : theme.textMuted,
                        },
                      ]}
                    >
                      {run.status.replace("_", " ")}
                    </Text>
                  </View>
                  {itemCount === 0 ? (
                    <Text style={[styles.empty, { color: theme.textMuted }]}>
                      No detailed events
                    </Text>
                  ) : null}
                </View>
              );
            }
            if (row.type === "item") {
              const summary = activityContentSummary(row.item.content);
              return (
                <View
                  style={[
                    styles.item,
                    row.last && styles.lastItem,
                    {
                      backgroundColor: theme.surfaceElevated,
                      borderColor: theme.border,
                      borderTopColor: theme.separator,
                    },
                  ]}
                >
                  <View style={styles.titleLine}>
                    <Text style={[styles.itemTitle, { color: theme.text }]}>
                      {row.item.title || row.item.kind.replaceAll("_", " ")}
                    </Text>
                    <Text style={[styles.itemStatus, { color: theme.textMuted }]}>
                      {row.item.status.replaceAll("_", " ")}
                    </Text>
                  </View>
                  <Text style={[styles.itemKind, { color: theme.textFaint }]}>
                    {row.item.kind.replaceAll("_", " ")}
                  </Text>
                  {summary ? (
                    <Text
                      selectable
                      style={[
                        styles.itemContent,
                        { backgroundColor: theme.surface, color: theme.textMuted },
                      ]}
                    >
                      {summary}
                    </Text>
                  ) : null}
                </View>
              );
            }
            if (row.type === "tasks") {
              return <Text style={[styles.eyebrow, { color: theme.textMuted }]}>ASYNC TASKS</Text>;
            }
            return (
              <View
                style={[
                  styles.taskCard,
                  { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                ]}
              >
                <View style={styles.titleLine}>
                  <Text style={[styles.itemTitle, { color: theme.text }]}>
                    {row.subagent.description}
                  </Text>
                  <Text style={[styles.itemStatus, { color: theme.textMuted }]}>
                    {row.subagent.status}
                  </Text>
                </View>
                <Text style={[styles.itemKind, { color: theme.textFaint }]}>
                  {row.subagent.subagentType.replaceAll("_", " ")}
                  {row.subagent.runInBackground ? " · background" : ""}
                </Text>
                {row.subagent.summary || row.subagent.errorMessage ? (
                  <Text style={[styles.taskSummary, { color: theme.textMuted }]}>
                    {row.subagent.summary || row.subagent.errorMessage}
                  </Text>
                ) : null}
              </View>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    minHeight: 58,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerSide: { width: 72, minHeight: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 16, lineHeight: 21, fontWeight: "700" },
  done: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  content: { padding: 18, paddingBottom: 50 },
  notice: { borderRadius: 14, padding: 12, marginBottom: 12, fontSize: 12, lineHeight: 17 },
  runHeader: {
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 14,
    gap: 7,
  },
  runHeaderOnly: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  sectionGap: { marginTop: 12 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 10 },
  runTitle: { fontSize: 14, lineHeight: 19, fontWeight: "700", textTransform: "capitalize" },
  date: { fontSize: 10, lineHeight: 14 },
  status: { fontSize: 11, lineHeight: 15, fontWeight: "600", textTransform: "capitalize" },
  item: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 3,
  },
  lastItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    paddingBottom: 14,
  },
  itemTitle: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  itemStatus: { fontSize: 10, lineHeight: 14, textTransform: "capitalize" },
  itemKind: { fontSize: 10, lineHeight: 14, textTransform: "capitalize" },
  itemContent: { marginTop: 5, borderRadius: 11, padding: 10, fontSize: 11, lineHeight: 16 },
  empty: { paddingTop: 6, fontSize: 12, lineHeight: 17 },
  eyebrow: {
    marginTop: 22,
    marginBottom: 12,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    letterSpacing: 0.7,
  },
  taskCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 13,
    marginBottom: 12,
    gap: 3,
  },
  taskSummary: { marginTop: 4, fontSize: 12, lineHeight: 17 },
  emptyPage: { paddingVertical: 40, textAlign: "center", fontSize: 14, lineHeight: 20 },
});
