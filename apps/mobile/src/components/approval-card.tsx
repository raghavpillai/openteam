import type { ApprovalView } from "@openbot/contracts";
import { approvalPresentation } from "@openbot/product-core/activity";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: "accept" | "decline") => Promise<void>;
}) {
  const theme = useTheme();
  const [resolving, setResolving] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (approval.status !== "pending") return null;
  const { title, description } = approvalPresentation(approval);
  const resolve = async (decision: "accept" | "decline") => {
    if (resolving) return;
    setResolving(decision);
    setError(null);
    try {
      await onResolve(decision);
      void Haptics.notificationAsync(
        decision === "accept"
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning
      );
    } catch (cause) {
      setError(clientErrorMessage(cause, "This approval could not be resolved."));
      setResolving(null);
    }
  };

  return (
    <View
      accessibilityLabel={`${title}. ${description}`}
      style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surfaceElevated }]}
    >
      <View style={styles.titleRow}>
        <View style={[styles.badge, { backgroundColor: `${theme.accent}1F` }]}>
          <SymbolView name="checkmark.shield" size={18} tintColor={theme.accent} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
          <Text style={[styles.description, { color: theme.textMuted }]}>{description}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(resolving)}
          onPress={() => void resolve("decline")}
          style={({ pressed }) => [
            styles.button,
            { borderColor: theme.border, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          {resolving === "decline" ? (
            <ActivityIndicator color={theme.text} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: theme.text }]}>Deny</Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={Boolean(resolving)}
          onPress={() => void resolve("accept")}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.text, borderColor: theme.text, opacity: pressed ? 0.78 : 1 },
          ]}
        >
          {resolving === "accept" ? (
            <ActivityIndicator color={theme.background} size="small" />
          ) : (
            <Text style={[styles.buttonText, { color: theme.background }]}>Approve once</Text>
          )}
        </Pressable>
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 18,
    marginVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    padding: 16,
    gap: 16,
  },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  badge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 4 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: "700" },
  description: { fontSize: 14, lineHeight: 19 },
  actions: { flexDirection: "row", gap: 9 },
  button: {
    flex: 1,
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  error: { marginTop: -7, fontSize: 12, lineHeight: 16 },
});
