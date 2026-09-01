import type { RoutineExecutionView, RoutineView } from "@openbot/contracts";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import {
  describeRoutineCronSchedule as describeRoutineSchedule,
  formatRoutineExecutionCalendarTime as formatRoutineExecutionTime,
  routineExecutionStatusPresentation as routineExecutionStatus,
} from "@openbot/product-core/routines";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconButton } from "../../../src/components/icon-button";
import { RoutineEditorSheet } from "../../../src/components/routine-editor-sheet";
import { TextEditorSheet } from "../../../src/components/text-editor-sheet";
import { useOpenBot } from "../../../src/state/openbot-context";
import { useTheme } from "../../../src/theme";

function HistoryRow({ execution }: { execution: RoutineExecutionView }) {
  const theme = useTheme();
  const status = routineExecutionStatus(execution.status);
  const statusColor =
    status.tone === "success"
      ? theme.dark
        ? "#3ca66f"
        : theme.success
      : status.tone === "danger"
        ? theme.danger
        : theme.textMuted;
  return (
    <View
      style={[
        styles.historyRow,
        { backgroundColor: theme.dark ? "#1e1e1e" : theme.surfaceElevated },
      ]}
    >
      <Text numberOfLines={1} style={[styles.cardText, styles.historyTime, { color: theme.text }]}>
        {formatRoutineExecutionTime(execution)}
      </Text>
      <Text numberOfLines={1} style={[styles.cardText, { color: statusColor }]}>
        {status.label}
      </Text>
    </View>
  );
}

