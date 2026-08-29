import { type GlassStyle, GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type React from "react";
import { Platform, type StyleProp, View, type ViewProps, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

const nativeGlassAvailable = Platform.OS === "ios" && isGlassEffectAPIAvailable();

export function GlassSurface({
  children,
  fallbackColor,
  interactive = false,
  style,
  variant = "regular",
  ...viewProps
}: {
  children?: React.ReactNode;
  fallbackColor?: string;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: GlassStyle;
} & Omit<ViewProps, "children" | "style">) {
  const theme = useTheme();

  if (!nativeGlassAvailable) {
    return (
      <View
        {...viewProps}
        style={[{ backgroundColor: fallbackColor ?? theme.surfaceElevated }, style]}
      >
        {children}
      </View>
    );
  }

  return (
    <GlassView
      colorScheme={theme.dark ? "dark" : "light"}
      glassEffectStyle={variant}
      isInteractive={interactive}
      {...viewProps}
      style={style}
      tintColor={theme.dark ? "rgba(38,38,36,0.46)" : "rgba(255,255,255,0.24)"}
    >
      {children}
    </GlassView>
  );
}

export const usesNativeLiquidGlass = nativeGlassAvailable;
