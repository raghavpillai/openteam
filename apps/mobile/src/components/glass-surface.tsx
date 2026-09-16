import {
  GlassContainer,
  type GlassStyle,
  GlassView,
  isGlassEffectAPIAvailable,
} from "expo-glass-effect";
import type React from "react";
import {
  Platform,
  type StyleProp,
  StyleSheet,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme";

const nativeGlassAvailable = Platform.OS === "ios" && isGlassEffectAPIAvailable();

export function GlassSurface({
  children,
  edgeTreatment = "enhanced",
  fallbackColor,
  interactive = false,
  style,
  tintColor,
  variant = "regular",
  ...viewProps
}: {
  children?: React.ReactNode;
  edgeTreatment?: "native" | "enhanced";
  fallbackColor?: string;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
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
      glassEffectStyle={!theme.dark && variant === "clear" ? "regular" : variant}
      isInteractive={interactive}
      {...viewProps}
      style={style}
      tintColor={tintColor ?? (theme.dark ? "rgba(38,38,36,0.46)" : "rgba(255,255,255,0.24)")}
    >
      {children}
      {edgeTreatment === "enhanced" && (!theme.dark || variant === "clear") ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: StyleSheet.flatten(style)?.borderRadius ?? 0,
              borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0.5,
              borderColor: theme.dark ? "rgba(255,255,255,0.17)" : "rgba(0,0,0,0.12)",
              ...(theme.dark
                ? {
                    boxShadow: [
                      {
                        inset: true,
                        offsetX: 0,
                        offsetY: 1,
                        blurRadius: 2,
                        color: "rgba(255,255,255,0.16)",
                      },
                      {
                        inset: true,
                        offsetX: 0,
                        offsetY: -1,
                        blurRadius: 2,
                        color: "rgba(255,255,255,0.16)",
                      },
                    ],
                  }
                : {}),
            },
          ]}
        />
      ) : null}
    </GlassView>
  );
}

/**
 * Groups sibling glass surfaces. UIKit refuses to sample a backdrop for a glass view nested inside
 * another glass view's content, so adjacent pills have to live in a container effect rather than
 * inside a glass card.
 */
export function GlassGroup({
  children,
  // The native container only installs its effect when spacing changes from its unset default, so
  // this has to be an explicit number for nested surfaces to keep their backdrop.
  spacing = 0,
  style,
  ...viewProps
}: {
  children?: React.ReactNode;
  spacing?: number;
  style?: StyleProp<ViewStyle>;
} & Omit<ViewProps, "children" | "style">) {
  if (!nativeGlassAvailable) {
    return (
      <View {...viewProps} style={style}>
        {children}
      </View>
    );
  }

  return (
    <GlassContainer {...viewProps} spacing={spacing} style={style}>
      {children}
    </GlassContainer>
  );
}

export const usesNativeLiquidGlass = nativeGlassAvailable;
