import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconButton } from "../src/components/icon-button";
import { useOpenBot } from "../src/state/openbot-context";
import { metrics, useTheme } from "../src/theme";

const permissionCopy = {
  loading: "Checking system settings…",
  not_determined: "Off",
  granted: "On",
  denied: "Blocked in Settings",
  unavailable: "Unavailable",
} as const;

export default function SettingsScreen() {
  const theme = useTheme();
  const {
    notificationPermission,
    notificationError,
    enableNotifications,
    openNotificationSettings,
    snapshot,
    setBotNotifications,
    connection,
    connectionLoaded,
    saveConnection,
    isFixture,
  } = useOpenBot();
  const [serverUrl, setServerUrl] = useState(connection.serverUrl);
  const [accessToken, setAccessToken] = useState(connection.accessToken);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(connection.serverUrl);
    setAccessToken(connection.accessToken);
  }, [connection]);

  const persistConnection = async () => {
    setConnectionSaving(true);
    setConnectionError(null);
    try {
      await saveConnection({ serverUrl, accessToken });
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "Could not save this server");
    } finally {
      setConnectionSaving(false);
    }
  };
  const action =
    notificationPermission === "granted"
      ? openNotificationSettings
      : notificationPermission === "denied"
        ? openNotificationSettings
        : enableNotifications;
  const actionLabel =
    notificationPermission === "granted" || notificationPermission === "denied"
      ? "Open Settings"
      : "Enable";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Back"
          name="chevron.left"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          size={38}
          symbolSize={18}
          tone="surface"
        />
        <Text style={[styles.headerTitle, { color: theme.text }]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.eyebrow, { color: theme.textMuted }]}>OPENBOT SERVER</Text>
        <View
          style={[
            styles.connectionCard,
            { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
          ]}
        >
          <View style={styles.titleLine}>
            <Text style={[styles.title, { color: theme.text }]}>Private connection</Text>
            <Text style={[styles.status, { color: isFixture ? theme.textMuted : theme.success }]}>
              {connectionLoaded ? (isFixture ? "Preview data" : "Configured") : "Loading…"}
            </Text>
          </View>
          <Text style={[styles.description, { color: theme.textMuted }]}>
            Use the reachable HTTPS address for your OpenBot server. The access token stays in this
            iPhone’s Keychain and is sent as a Bearer credential.
          </Text>
          <View style={styles.fields}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>SERVER URL</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setServerUrl}
                placeholder="https://openbot.example.com"
                placeholderTextColor={theme.textFaint}
                style={[
                  styles.field,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={serverUrl}
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>ACCESS TOKEN</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setAccessToken}
                placeholder="Paste OPENBOT_API_TOKEN"
                placeholderTextColor={theme.textFaint}
                secureTextEntry
                style={[
                  styles.field,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={accessToken}
              />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!connectionLoaded || connectionSaving}
            onPress={() => void persistConnection()}
            style={({ pressed }) => [
              styles.action,
              { backgroundColor: theme.text },
              pressed && styles.pressed,
              (!connectionLoaded || connectionSaving) && styles.disabled,
            ]}
          >
            {connectionSaving ? (
              <ActivityIndicator color={theme.background} size="small" />
            ) : (
              <Text style={[styles.actionText, { color: theme.background }]}>Save connection</Text>
            )}
          </Pressable>
        </View>
        {connectionError ? (
          <Text style={[styles.error, { color: theme.danger }]}>{connectionError}</Text>
        ) : null}
        <Text style={[styles.connectionNote, { color: theme.textFaint }]}>
          HTTP is supported for local development only. Use HTTPS before installing on an iPhone
          outside a private network.
        </Text>

        <Text style={[styles.notificationEyebrow, { color: theme.textMuted }]}>NOTIFICATIONS</Text>
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
          ]}
        >
          <View style={styles.copy}>
            <View style={styles.titleLine}>
              <Text style={[styles.title, { color: theme.text }]}>Bot updates</Text>
              <Text style={[styles.status, { color: theme.textMuted }]}>
                {permissionCopy[notificationPermission]}
              </Text>
            </View>
            <Text style={[styles.description, { color: theme.textMuted }]}>
              Get a native alert when a Bot finishes or pauses for your approval. A Bot’s own
              notification switch still controls whether it can alert you.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={
              notificationPermission === "loading" || notificationPermission === "unavailable"
            }
            onPress={() => void action()}
            style={({ pressed }) => [
              styles.action,
              { backgroundColor: theme.text },
              pressed && styles.pressed,
              (notificationPermission === "loading" || notificationPermission === "unavailable") &&
                styles.disabled,
            ]}
          >
            <Text style={[styles.actionText, { color: theme.background }]}>{actionLabel}</Text>
          </Pressable>
        </View>
        {notificationError ? (
          <Text style={[styles.error, { color: theme.danger }]}>{notificationError}</Text>
        ) : null}
        <Text style={[styles.note, { color: theme.textFaint }]}>
          OpenBot asks only when you enable alerts here. Delivery uses Apple Push Notification
          service through Expo’s push gateway.
        </Text>

        <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>BOT ALERTS</Text>
        <View
          style={[
            styles.botList,
            { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
          ]}
        >
          {snapshot.bots
            .filter((bot) => !bot.hiddenFromSidebar)
            .map((bot, index, bots) => (
              <View
                key={bot.id}
                style={[
                  styles.botRow,
                  index < bots.length - 1 && {
                    borderBottomColor: theme.separator,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <View style={styles.botCopy}>
                  <Text numberOfLines={1} style={[styles.botName, { color: theme.text }]}>
                    {bot.name}
                  </Text>
                  <Text style={[styles.botDetail, { color: theme.textMuted }]}>
                    Finishes and approval requests
                  </Text>
                </View>
                <Switch
                  accessibilityLabel={`${bot.name} notifications`}
                  disabled={bot.status === "archived"}
                  onValueChange={(enabled) => void setBotNotifications(bot.id, enabled)}
                  trackColor={{ false: theme.surfacePressed, true: theme.text }}
                  value={bot.notificationsEnabled}
                />
              </View>
            ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    height: 56,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
  headerSpacer: { width: 38 },
  content: { paddingHorizontal: metrics.pageGutter, paddingTop: 26 },
  eyebrow: { marginBottom: 9, marginLeft: 4, fontSize: 11, lineHeight: 14, fontWeight: "600" },
  notificationEyebrow: {
    marginBottom: 9,
    marginLeft: 4,
    marginTop: 30,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
  },
  connectionCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 16,
  },
  fields: { gap: 13 },
  fieldGroup: { gap: 6 },
  fieldLabel: { marginLeft: 2, fontSize: 10, lineHeight: 13, fontWeight: "600" },
  field: {
    minHeight: 46,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    fontSize: 14,
  },
  connectionNote: { marginTop: 14, paddingHorizontal: 4, fontSize: 12, lineHeight: 17 },
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 18 },
  copy: { gap: 7 },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  status: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  description: { fontSize: 14, lineHeight: 20 },
  action: { minHeight: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.35 },
  error: { marginTop: 12, paddingHorizontal: 4, fontSize: 13, lineHeight: 18 },
  note: { marginTop: 16, paddingHorizontal: 4, fontSize: 12, lineHeight: 17 },
  botEyebrow: {
    marginBottom: 9,
    marginLeft: 4,
    marginTop: 30,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
  },
  botList: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18 },
  botRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 14 },
  botCopy: { flex: 1, gap: 2 },
  botName: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  botDetail: { fontSize: 12, lineHeight: 16 },
});
