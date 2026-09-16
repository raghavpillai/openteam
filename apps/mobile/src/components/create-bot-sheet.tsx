import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { ROBOT_AVATAR_LABELS, type RobotAvatarShape } from "@openteam/contracts/robot-avatar";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { BotMark } from "./bot-mark";
import { NativeActionButton, NativeToolbarButton } from "./native-controls";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";
import * as Haptics from "../haptics";

// Keep OpenTeam's robot identities in the reference's four-by-two picker.
const shapes: RobotAvatarShape[] = [
  "classic",
  "goggles",
  "tv-head",
  "terminal",
  "pod",
  "hex-visor",
  "chip",
  "helmet",
];
const colors = [
  "#000000",
  "#93643A",
  "#FF2440",
  "#FF6600",
  "#FF9600",
  "#00CA71",
  "#00BBA6",
  "#1084FF",
  "#9158FD",
  "#FF309C",
  "#777777",
];

export function CreateBotSheet() {
  const theme = useTheme();
  const { createBot } = useOpenTeam();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<RobotAvatarShape>("classic");
  const [color, setColor] = useState(colors[1]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const channelId = await createBot(name, { icon, color });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace({ pathname: "/chat/[channelId]", params: { channelId } });
    } catch (cause) {
      setError(clientErrorMessage(cause, "Couldn’t create this Bot. Please try again."));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView
      collapsable={false}
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View collapsable={false} style={styles.header}>
        <NativeToolbarButton
          label="Cancel"
          name="xmark"
          symbolSize={18}
          onPress={() => router.back()}
        />
        <Text style={[styles.title, { color: theme.text }]}>Create New Bot</Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <BotMark icon={icon} color={color} size={192} />
        </View>
        <TextInput
          accessibilityLabel="Name your Bot"
          placeholder="Name your Bot"
          placeholderTextColor={theme.textFaint}
          value={name}
          onChangeText={setName}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          keyboardAppearance={theme.dark ? "dark" : "light"}
          maxLength={120}
          style={[styles.name, { color: theme.text, backgroundColor: theme.surface }]}
        />
        <View style={styles.shapes}>
          {shapes.map((shape) => (
            <Pressable
              key={shape}
              accessibilityRole="radio"
              accessibilityState={{ selected: icon === shape }}
              accessibilityLabel={`${ROBOT_AVATAR_LABELS[shape]} robot`}
              onPress={() => {
                if (shape !== icon) void Haptics.selectionAsync();
                setIcon(shape);
              }}
              style={styles.shapeTouch}
            >
              <View
                style={[
                  styles.shapeRing,
                  { borderColor: icon === shape ? theme.textFaint : "transparent" },
                ]}
              >
                <BotMark icon={shape} color={color} size={48} />
              </View>
            </Pressable>
          ))}
        </View>
        <View style={styles.colors}>
          {[colors.slice(0, 6), colors.slice(6)].map((row, index) => (
            <View key={index} style={styles.colorRow}>
              {row.map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: color === value }}
                  accessibilityLabel={`Color ${value}`}
                  onPress={() => {
                    if (value !== color) void Haptics.selectionAsync();
                    setColor(value);
                  }}
                  style={styles.colorTouch}
                >
                  <View
                    style={[
                      styles.colorRing,
                      { borderColor: color === value ? theme.textFaint : "transparent" },
                    ]}
                  >
                    <View style={[styles.swatch, { backgroundColor: value }]} />
                  </View>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
            {error}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <NativeActionButton
            title="Create"
            label="Create Bot"
            variant="primary"
            disabled={!name.trim()}
            busy={busy}
            onPress={() => void submit()}
            style={styles.create}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: 76,
    paddingTop: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 15,
  },
  title: { marginTop: 16, fontSize: 16.8, lineHeight: 22, fontWeight: "600" },
  content: { paddingHorizontal: 16, paddingBottom: 0, flexGrow: 1 },
  hero: {
    height: 309,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  name: {
    height: 52,
    borderRadius: 16,
    textAlign: "center",
    fontSize: 22,
    fontWeight: "600",
    paddingHorizontal: 16,
    paddingVertical: 0,
  },
  shapes: {
    width: 240,
    marginTop: 24,
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  shapeTouch: { width: 60, height: 60, alignItems: "center", justifyContent: "center" },
  shapeRing: {
    width: 44,
    height: 44,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  colors: { marginTop: 16, alignSelf: "center" },
  colorRow: { flexDirection: "row", justifyContent: "center" },
  colorTouch: { width: 62, height: 44, alignItems: "center", justifyContent: "center" },
  colorRing: {
    width: 34,
    height: 34,
    borderRadius: 18,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: { width: 26, height: 26, borderRadius: 14 },
  footer: { marginTop: "auto", paddingHorizontal: 12, paddingTop: 14, paddingBottom: 26 },
  create: { alignSelf: "stretch", height: 48 },
  error: { marginTop: 12, fontSize: 14, textAlign: "center" },
});
