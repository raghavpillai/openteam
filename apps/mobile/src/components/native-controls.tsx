import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import {
  ActionSheetIOS,
  Alert,
  Button,
  Platform,
  StyleSheet,
  Text,
  View,
  type ViewProps,
} from "react-native";
import type { SymbolViewProps } from "expo-symbols";
import { useTheme } from "../theme";
import { IconButton } from "./icon-button";

export interface NativeMenuAction {
  id: string;
  title: string;
  symbol?: string;
  selected?: boolean;
}
interface ButtonProps extends ViewProps {
  symbol: string;
  label: string;
  initials?: string;
  title?: string;
  variant?: "glass" | "tinted" | "filled" | "plain";
  busy?: boolean;
  destructive?: boolean;
  symbolSize: number;
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
  variant?: "glass" | "tinted" | "filled" | "plain";
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
        <Text style={{ fontSize: 15, fontWeight: "600" }}>{title}</Text>
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
