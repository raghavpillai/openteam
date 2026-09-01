import type { OpenBotAuthUser } from "@openbot/client-core/auth";
import type { BotView } from "@openbot/contracts";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppearance } from "../src/appearance";
import {
  authenticatedUserForServer,
  cachedAuthModeForServer,
  type OpenBotAuthMode,
  signOut,
} from "../src/auth";
import { AppearanceSheet } from "../src/components/appearance-sheet";
import { IconButton } from "../src/components/icon-button";
import { PluginMarketplaceSheet as PluginManagerSheet } from "../src/components/plugin-marketplace-sheet";
import { SettingsHome } from "../src/components/settings-home";
import {
  BOT_ROSTER_SEARCH_THRESHOLD,
  filterBotRoster,
  MOBILE_VIRTUAL_LIST_TUNING,
} from "../src/list-scale";
import { useOpenBot } from "../src/state/openbot-context";
import { metrics, useTheme } from "../src/theme";

const permissionCopy = {
  loading: "Checking system settings…",
  not_determined: "Off",
  granted: "On",
  denied: "Blocked in Settings",
  unavailable: "Unavailable",
} as const;

interface BotSection {
  kind: "alerts" | "hidden";
  title: string;
  data: BotView[];
}

interface BotRowProps {
  bot: BotView;
  first: boolean;
  last: boolean;
}

const BotAlertRow = memo(function BotAlertRow({
  bot,
  first,
  last,
  onToggle,
}: BotRowProps & { onToggle: (botId: string, enabled: boolean) => void }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.botRow,
        {
          backgroundColor: theme.surfaceElevated,
          borderColor: theme.border,
          borderBottomColor: last ? theme.border : theme.separator,
        },
        first && styles.botRowFirst,
        last && styles.botRowLast,
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
        onValueChange={(enabled) => onToggle(bot.id, enabled)}
        trackColor={{ false: theme.surfacePressed, true: theme.text }}
        value={bot.notificationsEnabled}
      />
    </View>
  );
});

const HiddenBotRow = memo(function HiddenBotRow({
  bot,
  first,
  last,
  onShow,
}: BotRowProps & { onShow: (botId: string) => void }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.botRow,
        {
          backgroundColor: theme.surfaceElevated,
          borderColor: theme.border,
          borderBottomColor: last ? theme.border : theme.separator,
        },
        first && styles.botRowFirst,
        last && styles.botRowLast,
      ]}
    >
      <View style={styles.botCopy}>
        <Text numberOfLines={1} style={[styles.botName, { color: theme.text }]}>
          {bot.name}
        </Text>
        <Text style={[styles.botDetail, { color: theme.textMuted }]}>
          Still active while hidden
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`Show ${bot.name}`}
        accessibilityRole="button"
        onPress={() => onShow(bot.id)}
        style={({ pressed }) => [styles.showButton, pressed && styles.pressed]}
      >
        <Text style={[styles.showButtonLabel, { color: theme.text }]}>Show</Text>
      </Pressable>
    </View>
  );
});

