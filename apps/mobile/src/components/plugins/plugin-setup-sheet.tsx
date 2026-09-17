import type { PluginCatalogItemView } from "@openteam/contracts";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { NativeActionButton, NativeToolbarButton } from "../native-controls";

export function PluginSetupSheet({
  plugin,
  values,
  onChange,
  onCancel,
  onInstall,
  busy = false,
  error,
}: {
  plugin: PluginCatalogItemView;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onCancel: () => void;
  onInstall: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const theme = useTheme();
  const fields = plugin.setupFields;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: theme.background }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <View
            style={{
              minHeight: 72,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 14,
              gap: 12,
            }}
          >
            <NativeToolbarButton name="xmark" label="Cancel plugin setup" onPress={onCancel} />
            <Text style={{ flex: 1, color: theme.text, fontSize: 17, fontWeight: "600" }}>
              Plugin setup
            </Text>
            <NativeActionButton
              title="Install"
              disabled={busy || fields.some(field => field.required && !values[field.key]?.trim() && field.default === undefined)}
              busy={busy}
              variant="filled"
              onPress={onInstall}
              style={{ alignSelf: "center" }}
            />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{ padding: 20, paddingBottom: 44, gap: 18 }}
          >
            <Text style={{ color: theme.text, fontSize: 22, fontWeight: "600" }}>
              Set up {plugin.name}
            </Text>
            <Text style={{ color: theme.textMuted, fontSize: 15, lineHeight: 21 }}>
              {plugin.setup?.description || "Enter the credentials required by this plugin."}
            </Text>
            {error ? <Text accessibilityRole="alert" style={{color: theme.danger}}>{error}</Text> : null}
            {fields.map((field) => (
              <View key={field.key} style={{ gap: 8 }}>
                <Text style={{ color: theme.text, fontSize: 15 }}>{field.label}</Text>
                <TextInput
                  accessibilityLabel={field.label}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardAppearance={theme.dark ? "dark" : "light"}
                  onChangeText={(value) => onChange(field.key, value)}
                  placeholder={
                    "placeholder" in field && typeof field.placeholder === "string"
                      ? field.placeholder
                      : field.label
                  }
                  placeholderTextColor={theme.textFaint}
                  secureTextEntry={field.secret}
                  style={{
                    minHeight: 48,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    fontSize: 17,
                    backgroundColor: theme.dark ? "#202020" : "#F2F2F2",
                    color: theme.text,
                  }}
                  value={values[field.key] ?? ""}
                />
              </View>
            ))}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