export default function RoutineDetailScreen() {
  const theme = useTheme();
  const canvas = theme.dark ? "#111111" : theme.background;
  const panel = theme.dark ? "#1e1e1e" : theme.surfaceElevated;
  const { routineId } = useLocalSearchParams<{ channelId: string; routineId: string }>();
  const {
    routine: loadRoutine,
    routineExecutions,
    setRoutineEnabled,
    updateRoutine,
  } = useOpenBot();
  const [routine, setRoutine] = useState<RoutineView | null>(null);
  const [executions, setExecutions] = useState<RoutineExecutionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instructionEditorOpen, setInstructionEditorOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRoutine, nextExecutions] = await Promise.all([
        loadRoutine(routineId),
        routineExecutions(routineId, 20),
      ]);
      setRoutine(nextRoutine);
      setExecutions(nextExecutions);
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not load this routine."));
    } finally {
      setLoading(false);
    }
  }, [loadRoutine, routineExecutions, routineId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEnabled = async (enabled: boolean) => {
    if (!routine || mutating) return;
    const previous = routine;
    setRoutine({ ...routine, enabled });
    setMutating(true);
    setError(null);
    try {
      setRoutine(await setRoutineEnabled(previous, enabled));
    } catch (cause) {
      setRoutine(previous);
      setError(clientErrorMessage(cause, "OpenBot could not update this routine."));
    } finally {
      setMutating(false);
    }
  };

  if (loading && !routine) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: canvas }]}>
        <View style={styles.loadingHeader}>
          <IconButton
            label="Back"
            name="chevron.left"
            onPress={() => router.back()}
            size={40}
            symbolSize={19}
            tone="surface"
          />
        </View>
        <ActivityIndicator color={theme.textMuted} style={styles.loader} />
      </SafeAreaView>
    );
  }

  if (!routine) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: canvas }]}>
        <View style={styles.loadingHeader}>
          <IconButton
            label="Back"
            name="chevron.left"
            onPress={() => router.back()}
            size={40}
            symbolSize={19}
            tone="surface"
          />
        </View>
        <Text style={[styles.missing, { color: theme.textMuted }]}>
          {error ?? "Routine not found."}
        </Text>
      </SafeAreaView>
    );
  }

  if (instructionOpen) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: canvas }]}>
        <View style={styles.nav}>
          <IconButton
            label="Back"
            name="chevron.left"
            onPress={() => setInstructionOpen(false)}
            size={40}
            symbolSize={19}
            tone="surface"
          />
          <Text numberOfLines={1} style={[styles.navTitle, { color: theme.text }]}>
            Instruction
          </Text>
        </View>
        <Pressable
          accessibilityHint="Opens instruction editing"
          accessibilityRole="button"
          onPress={() => setInstructionEditorOpen(true)}
          style={({ pressed }) => [
            styles.instructionValue,
            { backgroundColor: panel },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.cardText, { color: theme.text }]}>{routine.prompt}</Text>
        </Pressable>
        <TextEditorSheet
          label="Instruction"
          onClose={() => setInstructionEditorOpen(false)}
          onSave={async (prompt) => {
            const updated = await updateRoutine(routine.id, {
              prompt: prompt.trim(),
              expectedRevision: routine.revision,
            });
            setRoutine(updated);
          }}
          value={routine.prompt}
          visible={instructionEditorOpen}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: canvas }]}>
      <View style={styles.nav}>
        <IconButton
          label="Back"
          name="chevron.left"
          onPress={() => router.back()}
          size={40}
          symbolSize={19}
          tone="surface"
        />
        <Text numberOfLines={1} style={[styles.navTitle, { color: theme.text }]}>
          {routine.name}
        </Text>
      </View>

      <FlatList
        contentContainerStyle={styles.content}
        data={executions}
        keyExtractor={(execution) => execution.id}
        ListEmptyComponent={
          <Text style={[styles.emptyHistory, { backgroundColor: panel, color: theme.textMuted }]}>
            No runs yet
          </Text>
        }
        ListFooterComponent={<View style={styles.footerSpace} />}
        ListHeaderComponent={
          <>
            <View style={[styles.activeCard, { backgroundColor: panel }]}>
              <Text style={[styles.cardText, { color: theme.text }]}>Active</Text>
              <Switch
                accessibilityLabel={`${routine.name} active`}
                disabled={mutating}
                onValueChange={(enabled) => void toggleEnabled(enabled)}
                trackColor={{ false: "#626264", true: "#34c759" }}
                value={routine.enabled}
              />
            </View>
            <Text style={[styles.helper, { color: theme.textFaint }]}>
              {routine.enabled
                ? "Active — will run on schedule"
                : "Paused — won't run until resumed"}
            </Text>

            <Text style={[styles.sectionLabel, styles.scheduleLabel, { color: theme.textFaint }]}>
              Schedule
            </Text>
            <Pressable
              accessibilityHint="Opens schedule editing"
              accessibilityRole="button"
              onPress={() => setEditorOpen(true)}
              style={({ pressed }) => [
                styles.valueCard,
                { backgroundColor: panel },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.cardText, { color: theme.text }]}>
                {describeRoutineSchedule(routine.schedule)}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => setInstructionOpen(true)}
              style={({ pressed }) => [
                styles.instructionCard,
                { backgroundColor: panel },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.cardText, { color: theme.text }]}>Instruction</Text>
              <SymbolView
                name="chevron.right"
                size={15}
                tintColor={theme.textFaint}
                weight="medium"
              />
            </Pressable>

            <Text style={[styles.sectionLabel, styles.historyLabel, { color: theme.textFaint }]}>
              Run history
            </Text>
            {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
          </>
        }
        renderItem={({ item }) => <HistoryRow execution={item} />}
        ItemSeparatorComponent={() => <View style={styles.historyGap} />}
        style={styles.list}
      />

      {editorOpen ? (
        <RoutineEditorSheet
          onClose={() => setEditorOpen(false)}
          onDeleted={() => router.back()}
          onSaved={(updated) => setRoutine(updated)}
          ownerId={routine.ownerId}
          ownerKind={routine.ownerKind}
          routine={routine}
          visible
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  nav: { height: 44, paddingHorizontal: 16, flexDirection: "row", alignItems: "center" },
  loadingHeader: { height: 44, paddingHorizontal: 16, justifyContent: "center" },
  navTitle: {
    flex: 1,
    marginLeft: 10,
    marginRight: 16,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "600",
  },
  list: { flex: 1 },
  content: { paddingHorizontal: 15, paddingTop: 12 },
  activeCard: {
    height: 50,
    borderRadius: 14,
    paddingLeft: 16,
    paddingRight: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardText: { fontSize: 16, lineHeight: 21 },
  helper: { marginTop: 8, marginLeft: 16, fontSize: 13, lineHeight: 18 },
  sectionLabel: { marginLeft: 16, fontSize: 13, lineHeight: 18 },
  scheduleLabel: { marginTop: 15, marginBottom: 8 },
  valueCard: { height: 45, borderRadius: 14, paddingHorizontal: 16, justifyContent: "center" },
  instructionCard: {
    height: 45,
    marginTop: 14,
    borderRadius: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  instructionValue: {
    minHeight: 45,
    marginHorizontal: 15,
    marginTop: 12,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: "center",
  },
  historyLabel: { marginTop: 17, marginBottom: 8 },
  historyRow: {
    height: 45,
    borderRadius: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  historyTime: { flex: 1, marginRight: 12 },
  historyGap: { height: 8 },
  emptyHistory: {
    height: 45,
    borderRadius: 14,
    overflow: "hidden",
    textAlign: "center",
    paddingTop: 13,
    fontSize: 14,
  },
  error: { marginBottom: 8, textAlign: "center", fontSize: 13 },
  pressed: { opacity: 0.72 },
  footerSpace: { height: 40 },
  loader: { marginTop: 60 },
  missing: { marginTop: 40, marginHorizontal: 24, textAlign: "center", fontSize: 15 },
});
