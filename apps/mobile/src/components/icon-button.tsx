import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";

export function IconButton({
  name,
  label,
  onPress,
  filled = false,
  tone,
  size = 38,
  symbolSize = 20,
  disabled = false,
  haptic = "selection",
  style,
}: {
  name: SymbolViewProps["name"];
  label: string;
  onPress?: () => void;
  filled?: boolean;
  tone?: "subtle" | "surface" | "dark" | "ghost";
  size?: number;
  symbolSize?: number;
  disabled?: boolean;
  haptic?: "selection" | "light" | "none";
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const resolvedTone = tone ?? (filled ? "dark" : "subtle");
  const fill =
    resolvedTone === "dark"
      ? theme.text
      : resolvedTone === "surface"
        ? theme.surfaceElevated
        : resolvedTone === "subtle"
          ? theme.surface
          : "transparent";
  const tint = resolvedTone === "dark" ? theme.background : theme.textMuted;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        if (haptic === "light") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } else if (haptic === "selection") {
          void Haptics.selectionAsync();
        }
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.hit,
        { width: Math.max(44, size), height: Math.max(44, size) },
        style,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {resolvedTone === "surface" || resolvedTone === "subtle" ? (
        <GlassSurface
          fallbackColor={fill}
          interactive
          style={[
            styles.circle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: theme.border,
              shadowColor: theme.dark ? "#000" : "#77776F",
              shadowOpacity: resolvedTone === "surface" ? (theme.dark ? 0.22 : 0.08) : 0,
            },
          ]}
        >
          <SymbolView name={name} size={symbolSize} tintColor={tint} weight="medium" />
        </GlassSurface>
      ) : (
        <View
          style={[
            styles.circle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: fill,
              borderColor: resolvedTone === "ghost" ? "transparent" : theme.border,
            },
          ]}
        >
          <SymbolView name={name} size={symbolSize} tintColor={tint} weight="medium" />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { alignItems: "center", justifyContent: "center" },
  circle: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 2 },
  },
  pressed: { transform: [{ scale: 0.94 }], opacity: 0.78 },
  disabled: { opacity: 0.38 },
});