export default function SettingsScreen() {
  const theme = useTheme();
  const { accent, preference: appearance } = useAppearance();
  const {
    notificationPermission,
    notificationError,
    enableNotifications,
    openNotificationSettings,
    snapshot,
    hiddenBots,
    setBotNotifications,
    setBotHidden,
    connection,
    connectionLoaded,
    saveConnection,
    isFixture,
  } = useOpenBot();
  const [serverUrl, setServerUrl] = useState(connection.serverUrl);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const [botQuery, setBotQuery] = useState("");
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [authMode, setAuthMode] = useState<OpenBotAuthMode | null>(null);
  const [authUser, setAuthUser] = useState<OpenBotAuthUser | null>(null);
  const appVersion = Constants.expoConfig?.version ?? "0.1.0";

  useEffect(() => {
    setServerUrl(connection.serverUrl);
  }, [connection]);

  useEffect(() => {
    let active = true;
    setAuthMode(null);
    if (isFixture) {
      setAuthMode("disabled");
      return () => {
        active = false;
      };
    }
    void cachedAuthModeForServer(connection.serverUrl)
      .then((mode) => {
        if (active) setAuthMode(mode);
      })
      .catch(() => {
        if (active) setAuthMode(null);
      });
    return () => {
      active = false;
    };
  }, [connection.serverUrl, isFixture]);

  useEffect(() => {
    let active = true;
    setAuthUser(null);
    if (isFixture)
      return () => {
        active = false;
      };
    void authenticatedUserForServer(connection.serverUrl)
      .then((user) => {
        if (active) setAuthUser(user);
      })
      .catch(() => {
        if (active) setAuthUser(null);
      });
    return () => {
      active = false;
    };
  }, [connection.serverUrl, isFixture]);

  const visibleBots = useMemo(
    () => snapshot.bots.filter((bot) => !bot.hiddenFromSidebar),
    [snapshot.bots]
  );
  const filteredVisibleBots = useMemo(
    () => filterBotRoster(visibleBots, botQuery),
    [botQuery, visibleBots]
  );
  const filteredHiddenBots = useMemo(
    () => filterBotRoster(hiddenBots, botQuery),
    [botQuery, hiddenBots]
  );
  const sections = useMemo<BotSection[]>(
    () => [
      { kind: "alerts", title: "BOT ALERTS", data: filteredVisibleBots },
      ...(filteredHiddenBots.length > 0
        ? [
            {
              kind: "hidden" as const,
              title: "HIDDEN CONVERSATIONS",
              data: filteredHiddenBots,
            },
          ]
        : []),
    ],
    [filteredHiddenBots, filteredVisibleBots]
  );
  const totalBotCount = visibleBots.length + hiddenBots.length;
  const noBotMatches =
    botQuery.trim().length > 0 && filteredVisibleBots.length + filteredHiddenBots.length === 0;

  const persistConnection = async () => {
    setConnectionSaving(true);
    setConnectionError(null);
    try {
      await saveConnection({ serverUrl });
    } catch (cause) {
      setConnectionError(clientErrorMessage(cause, "Could not save this server"));
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
  const handleToggleNotifications = useCallback(
    (botId: string, enabled: boolean) => {
      void setBotNotifications(botId, enabled);
    },
    [setBotNotifications]
  );
  const handleShowBot = useCallback(
    (botId: string) => {
      setHiddenError(null);
      void setBotHidden(botId, false).catch((cause) => {
        setHiddenError(clientErrorMessage(cause, "OpenBot could not show this conversation."));
      });
    },
    [setBotHidden]
  );
  const renderBot = useCallback(
    ({ item, index, section }: { item: BotView; index: number; section: BotSection }) =>
      section.kind === "alerts" ? (
        <BotAlertRow
          bot={item}
          first={index === 0}
          last={index === section.data.length - 1}
          onToggle={handleToggleNotifications}
        />
      ) : (
        <HiddenBotRow
          bot={item}
          first={index === 0}
          last={index === section.data.length - 1}
          onShow={handleShowBot}
        />
      ),
    [handleShowBot, handleToggleNotifications]
  );
  const accountParitySections = (
    <>
      <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>USAGE</Text>
      <View
        style={[
          styles.infoCard,
          { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
        ]}
      >
        <View style={styles.infoRow}>
          <Text style={[styles.infoTitle, { color: theme.text }]}>Weekly usage</Text>
          <Text style={[styles.infoValue, { color: theme.textMuted }]}>—</Text>
        </View>
        <View style={[styles.usageTrack, { backgroundColor: theme.surfacePressed }]} />
        <Text style={[styles.infoDetail, { color: theme.textMuted }]}>
          Not metered by self-hosted OpenBot
        </Text>
        <View style={[styles.infoDivider, { backgroundColor: theme.separator }]} />
        <View style={styles.infoRow}>
          <Text style={[styles.infoTitle, { color: theme.text }]}>On-demand usage</Text>
          <Text style={[styles.infoValue, { color: theme.textMuted }]}>Provider managed</Text>
        </View>
        <Text style={[styles.infoDetail, { color: theme.textMuted }]}>
          Model, storage, and network charges are managed by your configured providers.
        </Text>
        <View style={[styles.planPill, { backgroundColor: theme.text }]}>
          <Text style={[styles.planPillText, { color: theme.background }]}>Self-hosted</Text>
        </View>
      </View>

      <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>ACCOUNT</Text>
      <View
        style={[
          styles.infoCard,
          { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
        ]}
      >
        <View style={styles.accountRow}>
          <View style={[styles.accountAvatar, { backgroundColor: theme.text }]}>
            <Text style={[styles.accountInitials, { color: theme.background }]}>OB</Text>
          </View>
          <View style={styles.accountCopy}>
            <Text style={[styles.infoTitle, { color: theme.text }]}>OpenBot owner</Text>
            <Text style={[styles.infoDetail, { color: theme.textMuted }]}>
              {authMode === "disabled"
                ? "Authentication disabled"
                : authMode === "required"
                  ? "Signed in securely"
                  : "Checking authentication…"}
            </Text>
          </View>
        </View>
        {authMode === "disabled" ? (
          <Text style={[styles.accountNote, { color: theme.textMuted }]}>
            This server trusts clients that can reach it, so there is no account session to sign out
            from.
          </Text>
        ) : null}
        {authMode === "required" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              Alert.alert(
                "Sign out of OpenBot?",
                "Your server endpoint stays saved on this device.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Sign Out", style: "destructive", onPress: () => void signOut() },
                ]
              )
            }
            style={({ pressed }) => [
              styles.signOut,
              { borderColor: theme.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.signOutLabel, { color: theme.danger }]}>Sign Out</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>ABOUT</Text>
      <View
        style={[
          styles.aboutCard,
          { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
        ]}
      >
        <Image source={require("../assets/openbot-icon-v2.png")} style={styles.appIcon} />
        <Text style={[styles.aboutTitle, { color: theme.text }]}>OpenBot</Text>
        <Text style={[styles.aboutVersion, { color: theme.textMuted }]}>Version {appVersion}</Text>
        <Text style={[styles.aboutCopyright, { color: theme.textMuted }]}>
          Copyright © 2026 OpenBot contributors
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void Clipboard.setStringAsync(`OpenBot ${appVersion}\niOS`)}
          style={({ pressed }) => [
            styles.copyVersion,
            { backgroundColor: theme.surface, borderColor: theme.border },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.copyVersionText, { color: theme.text }]}>Copy version info</Text>
        </Pressable>
      </View>
    </>
  );

  return (
    <SafeAreaView
      edges={[]}
      style={[
        styles.safe,
        {
          backgroundColor: theme.dark ? "#111111" : "#F6F6F4",
          borderColor: theme.border,
        },
      ]}
    >
      {pluginsOpen ? (
        <PluginManagerSheet onClose={() => setPluginsOpen(false)} visible />
      ) : appearanceOpen ? (
        <AppearanceSheet onClose={() => setAppearanceOpen(false)} />
      ) : !advancedOpen ? (
        <SettingsHome
          accent={accent}
          appVersion={appVersion}
          appearance={appearance}
          authRequired={authMode === "required"}
          notificationPermission={notificationPermission}
          onAccount={() => setAdvancedOpen(true)}
          onAppearance={() => setAppearanceOpen(true)}
          onAutoReviewInfo={() =>
            Alert.alert(
              "Managed by the desktop host",
              "Auto-review protects actions on the computer that runs OpenBot. Open Advanced to manage the connected server and per-Bot alerts; permission rules stay on that computer."
            )
          }
          onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          onFeedback={() =>
            void Clipboard.setStringAsync(
              `OpenBot feedback\nVersion ${appVersion}\nServer ${connection.serverUrl}`
            ).then(() =>
              Alert.alert(
                "Feedback details copied",
                "Paste them into your preferred support channel."
              )
            )
          }
          onNotifications={() => void action()}
          onPlugins={() => setPluginsOpen(true)}
          onSignOut={() =>
            Alert.alert(
              "Sign out of OpenBot?",
              "Your server endpoint stays saved on this device.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Sign Out", style: "destructive", onPress: () => void signOut() },
              ]
            )
          }
          onSystemPreferenceInfo={(setting) => {
            const copy = {
              haptics: "OpenBot follows the native iOS haptic behavior for interactive controls.",
              language: "OpenBot currently follows this device’s system language.",
              timezone: "OpenBot uses the time zone reported by this device for routine schedules.",
            }[setting];
            Alert.alert(
              setting === "timezone"
                ? "Time Zone"
                : setting === "language"
                  ? "Language"
                  : "Haptics",
              copy
            );
          }}
          user={authUser}
        />
      ) : (
        <>
          <View style={styles.header}>
            <IconButton
              label="Back to settings"
              name="chevron.left"
              onPress={() => setAdvancedOpen(false)}
              size={38}
              symbolSize={18}
              tone="surface"
            />
            <Text style={[styles.headerTitle, { color: theme.text }]}>Advanced</Text>
            <View style={styles.headerSpacer} />
          </View>

          <SectionList<BotView, BotSection>
            sections={sections}
            extraData={botQuery}
            keyExtractor={(bot) => bot.id}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            renderItem={renderBot}
            renderSectionHeader={({ section }) => (
              <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>{section.title}</Text>
            )}
            stickySectionHeadersEnabled={false}
            {...MOBILE_VIRTUAL_LIST_TUNING}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <>
                <Text style={[styles.eyebrow, { color: theme.textMuted }]}>OPENBOT SERVER</Text>
                <View
                  style={[
                    styles.connectionCard,
                    { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                  ]}
                >
                  <View style={styles.titleLine}>
                    <Text style={[styles.title, { color: theme.text }]}>Private connection</Text>
                    <Text
                      style={[
                        styles.status,
                        { color: isFixture ? theme.textMuted : theme.success },
                      ]}
                    >
                      {connectionLoaded ? (isFixture ? "Preview data" : "Configured") : "Loading…"}
                    </Text>
                  </View>
                  <Text style={[styles.description, { color: theme.textMuted }]}>
                    Use the reachable HTTPS address for your OpenBot server. Your signed-in session
                    stays in this device’s secure storage.
                  </Text>
                  <View style={styles.fields}>
                    <View style={styles.fieldGroup}>
                      <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>
                        SERVER ENDPOINT
                      </Text>
                      <TextInput
                        accessibilityHint="Enter the HTTP or HTTPS address this device can use to reach your self-hosted OpenBot server"
                        accessibilityLabel="Server endpoint"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        onChangeText={(value) => {
                          setServerUrl(value);
                          setConnectionError(null);
                        }}
                        placeholder="https://openbot.example.com"
                        placeholderTextColor={theme.textFaint}
                        style={[
                          styles.field,
                          {
                            backgroundColor: theme.field,
                            borderColor: theme.border,
                            color: theme.text,
                          },
                        ]}
                        value={serverUrl}
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
                      <Text style={[styles.actionText, { color: theme.background }]}>
                        Save connection
                      </Text>
                    )}
                  </Pressable>
                </View>
                {connectionError ? (
                  <Text style={[styles.error, { color: theme.danger }]}>{connectionError}</Text>
                ) : null}
                <Text style={[styles.connectionNote, { color: theme.textFaint }]}>
                  HTTP is supported for local development only. Use HTTPS outside a trusted private
                  network.
                </Text>

                <Text style={[styles.notificationEyebrow, { color: theme.textMuted }]}>
                  NOTIFICATIONS
                </Text>
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
                      Get a native alert when a Bot finishes or pauses for your approval. A Bot’s
                      own notification switch still controls whether it can alert you.
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      notificationPermission === "loading" ||
                      notificationPermission === "unavailable"
                    }
                    onPress={() => void action()}
                    style={({ pressed }) => [
                      styles.action,
                      { backgroundColor: theme.text },
                      pressed && styles.pressed,
                      (notificationPermission === "loading" ||
                        notificationPermission === "unavailable") &&
                        styles.disabled,
                    ]}
                  >
                    <Text style={[styles.actionText, { color: theme.background }]}>
                      {actionLabel}
                    </Text>
                  </Pressable>
                </View>
                {notificationError ? (
                  <Text style={[styles.error, { color: theme.danger }]}>{notificationError}</Text>
                ) : null}
                <Text style={[styles.note, { color: theme.textFaint }]}>
                  OpenBot asks only when you enable alerts here. Delivery uses Apple Push
                  Notification service through Expo’s push gateway.
                </Text>

                <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>APPEARANCE</Text>
                <Pressable
                  accessibilityLabel="Appearance"
                  accessibilityRole="button"
                  onPress={() => setAppearanceOpen(true)}
                  style={({ pressed }) => [
                    styles.pluginEntry,
                    { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.pluginCopy}>
                    <Text style={[styles.title, { color: theme.text }]}>Appearance</Text>
                    <Text style={[styles.description, { color: theme.textMuted }]}>
                      Theme and accent
                    </Text>
                  </View>
                  <Text style={[styles.appearanceValue, { color: theme.textMuted }]}>
                    {appearance === "system" ? "System" : appearance === "light" ? "Day" : "Night"}
                  </Text>
                  <Text style={[styles.pluginChevron, { color: theme.textFaint }]}>›</Text>
                </Pressable>

                <Text style={[styles.botEyebrow, { color: theme.textMuted }]}>PLUGINS</Text>
                <Pressable
                  accessibilityHint="Install tools, authorize accounts, and manage Bot access"
                  accessibilityRole="button"
                  onPress={() => setPluginsOpen(true)}
                  style={({ pressed }) => [
                    styles.pluginEntry,
                    { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.pluginCopy}>
                    <Text style={[styles.title, { color: theme.text }]}>Manage plugins</Text>
                    <Text style={[styles.description, { color: theme.textMuted }]}>
                      Install, connect, and choose Bot access
                    </Text>
                  </View>
                  <Text style={[styles.pluginChevron, { color: theme.textFaint }]}>›</Text>
                </Pressable>

                {accountParitySections}

                {totalBotCount > BOT_ROSTER_SEARCH_THRESHOLD ? (
                  <TextInput
                    accessibilityLabel="Search Bot settings"
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    maxLength={120}
                    onChangeText={setBotQuery}
                    placeholder="Search Bots"
                    placeholderTextColor={theme.textFaint}
                    returnKeyType="search"
                    style={[
                      styles.botSearch,
                      {
                        backgroundColor: theme.field,
                        borderColor: theme.border,
                        color: theme.text,
                      },
                    ]}
                    value={botQuery}
                  />
                ) : null}
                {noBotMatches ? (
                  <Text style={[styles.noMatches, { color: theme.textMuted }]}>
                    No Bots match this search.
                  </Text>
                ) : null}
              </>
            }
            ListFooterComponent={
              hiddenError ? (
                <Text style={[styles.error, { color: theme.danger }]}>{hiddenError}</Text>
              ) : null
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    marginHorizontal: 8,
    marginTop: 114,
    marginBottom: 8,
    borderRadius: 34,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    height: 56,
    paddingHorizontal: 7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
  headerSpacer: { width: 38 },
  content: { paddingHorizontal: metrics.pageGutter, paddingTop: 26, paddingBottom: 48 },
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
  botSearch: {
    minHeight: 44,
    marginTop: 20,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  noMatches: { marginTop: 14, paddingHorizontal: 4, fontSize: 13, lineHeight: 18 },
  botRow: {
    minHeight: 64,
    paddingHorizontal: 18,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  botRowFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  botRowLast: { borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  botCopy: { flex: 1, gap: 2 },
  botName: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  botDetail: { fontSize: 12, lineHeight: 16 },
  appearanceValue: { fontSize: 13, lineHeight: 17 },
  pluginEntry: {
    minHeight: 72,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 17,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  pluginCopy: { flex: 1, gap: 2 },
  pluginChevron: { fontSize: 27, lineHeight: 31, fontWeight: "300" },
  showButton: { minWidth: 54, minHeight: 44, alignItems: "center", justifyContent: "center" },
  showButtonLabel: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  signOut: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  signOutLabel: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  infoCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 17,
    gap: 8,
  },
  infoRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  infoTitle: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  infoValue: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  infoDetail: { fontSize: 12, lineHeight: 17 },
  usageTrack: { height: 4, borderRadius: 2 },
  infoDivider: { height: StyleSheet.hairlineWidth, marginVertical: 5 },
  planPill: {
    alignSelf: "flex-start",
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  planPillText: { fontSize: 11, lineHeight: 14, fontWeight: "600" },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  accountAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  accountInitials: { fontSize: 13, lineHeight: 17, fontWeight: "700" },
  accountCopy: { flex: 1 },
  accountNote: { marginTop: 3, fontSize: 12, lineHeight: 17 },
  aboutCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 24,
    alignItems: "center",
  },
  appIcon: { width: 64, height: 64, borderRadius: 16 },
  aboutTitle: { marginTop: 10, fontSize: 20, lineHeight: 24, fontWeight: "600" },
  aboutVersion: { marginTop: 2, fontSize: 12, lineHeight: 16 },
  aboutCopyright: { marginTop: 12, fontSize: 12, lineHeight: 16 },
  copyVersion: {
    minHeight: 36,
    marginTop: 18,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  copyVersionText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
});
