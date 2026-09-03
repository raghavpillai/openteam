import type { RoutineExecutionView, RoutineView } from "@openbot/contracts";
import { routineScheduleEditMode, routineSchedulePatch } from "@openbot/product-core/routines";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { hasTransientRoutineExecution } from "@openbot/product-core/statuses";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useOpenBot } from "../state/openbot-context";
import { useTheme } from "../theme";

const executionDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function RoutineEditorSheet({
  onClose,
  onDeleted,
  onSaved,
  ownerId,
  ownerKind,
  routine,
  visible,
}: {
  onClose: () => void;
  onDeleted: (routineId: string) => void;
  onSaved: (routine: RoutineView) => void;
  ownerId: string;
  ownerKind: "bot" | "group";
  routine: RoutineView | null;
  visible: boolean;
}) {
  const theme = useTheme();
  const { createRoutine, deleteRoutine, routineExecutions, runRoutineNow, updateRoutine } =
    useOpenBot();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * 1-5");
  const [enabled, setEnabled] = useState(true);
  const [executions, setExecutions] = useState<RoutineExecutionView[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduleEditMode = routineScheduleEditMode(routine);
  const compositeSchedule = scheduleEditMode === "composite";
  const hasTransientExecutions = hasTransientRoutineExecution(executions);

  useEffect(() => {
    if (!visible) return;
    setName(routine?.name ?? "");
    setPrompt(routine?.prompt ?? "");
    setSchedule(routine?.scheduleKind === "event" ? "" : routine?.schedule || "0 9 * * 1-5");
    setEnabled(routine?.enabled ?? true);
    setError(null);
    setExecutions([]);
    if (!routine) {
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    let active = true;
    void routineExecutions(routine.id)
      .then((next) => {
        if (active) setExecutions(next);
      })
      .catch((cause) => {
        if (active) {
          setError(clientErrorMessage(cause, "Could not load routine history."));
        }
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [routine, routineExecutions, visible]);

  useEffect(() => {
    if (!visible || !routine || !hasTransientExecutions) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await routineExecutions(routine.id);
        if (!active) return;
        setExecutions(next);
        if (hasTransientRoutineExecution(next)) timer = setTimeout(() => void poll(), 1_500);
      } catch (cause) {
        if (!active) return;
        setError(clientErrorMessage(cause, "Could not refresh routine history."));
        timer = setTimeout(() => void poll(), 3_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_200);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [hasTransientExecutions, routine, routineExecutions, visible]);

  const save = async () => {
    if (!name.trim() || !prompt.trim() || saving) return;
    if (!routine && !schedule.trim()) {
      setError("A schedule is required. Use cron syntax or @every, such as @every 2h.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = routine
        ? await updateRoutine(routine.id, {
            name: name.trim(),
            prompt: prompt.trim(),
            ...routineSchedulePatch(routine, schedule),
            enabled,
            expectedRevision: routine.revision,
          })
        : await createRoutine(ownerId, ownerKind, {
            name: name.trim(),
            prompt: prompt.trim(),
            schedule: schedule.trim(),
            enabled,
          });
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not save this routine."));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!routine || running) return;
    setRunning(true);
    setError(null);
    try {
      const execution = await runRoutineNow(routine.id);
      setExecutions((current) => [
        execution,
        ...current.filter((item) => item.id !== execution.id),
      ]);
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not run this routine."));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <Pressable
            accessible
            accessibilityLabel="Close routine editor"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionText, { color: theme.accent }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text }]}>
            {routine ? "Routine" : "New Routine"}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!name.trim() || !prompt.trim() || saving}
            onPress={() => void save()}
            style={styles.headerAction}
          >
            {saving ? (
              <ActivityIndicator color={theme.accent} size="small" />
            ) : (
              <Text style={[styles.headerActionText, { color: theme.accent }]}>Save</Text>
            )}
          </Pressable>
        </View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.flex}
        >
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Field label="NAME" onChangeText={setName} value={name} />
            <Field
              label="INSTRUCTIONS"
              multiline
              onChangeText={setPrompt}
              placeholder="What should the Bot do when this routine runs?"
              value={prompt}
            />
            {scheduleEditMode === "event" ? (
              <View style={[styles.info, { backgroundColor: theme.surface }]}>
                <Text style={[styles.infoTitle, { color: theme.text }]}>
                  Event-triggered routine
                </Text>
                <Text style={[styles.infoText, { color: theme.textMuted }]}>
                  Its event trigger is preserved. You can update its name, instructions, and active
                  state from iPhone.
                </Text>
              </View>
            ) : compositeSchedule ? (
              <View style={[styles.info, { backgroundColor: theme.surface }]}>
                <Text style={[styles.infoTitle, { color: theme.text }]}>Composite schedule</Text>
                <Text style={[styles.infoText, { color: theme.textMuted }]}>
                  This routine has multiple or mixed triggers. They are preserved while you edit its
                  name, instructions, and active state.
                </Text>
              </View>
            ) : (
              <Field
                autoCapitalize="none"
                label="SCHEDULE"
                onChangeText={setSchedule}
                placeholder="0 9 * * 1-5 or @every 2h"
                value={schedule}
              />
            )}
            <View style={[styles.switchRow, { borderColor: theme.border }]}>
              <View style={styles.switchCopy}>
                <Text style={[styles.switchTitle, { color: theme.text }]}>Active</Text>
                <Text style={[styles.switchDetail, { color: theme.textMuted }]}>
                  OpenBot runs this automation at its next scheduled time.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Routine active"
                onValueChange={setEnabled}
                trackColor={{ false: theme.surfacePressed, true: theme.text }}
                value={enabled}
              />
            </View>
            {routine ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  disabled={running}
                  onPress={() => void runNow()}
                  style={({ pressed }) => [
                    styles.primary,
                    { backgroundColor: theme.text, opacity: pressed ? 0.75 : 1 },
                  ]}
                >
                  {running ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={[styles.primaryText, { color: theme.background }]}>Run now</Text>
                  )}
                </Pressable>
                <Text style={[styles.eyebrow, { color: theme.textMuted }]}>RECENT RUNS</Text>
                <View style={[styles.history, { borderColor: theme.border }]}>
                  {historyLoading ? (
                    <ActivityIndicator color={theme.textMuted} style={styles.historyLoading} />
                  ) : executions.length ? (
                    executions.map((execution, index) => (
                      <View
                        key={execution.id}
                        style={[
                          styles.historyRow,
                          index > 0 && {
                            borderTopColor: theme.separator,
                            borderTopWidth: StyleSheet.hairlineWidth,
                          },
                        ]}
                      >
                        <View style={styles.historyCopy}>
                          <Text style={[styles.historyStatus, { color: theme.text }]}>
                            {execution.status.replace("_", " ")}
                          </Text>
                          <Text style={[styles.historyDate, { color: theme.textMuted }]}>
                            {executionDate.format(new Date(execution.createdAt))}
                          </Text>
                        </View>
                        <Text style={[styles.historyKind, { color: theme.textMuted }]}>
                          {execution.kind === "test" ? "Manual" : "Scheduled"}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={[styles.empty, { color: theme.textMuted }]}>No runs yet</Text>
                  )}
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    Alert.alert(
                      `Delete ${routine.name}?`,
                      "This permanently removes the routine and its schedule.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete Routine",
                          style: "destructive",
                          onPress: () =>
                            void deleteRoutine(routine)
                              .then(() => {
                                onDeleted(routine.id);
                                onClose();
                              })
                              .catch((cause) =>
                                setError(
                                  clientErrorMessage(
                                    cause,
                                    "OpenBot could not delete this routine."
                                  )
                                )
                              ),
                        },
                      ]
                    )
                  }
                  style={styles.delete}
                >
                  <Text style={[styles.deleteText, { color: theme.danger }]}>Delete Routine</Text>
                </Pressable>
              </>
            ) : null}
            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.error, { color: theme.danger }]}
              >
                {error}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Field({
  label,
  multiline,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.eyebrow, { color: theme.textMuted }]}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        keyboardAppearance={theme.dark ? "dark" : "light"}
        multiline={multiline}
        placeholderTextColor={theme.textFaint}
        style={[
          styles.field,
          multiline && styles.multiline,
          { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    minHeight: 58,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerAction: { width: 72, minHeight: 44, alignItems: "center", justifyContent: "center" },
  headerActionText: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  headerTitle: { fontSize: 16, lineHeight: 21, fontWeight: "700" },
  content: { padding: 18, paddingBottom: 48, gap: 18 },
  fieldWrap: { gap: 7 },
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 0.7 },
  field: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  multiline: { minHeight: 132, paddingTop: 13, textAlignVertical: "top" },
  switchRow: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  switchCopy: { flex: 1, gap: 3 },
  switchTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  switchDetail: { fontSize: 12, lineHeight: 17 },
  info: { borderRadius: 14, padding: 14, gap: 4 },
  infoTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600" },
  infoText: { fontSize: 12, lineHeight: 17 },
  primary: { minHeight: 48, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  history: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: "hidden" },
  historyLoading: { padding: 18 },
  historyRow: { minHeight: 58, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" },
  historyCopy: { flex: 1 },
  historyStatus: { fontSize: 14, lineHeight: 19, fontWeight: "600", textTransform: "capitalize" },
  historyDate: { fontSize: 11, lineHeight: 15 },
  historyKind: { fontSize: 12, lineHeight: 16 },
  empty: { padding: 16, fontSize: 13, lineHeight: 18 },
  delete: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  deleteText: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  error: { fontSize: 12, lineHeight: 17 },
});
