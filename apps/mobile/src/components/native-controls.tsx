import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Button,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewProps,
} from "react-native";
import type { SymbolViewProps } from "expo-symbols";
import { useTheme } from "../theme";
import { IconButton } from "./icon-button";
import { GlassSurface } from "./glass-surface";

export function NativeGlassButton({
  children,
  label,
  symbol = "",
  symbolSize = 20,
  fallbackSymbolSize = symbolSize,
  symbolOffsetX = 0,
  disabled = false,
  onPress,
  style,
}: {
  children?: ReactNode;
  label: string;
  symbol?: string;
  symbolSize?: number;
  fallbackSymbolSize?: number;
  symbolOffsetX?: number;
  disabled?: boolean;
  onPress: () => void;
  style?: ViewProps["style"];
}) {
  const theme = useTheme();
  if (!NativeButton) {
    return children ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        style={style}
      >
        <GlassSurface interactive edgeTreatment="native" style={{ borderRadius: 22 }}>
          {children}
        </GlassSurface>
      </Pressable>
    ) : (
      <IconButton
        label={label}
        name={symbol as SymbolViewProps["name"]}
        symbolSize={fallbackSymbolSize}
        size={44}
        tone="glass"
        onPress={onPress}
        disabled={disabled}
        style={style}
      />
    );
  }
  return (
    <View style={[{ minWidth: 44, minHeight: 44 }, style]}>
      {/* Offset the native wrapper's two-point reserve to keep the visual frame at 44 points. */}
      <NativeButton
        label={label}
        symbol={symbol}
        symbolSize={symbolSize}
        symbolOffsetX={symbolOffsetX}
        glassTintAlpha={0.056}
        dark={theme.dark}
        disabled={disabled}
        variant="chatGlass"
        actions={[]}
        onActivate={onPress}
        style={{ position: "absolute", top: -2, bottom: -2, left: -2, right: -2 }}
      />
      {children ? (
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}

export interface NativeMenuAction {
  id: string;
  title: string;
  symbol?: string;
  selected?: boolean;
  destructive?: boolean;
  children?: NativeMenuAction[];
  inline?: boolean;
}

interface ContextMenuProps extends ViewProps {
  onActivate?: () => void;
  dark: boolean;
  menuJSON: string;
  onAction: (event: { nativeEvent: { id: string } }) => void;
}
export const NativeContextMenu: ComponentType<ContextMenuProps> | null =
  Platform.OS === "ios" && requireOptionalNativeModule("OpenTeamContextMenu")
    ? requireNativeView<ContextMenuProps>("OpenTeamContextMenu")
    : null;

export function NativeContextMenuHost(props: ContextMenuProps) {
  return NativeContextMenu ? (
    <NativeContextMenu {...props} />
  ) : (
    <View style={props.style}>{props.children}</View>
  );
}

interface MessageActionsProps extends ViewProps {
  visible: boolean;
  dark: boolean;
  actionsJSON: string;
  reactions: string[];
  onAction: (event: { nativeEvent: { id: string } }) => void;
  onDismiss: () => void;
}
export const NativeMessageActions: ComponentType<MessageActionsProps> | null =
  Platform.OS === "ios" && requireOptionalNativeModule("OpenTeamMessageActions")
    ? requireNativeView<MessageActionsProps>("OpenTeamMessageActions")
    : null;
interface ButtonProps extends ViewProps {
  symbol: string;
  label: string;
  initials?: string;
  title?: string;
  variant?: "glass" | "chatGlass" | "tinted" | "filled" | "plain" | "primary";
  busy?: boolean;
  destructive?: boolean;
  symbolSize: number;
  symbolOffsetX?: number;
  glassTintAlpha?: number;
  dark: boolean;
  disabled?: boolean;
  actions?: NativeMenuAction[];
  onActivate?: () => void;
  onAction?: (event: { nativeEvent: { id: string } }) => void;
}
export interface NativeSettingsRow {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  initials?: string;
  symbol?: string;
  kind?: "button" | "toggle" | "info" | "profile";
  value?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}
export interface NativeSettingsSection {
  title?: string;
  footer?: string;
  rows: NativeSettingsRow[];
}
interface SettingsProps extends ViewProps {
  dark: boolean;
  sections: NativeSettingsSection[];
  onAction: (event: { nativeEvent: { id: string; value?: boolean } }) => void;
}
const NativeButton =
  Platform.OS === "ios" && requireOptionalNativeModule("OpenTeamButton")
    ? requireNativeView<ButtonProps>("OpenTeamButton")
    : null;
export const NativeSettingsList: ComponentType<SettingsProps> | null =
  Platform.OS === "ios" && requireOptionalNativeModule("OpenTeamSettings")
    ? requireNativeView<SettingsProps>("OpenTeamSettings")
    : null;

export function NativeToolbarButton({
  name,
  label,
  onPress,
  actions,
  onAction,
  symbolSize = 20,
  initials,
}: {
  name: SymbolViewProps["name"];
  label: string;
  onPress?: () => void;
  actions?: NativeMenuAction[];
  onAction?: (id: string) => void;
  symbolSize?: number;
  initials?: string;
}) {
  const theme = useTheme();
  if (NativeButton)
    return (
      <NativeButton
        symbol={name as string}
        initials={initials ?? ""}
        label={label}
        symbolSize={symbolSize}
        dark={theme.dark}
        actions={actions ?? []}
        onActivate={onPress}
        onAction={(event) => onAction?.(event.nativeEvent.id)}
        style={{ width: 48, height: 48 }}
      />
    );
  const showFallbackMenu = () => {
    if (!actions?.length) {
      onPress?.();
      return;
    }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((action) => action.title), "Cancel"],
          cancelButtonIndex: actions.length,
        },
        (index) => {
          const action = actions[index];
          if (action) onAction?.(action.id);
        }
      );
    } else
      Alert.alert("New conversation", undefined, [
        ...actions.map((action) => ({ text: action.title, onPress: () => onAction?.(action.id) })),
        { text: "Cancel", style: "cancel" },
      ]);
  };
  return (
    <IconButton
      name={name}
      label={label}
      onPress={showFallbackMenu}
      size={44}
      symbolSize={symbolSize}
      tone="surface"
    />
  );
}

