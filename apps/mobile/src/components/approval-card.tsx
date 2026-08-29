import type { ApprovalView } from "@openbot/contracts";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: "accept" | "decline") => void;
}) {
  const theme = useTheme();
  if (approval.status !== "pending") return null;
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const title = typeof details.title === "string" ? details.title : "Approval needed";
  const description =
    typeof details.description === "string"
      ? details.description
      : "Review this action before OpenBot continues.";

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
          onPress={() => onResolve("decline")}
          style={({ pressed }) => [
            styles.button,
            { borderColor: theme.border, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.text }]}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => onResolve("accept")}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.text, borderColor: theme.text, opacity: pressed ? 0.78 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.background }]}>Approve once</Text>
        </Pressable>
      </View>
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
});
