import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";

export function TextEditorSheet({
  label,
  value,
  visible,
  onClose,
  onSave,
}: {
  label: string;
  value: string;
  visible: boolean;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setDraft(value);
      setError(null);
    }
  }, [value, visible]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save changes.");
    } finally {
      setSaving(false);
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
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.action}>
            <Text style={[styles.actionText, { color: theme.accent }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{label}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void save()}
            style={styles.action}
          >
            {saving ? (
              <ActivityIndicator color={theme.accent} size="small" />
            ) : (
              <Text style={[styles.actionText, styles.saveText, { color: theme.accent }]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.flex}
        >
          <TextInput
            accessibilityLabel={label}
            autoFocus
            maxLength={20_000}
            multiline
            onChangeText={setDraft}
            placeholder={`Add ${label.toLowerCase()}`}
            placeholderTextColor={theme.textFaint}
            style={[
              styles.input,
              {
                backgroundColor: theme.surfaceElevated,
                borderColor: theme.border,
                color: theme.text,
              },
            ]}
            textAlignVertical="top"
            value={draft}
          />
          {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1, padding: 18 },
  header: {
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  action: { width: 76, height: 44, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 16, lineHeight: 21 },
  saveText: { fontWeight: "600" },
  title: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 16,
    fontSize: 16,
    lineHeight: 23,
  },
  error: { marginTop: 10, textAlign: "center", fontSize: 13 },
});