/** A UIKit button; the hidden label supplies its intrinsic size to Yoga. */
export function NativeActionButton({
  title,
  label = title,
  onPress,
  disabled = false,
  busy = false,
  destructive = false,
  variant = "tinted",
  symbol,
  actions,
  onAction,
  style,
}: {
  title: string;
  label?: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
  variant?: "glass" | "tinted" | "filled" | "plain" | "primary";
  symbol?: SymbolViewProps["name"];
  actions?: NativeMenuAction[];
  onAction?: (id: string) => void;
  style?: ViewProps["style"];
}) {
  const theme = useTheme();
  const activate = () => {
    if (!actions?.length) return onPress?.();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((action) => action.title), "Cancel"],
          cancelButtonIndex: actions.length,
        },
        (index) => {
          if (actions[index]) onAction?.(actions[index].id);
        }
      );
    } else {
      Alert.alert(
        label,
        undefined,
        actions.map((action) => ({ text: action.title, onPress: () => onAction?.(action.id) }))
      );
    }
  };
  if (!NativeButton)
    return (
      <View style={style}>
        <Button
          title={title}
          accessibilityLabel={label}
          onPress={activate}
          disabled={disabled || busy}
          color={destructive ? theme.danger : undefined}
        />
      </View>
    );
  return (
    <View
      style={[
        { alignSelf: "flex-start", minHeight: 48, minWidth: 64, justifyContent: "center" },
        style,
      ]}
    >
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          opacity: 0,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 18,
          paddingVertical: 12,
        }}
      >
        {symbol ? <View style={{ width: 26 }} /> : null}
        <Text style={{ fontSize: 17, fontWeight: "400" }}>{title}</Text>
      </View>
      <NativeButton
        title={title}
        label={label}
        symbol={(symbol ?? "") as string}
        symbolSize={16}
        variant={variant}
        dark={theme.dark}
        disabled={disabled}
        busy={busy}
        destructive={destructive}
        actions={actions ?? []}
        onActivate={onPress}
        onAction={(event) => onAction?.(event.nativeEvent.id)}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
