import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { chatGlassTint, useChatTheme } from "../chat-appearance";
import * as Haptics from "../haptics";
import { useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";

export function IconButton({
  name,
  label,
  onPress,
  filled = false,
  tone,
  size = 38,
  visualHeight = size,
  symbolSize = 20,
  disabled = false,
  haptic = "none",
  style,
}: {
  name: SymbolViewProps["name"];
  label: string;
  onPress?: () => void;
  filled?: boolean;
  tone?: "subtle" | "surface" | "glass" | "dark" | "ghost" | "muted";
  size?: number;
  visualHeight?: number;
  symbolSize?: number;
  disabled?: boolean;
  haptic?: "selection" | "light" | "none";
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const chatTheme = useChatTheme();
  const resolvedTone = tone ?? (filled ? "dark" : "subtle");
  const fill =
    resolvedTone === "dark"
      ? theme.dark
        ? "#FFFFFF"
        : theme.text
      : resolvedTone === "muted"
        ? "rgba(118,118,128,0.24)"
        : resolvedTone === "surface" || resolvedTone === "glass"
          ? theme.surfaceElevated
          : resolvedTone === "subtle"
            ? theme.surface
            : "transparent";
  const tint =
    resolvedTone === "dark"
      ? theme.dark
        ? "#000000"
        : theme.background
      : resolvedTone === "glass"
        ? chatTheme.text
        : resolvedTone === "muted"
          ? chatTheme.textMuted
          : theme.textMuted;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
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
        { width: Math.max(44, size), height: Math.max(44, visualHeight) },
        style,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {resolvedTone === "surface" || resolvedTone === "subtle" || resolvedTone === "glass" ? (
        <GlassSurface
          fallbackColor={fill}
          interactive
          variant={resolvedTone === "glass" ? "clear" : "regular"}
          tintColor={resolvedTone === "glass" && theme.dark ? chatGlassTint : undefined}
          style={[
            styles.circle,
            {
              width: size,
              height: visualHeight,
              borderRadius: Math.min(size, visualHeight) / 2,
              borderWidth: resolvedTone === "glass" ? 0 : StyleSheet.hairlineWidth,
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
              height: visualHeight,
              borderRadius: Math.min(size, visualHeight) / 2,
              backgroundColor: fill,
              borderColor:
                resolvedTone === "ghost" || resolvedTone === "muted" ? "transparent" : theme.border,
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
