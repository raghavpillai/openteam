import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type AccentPreference, type AppearancePreference, useAppearance } from "../appearance";
import { useTheme } from "../theme";
import { IconButton } from "./icon-button";

const modeOptions: Array<{
  value: AppearancePreference;
  label: string;
  symbol: SymbolViewProps["name"];
}> = [
  { value: "system", label: "System", symbol: "circle.lefthalf.filled" },
  { value: "light", label: "Day", symbol: "sun.max.fill" },
  { value: "dark", label: "Night", symbol: "moon.fill" },
];

const accentOptions: Array<{ value: AccentPreference; label: string; color: string }> = [
  { value: "black", label: "Black", color: "#FFFFFF" },
  { value: "blue", label: "Blue", color: "#087EF5" },
];

export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const { accent, preference, setAccent, setPreference } = useAppearance();

  return (
    <View style={[styles.screen, { backgroundColor: theme.dark ? "#141414" : theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Back to settings"
          name="chevron.left"
          onPress={onClose}
          size={38}
          symbolSize={18}
          tone="surface"
        />
        <Text style={[styles.title, { color: theme.text }]}>Appearance</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={[styles.sectionLabel, { color: theme.textFaint }]}>Mode</Text>
      <View style={styles.modeGrid}>
        {modeOptions.map((option) => {
          const selected = preference === option.value;
          return (
            <View key={option.value} style={styles.optionColumn}>
              <Pressable
                accessibilityLabel={`${option.label} appearance`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => void setPreference(option.value)}
                style={({ pressed }) => [
                  styles.modeCard,
                  {
                    backgroundColor: selected ? theme.surfacePressed : theme.background,
                    borderColor: selected ? "transparent" : theme.border,
                  },
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView
                  name={option.symbol}
                  size={25}
                  tintColor={selected ? theme.text : theme.textMuted}
                  weight="medium"
                />
              </Pressable>
              <Text
                style={[
                  styles.optionLabel,
                  { color: selected ? theme.text : theme.textMuted },
                  selected && styles.optionLabelSelected,
                ]}
              >
                {option.label}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={[styles.accentLabel, { color: theme.textFaint }]}>Accent</Text>
      <View style={styles.accentGrid}>
        {accentOptions.map((option) => {
          const selected = accent === option.value;
          return (
            <View key={option.value} style={styles.optionColumn}>
              <Pressable
                accessibilityLabel={`${option.label} accent`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => void setAccent(option.value)}
                style={({ pressed }) => [
                  styles.accentCard,
                  {
                    backgroundColor: selected ? theme.surfacePressed : theme.background,
                    borderColor: selected ? "transparent" : theme.border,
                  },
                  pressed && styles.pressed,
                ]}
              >
                <View
                  style={[
                    styles.accentDot,
                    {
                      backgroundColor:
                        option.value === "black"
                          ? theme.dark
                            ? "#FFFFFF"
                            : "#111111"
                          : option.color,
                    },
                  ]}
                />
              </Pressable>
              <Text
                style={[
                  styles.optionLabel,
                  { color: selected ? theme.text : theme.textMuted },
                  selected && styles.optionLabelSelected,
                ]}
              >
                {option.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 14 },
  header: {
    height: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  headerSpacer: { width: 44 },
  sectionLabel: { marginTop: 20, fontSize: 13, lineHeight: 18 },
  modeGrid: { marginTop: 8, flexDirection: "row", gap: 8 },
  accentLabel: { marginTop: 24, fontSize: 13, lineHeight: 18 },
  accentGrid: { marginTop: 8, flexDirection: "row", gap: 8 },
  optionColumn: { flex: 1, alignItems: "center" },
  modeCard: {
    width: "100%",
    height: 69,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  accentCard: {
    width: "100%",
    height: 69,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  accentDot: { width: 23, height: 23, borderRadius: 12 },
  optionLabel: { marginTop: 8, fontSize: 14, lineHeight: 19 },
  optionLabelSelected: { fontWeight: "600" },
  pressed: { opacity: 0.74, transform: [{ scale: 0.985 }] },
});
