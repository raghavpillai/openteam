import { PluginSetupSheet } from "./plugins/plugin-setup-sheet";
import { useInstallPlugin } from "./plugins/use-install-plugin";
import { NativeActionButton, NativeToolbarButton } from "./native-controls";
import * as Haptics from "../haptics";
import { PluginMark } from "./plugins/plugin-mark";
import { PluginWorkspace } from "./plugin-workspace";
import type {
  PluginBotAccessItemView,
  PluginBotAccessView,
  PluginCatalogItemView,
  PluginConnectionView,
  PluginSettingsView,
} from "@openteam/contracts";
import {
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
} from "@openteam/contracts/plugin-settings";
import {
  executePluginAccessTransition,
  planPluginConnectionGrant,
  planPluginSkillAccess,
} from "@openteam/product-core/plugin-access";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";
import { PluginAuthorization } from "./plugins/plugin-authorization";
import { pluginAuthorization, pluginNeedsSetup } from "@openteam/product-core/plugin-authorization";

const emptySettings = (): PluginSettingsView => ({
  catalog: [],
  installs: [],
  botCount: 0,
  policies: [],
  activity: [],
});

interface MutationOptions {
  successFeedback?: boolean;
  optimistic?: () => void;
  rollback?: () => void;
  refreshSettings?: boolean;
}

export function PluginManagerSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const {
    authenticatePlugin,
    connectPlugin,
    disconnectPlugin,
    pluginBotAccess,
    pluginSettings,
    pluginOperation,
    setPluginEnablement,
    setPluginGrant,
    uninstallPlugin,
  } = useOpenTeam();
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementConnectionId, setManagementConnectionId] = useState<string>();
  const [data, setData] = useState<PluginSettingsView>(emptySettings);
  const [loading, setLoading] = useState(false);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [setupPlugin, setSetupPlugin] = useState<PluginCatalogItemView | null>(null);
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const [accessPluginKey, setAccessPluginKey] = useState<string | null>(null);
  const [accessQuery, setAccessQuery] = useState("");
  const [accessOffset, setAccessOffset] = useState(0);
  const [access, setAccess] = useState<PluginBotAccessView | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const settingsRequestId = useRef(0);
  const mutationInFlight = useRef(false);
  const installAndConnect = useInstallPlugin(connection => {
    setManagementConnectionId(connection.id);
    setManagementOpen(true);
  });

  const refresh = useCallback(async () => {
    const requestId = settingsRequestId.current + 1;
    settingsRequestId.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const next = await pluginSettings();
      if (settingsRequestId.current === requestId) setData(next);
    } catch (cause) {
      if (settingsRequestId.current === requestId) {
        setError(clientErrorMessage(cause, "OpenTeam could not load plugins."));
      }
    } finally {
      if (settingsRequestId.current === requestId) setLoading(false);
    }
  }, [pluginSettings]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (!visible) return;
    const refreshWhenActive = () => {
      if (AppState.currentState === "active") void refresh();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    const timer = setInterval(refreshWhenActive, 5_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [refresh, visible]);

  const mutate = useCallback(
    async (key: string, operation: () => Promise<void>, options: MutationOptions = {}) => {
      if (mutationInFlight.current) return false;
      mutationInFlight.current = true;
      setMutationKey(key);
      setError(null);
      options.optimistic?.();
      try {
        await operation();
        if (options.refreshSettings !== false) await refresh();
        // Native switches already acknowledge access toggles. Only completed commands
        // need a separate success notification.
        if (!options.optimistic && options.successFeedback !== false) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        return true;
      } catch (cause) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        options.rollback?.();
        if (options.refreshSettings !== false) await refresh();
        setError(clientErrorMessage(cause, "OpenTeam could not update this plugin."));
        return false;
      } finally {
        mutationInFlight.current = false;
        setMutationKey(null);
      }
    },
    [refresh]
  );

  const installsByKey = useMemo(
    () => new Map(data.installs.map((install) => [install.pluginKey, install] as const)),
    [data.installs]
  );
  const visibleCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return data.catalog;
    return data.catalog.filter((plugin) =>
      [plugin.name, plugin.description, plugin.publisher, plugin.category]
        .join(" ")
        .toLocaleLowerCase("en-US")
        .includes(needle)
    );
  }, [data.catalog, query]);
  const accessInstall = useMemo(
    () => data.installs.find((install) => install.pluginKey === accessPluginKey) ?? null,
    [accessPluginKey, data.installs]
  );

  useEffect(() => {
    if (!visible || !accessPluginKey) {
      setAccessLoading(false);
      return;
    }
    const controller = new AbortController();
    setAccess(null);
    setAccessLoading(true);
    setError(null);
    const timer = setTimeout(
      () => {
        void pluginBotAccess(accessPluginKey, {
          query: accessQuery,
          offset: accessOffset,
          limit: PLUGIN_BOT_ACCESS_PAGE_SIZE,
          signal: controller.signal,
        })
          .then((next) => {
            if (!controller.signal.aborted && next.pluginKey === accessPluginKey) setAccess(next);
          })
          .catch((cause) => {
            if (!controller.signal.aborted) {
              setError(clientErrorMessage(cause, "OpenTeam could not load Bot access."));
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setAccessLoading(false);
          });
      },
      accessQuery ? 150 : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessOffset, accessPluginKey, accessQuery, pluginBotAccess, visible]);

  useEffect(() => {
    if (!accessPluginKey || accessInstall) return;
    setAccessPluginKey(null);
    setAccess(null);
    setAccessOffset(0);
    setAccessQuery("");
  }, [accessInstall, accessPluginKey]);

  const beginInstall = (plugin: PluginCatalogItemView) => {
    const fields = plugin.setupFields;
    if (fields.length === 0) {
      void mutate(plugin.key, () => installAndConnect(plugin));
      return;
    }
    setSetupValues({});
    setSetupPlugin(plugin);
  };

  const openAccess = (pluginKey: string) => {
    setAccessPluginKey(pluginKey);
    setAccess(null);
    setAccessOffset(0);
    setAccessQuery("");
    setError(null);
  };

  const closeAccess = () => {
    setAccessPluginKey(null);
    setAccess(null);
    setAccessOffset(0);
    setAccessQuery("");
  };

  const updateAccessBot = (
    botId: string,
    update: (bot: PluginBotAccessItemView) => PluginBotAccessItemView
  ) => {
    setAccess((current) =>
      current
        ? {
            ...current,
            bots: current.bots.map((bot) => (bot.id === botId ? update(bot) : bot)),
          }
        : current
    );
  };

  const changeSkillAccess = (bot: PluginBotAccessItemView, enabled: boolean) => {
    if (!accessPluginKey) return;
    const transition = planPluginSkillAccess(accessPluginKey, bot, enabled);
    void mutate(
      `skill:${bot.id}`,
      () =>
        executePluginAccessTransition(transition, {
          setEnablement: setPluginEnablement,
          setGrant: setPluginGrant,
        }),
      {
        optimistic: () => updateAccessBot(bot.id, () => transition.next),
        rollback: () => updateAccessBot(bot.id, () => transition.previous),
        refreshSettings: false,
      }
    );
  };

  const changeConnectionGrant = (
    bot: PluginBotAccessItemView,
    connection: PluginConnectionView,
    enabled: boolean
  ) => {
    if (!accessPluginKey) return;
    const transition = planPluginConnectionGrant(accessPluginKey, bot, connection.id, enabled);
    void mutate(
      `grant:${connection.id}:${bot.id}`,
      () =>
        executePluginAccessTransition(transition, {
          setEnablement: setPluginEnablement,
          setGrant: setPluginGrant,
        }),
      {
        optimistic: () => updateAccessBot(bot.id, () => transition.next),
        rollback: () => updateAccessBot(bot.id, () => transition.previous),
        refreshSettings: false,
      }
    );
  };

  const connectionAction = (connection: PluginConnectionView) => {
    const catalog = data.installs.find(install => install.pluginKey === connection.pluginKey)?.catalog;
    if (pluginNeedsSetup(connection, catalog)) {
      setManagementConnectionId(connection.id);
      setManagementOpen(true);
      return;
    }
    const key = `connection:${connection.id}`;
    if (connection.status === "error") {
      void mutate(key, async () => { await pluginOperation(api => api.restartPluginConnection(connection.id)); });
      return;
    }
    if (connection.status === "ready") {
      void mutate(key, () => disconnectPlugin(connection.id));
      return;
    }
    if (connection.auth === "oauth") {
      void mutate(
        key,
        async () => {
          const authorizationUrl = await authenticatePlugin(connection.id);
          if (authorizationUrl) await Linking.openURL(authorizationUrl);
        },
        { successFeedback: false }
      );
      return;
    }
    void mutate(key, () => connectPlugin(connection.id));
  };

  if (managementOpen)
    return (
      <Modal
        visible={visible}
        animationType="slide"
        onRequestClose={() => setManagementOpen(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
          <View style={[styles.header, { borderBottomColor: theme.separator }]}>
            <NativeToolbarButton
              name="chevron.left"
              label="Back to plugins"
              onPress={() => setManagementOpen(false)}
            />
            <Text style={{ color: theme.text, fontWeight: "600" }}>Manage plugins</Text>
            <NativeToolbarButton name="xmark" label="Close plugin manager" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
            <PluginWorkspace
              settings={data}
              refresh={refresh}
              initialConnectionId={managementConnectionId}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <NativeToolbarButton
            name="chevron.left"
            label="Back to plugin catalog"
            onPress={onClose}
          />
          <Text style={[styles.headerTitle, { color: theme.text }]}>Plugins</Text>
          <NativeActionButton
            title="Refresh"
            label="Refresh plugins"
            variant="plain"
            busy={loading}
            style={{ alignSelf: "center" }}
            onPress={() => void refresh()}
          />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <NativeActionButton
            title="Manage plugins"
            label="Manage accounts, private skills, sources, and packages"
            variant="tinted"
            onPress={() => setManagementOpen(true)}
          />
          <Text style={[styles.intro, { color: theme.textMuted }]}>
            Install tools, authorize accounts, and choose which Bots can use each plugin.
          </Text>
          {error ? (
            <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>
              {error}
            </Text>
          ) : null}

          {data.installs.length ? (
            <>
              <Text style={[styles.eyebrow, { color: theme.textMuted }]}>INSTALLED</Text>
              {data.installs.map((install) => (
                <View
                  key={install.id}
                  style={[
                    styles.card,
                    { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                  ]}
                >
                  <View style={styles.titleLine}>
                    <PluginMark
                      logoUrl={
                        install.catalog?.logoUrl ??
                        data.catalog.find((p) => p.key === install.pluginKey)?.logoUrl
                      }
                      size={40}
                    />
                    <View style={styles.flex}>
                      <Text style={[styles.title, { color: theme.text }]}>{install.name}</Text>
                      <Text style={[styles.publisher, { color: theme.textMuted }]}>
                        {install.publisher} · {install.version}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.status,
                        { color: install.status === "installed" ? theme.success : theme.danger },
                      ]}
                    >
                      {install.status}
                    </Text>
                  </View>
                  <Text style={[styles.description, { color: theme.textMuted }]}>
                    {install.description}
                  </Text>
                  {install.connections.map((connection) => (
                    <View
                      key={connection.id}
                      style={[styles.connection, { borderTopColor: theme.separator }]}
                    >
                      <View style={styles.flex}>
                        <Text style={[styles.connectionName, { color: theme.text }]}>
                          {connection.alias || connection.name}
                        </Text>
                        <Text style={[styles.connectionDetail, { color: theme.textMuted }]}>
                          {connection.statusMessage || connection.status.replace("_", " ")}
                        </Text>
                      </View>
                      <NativeActionButton
                        title={
                          connection.status === "ready"
                            ? "Disconnect"
                            : connection.status === "error" ? "Retry"
                            : pluginAuthorization(connection) ? pluginAuthorization(connection)?.expired ? "Try again" : "Reopen"
                            : pluginNeedsSetup(connection, install.catalog) ? "Set up"
                            : connection.auth === "oauth"
                              ? "Authorize"
                              : "Connect"
                        }
                        disabled={Boolean(mutationKey)}
                        busy={mutationKey === `connection:${connection.id}`}
                        onPress={() => connectionAction(connection)}
                        style={{ alignSelf: "center" }}
                      />
                    </View>
                  ))}
                  {install.connections.map(connection => <PluginAuthorization key={`auth:${connection.id}`} connection={connection} refresh={refresh} />)}
                  <View style={styles.cardActions}>
                    {install.hasSkills || install.connections.length > 0 ? (
                      <NativeActionButton
                        title="Bot access"
                        variant="plain"
                        label={`Manage ${install.name} Bot access`}
                        onPress={() => openAccess(install.pluginKey)}
                      />
                    ) : (
                      <View />
                    )}
                    <NativeActionButton
                      title="Remove"
                      variant="plain"
                      destructive
                      onPress={() =>
                        Alert.alert(
                          `Remove ${install.name}?`,
                          "This disconnects its accounts and removes it from OpenTeam.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Remove Plugin",
                              style: "destructive",
                              onPress: () =>
                                void mutate(install.pluginKey, () =>
                                  uninstallPlugin(install.pluginKey)
                                ),
                            },
                          ]
                        )
                      }
                    />
                  </View>
                </View>
              ))}
            </>
          ) : null}

          {accessPluginKey ? (
            <View style={[styles.accessPanel, { backgroundColor: theme.surface }]}>
              <View style={styles.titleLine}>
                <View style={styles.flex}>
                  <Text style={[styles.title, { color: theme.text }]}>Bot access</Text>
                  {accessInstall ? (
                    <Text style={[styles.publisher, { color: theme.textMuted }]}>
                      {accessInstall.name}
                    </Text>
                  ) : null}
                </View>
                <NativeActionButton title="Close" variant="plain" onPress={closeAccess} />
              </View>
              <TextInput
                accessibilityLabel="Filter Bot access"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                keyboardAppearance={theme.dark ? "dark" : "light"}
                returnKeyType="search"
                maxLength={PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH}
                onChangeText={(value) => {
                  setAccessOffset(0);
                  setAccessQuery(value);
                }}
                placeholder="Filter Bots"
                placeholderTextColor={theme.textFaint}
                style={[
                  styles.search,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={accessQuery}
              />
              {accessLoading && !access ? (
                <ActivityIndicator color={theme.textMuted} style={styles.accessLoading} />
              ) : null}
              {access?.bots.map((bot) => (
                <View
                  key={bot.id}
                  style={[styles.botAccessCard, { borderTopColor: theme.separator }]}
                >
                  <Text numberOfLines={1} style={[styles.botName, { color: theme.text }]}>
                    {bot.name}
                  </Text>
                  {accessInstall?.hasSkills ? (
                    <View style={styles.accessToggleRow}>
                      <Text style={[styles.accessToggleLabel, { color: theme.textMuted }]}>
                        Plugin skills
                      </Text>
                      <Switch
                        accessibilityLabel={`${bot.name} plugin skills`}
                        disabled={Boolean(mutationKey)}
                        onValueChange={(enabled) => changeSkillAccess(bot, enabled)}
                        trackColor={{ false: theme.surfacePressed, true: "#34C759" }}
                        value={bot.skillsEnabled}
                      />
                    </View>
                  ) : null}
                  {accessInstall?.connections.map((connection) => {
                    const label = connection.alias || connection.name;
                    return (
                      <View key={connection.id} style={styles.accessToggleRow}>
                        <Text
                          numberOfLines={1}
                          style={[styles.accessToggleLabel, { color: theme.textMuted }]}
                        >
                          {label}
                        </Text>
                        <Switch
                          accessibilityLabel={`${bot.name} ${label} access`}
                          disabled={Boolean(mutationKey)}
                          onValueChange={(enabled) =>
                            changeConnectionGrant(bot, connection, enabled)
                          }
                          trackColor={{ false: theme.surfacePressed, true: "#34C759" }}
                          value={bot.grantedConnectionIds.includes(connection.id)}
                        />
                      </View>
                    );
                  })}
                </View>
              ))}
              {!accessLoading && access && access.total === 0 ? (
                <Text style={[styles.empty, { color: theme.textMuted }]}>No Bots match.</Text>
              ) : null}
              {access &&
              (access.offset > 0 || access.offset + access.bots.length < access.total) ? (
                <View style={styles.pagination}>
                  <NativeActionButton
                    title="Previous"
                    variant="plain"
                    label="Previous Bot access page"
                    disabled={accessLoading || access.offset === 0}
                    onPress={() =>
                      setAccessOffset(Math.max(0, access.offset - PLUGIN_BOT_ACCESS_PAGE_SIZE))
                    }
                  />
                  <Text style={[styles.pageCount, { color: theme.textMuted }]}>
                    {access.bots.length ? access.offset + 1 : 0}–
                    {access.offset + access.bots.length} of {access.total}
                  </Text>
                  <NativeActionButton
                    title="Next"
                    variant="plain"
                    label="Next Bot access page"
                    disabled={accessLoading || access.offset + access.bots.length >= access.total}
                    onPress={() => setAccessOffset(access.offset + PLUGIN_BOT_ACCESS_PAGE_SIZE)}
                  />
                </View>
              ) : access ? (
                <Text style={[styles.pageCount, { color: theme.textMuted }]}>
                  {access.total} {access.total === 1 ? "Bot" : "Bots"}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Text style={[styles.eyebrow, { color: theme.textMuted }]}>CATALOG</Text>
          <TextInput
            accessibilityLabel="Search plugins"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            keyboardAppearance={theme.dark ? "dark" : "light"}
            returnKeyType="search"
            onChangeText={setQuery}
            placeholder="Search plugins"
            placeholderTextColor={theme.textFaint}
            style={[
              styles.search,
              { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
            ]}
            value={query}
          />
          {visibleCatalog.map((plugin) => {
            const installed = installsByKey.has(plugin.key);
            return (
              <View
                key={plugin.key}
                style={[
                  styles.catalogRow,
                  { backgroundColor: theme.surfaceElevated, borderColor: theme.border },
                ]}
              >
                <PluginMark logoUrl={plugin.logoUrl} size={40} />
                <View style={styles.flex}>
                  <Text style={[styles.title, { color: theme.text }]}>{plugin.name}</Text>
                  <Text numberOfLines={2} style={[styles.description, { color: theme.textMuted }]}>
                    {plugin.description}
                  </Text>
                  <Text style={[styles.publisher, { color: theme.textFaint }]}>
                    {plugin.publisher} · {plugin.category}
                  </Text>
                </View>
                <NativeActionButton
                  title={installed ? "Installed" : "Install"}
                  label={`${installed ? "Installed" : "Install"} ${plugin.name}`}
                  disabled={installed || Boolean(mutationKey)}
                  busy={mutationKey === plugin.key}
                  onPress={() => beginInstall(plugin)}
                  style={{ alignSelf: "center" }}
                />
              </View>
            );
          })}
          {!loading && visibleCatalog.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>No plugins found.</Text>
          ) : null}
        </ScrollView>

        {setupPlugin ? (
          <PluginSetupSheet
            busy={Boolean(mutationKey)}
            error={error}
            plugin={setupPlugin}
            values={setupValues}
            onChange={(key, value) => setSetupValues((current) => ({ ...current, [key]: value }))}
            onCancel={() => { setSetupPlugin(null); setSetupValues({}); }}
            onInstall={async () => {
              const plugin = setupPlugin;
              if (await mutate(plugin.key, () => installAndConnect(plugin, setupValues))) {
                setSetupPlugin(null);
                setSetupValues({});
              }
            }}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    minHeight: 68,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  content: { padding: 18, paddingBottom: 54, gap: 12 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 6 },
  error: { fontSize: 13, lineHeight: 18, marginBottom: 4 },
  eyebrow: { marginTop: 14, fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 0.7 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 15, gap: 9 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  publisher: { fontSize: 13, lineHeight: 18 },
  status: { fontSize: 11, lineHeight: 15, fontWeight: "600", textTransform: "capitalize" },
  description: { fontSize: 15, lineHeight: 20 },
  connection: {
    minHeight: 58,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  connectionName: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  connectionDetail: { fontSize: 11, lineHeight: 15, textTransform: "capitalize" },
  cardActions: { flexDirection: "row", justifyContent: "space-between" },
  accessPanel: { borderRadius: 18, padding: 15, gap: 7 },
  accessLoading: { minHeight: 72 },
  botAccessCard: {
    minHeight: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    gap: 5,
  },
  botName: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600" },
  accessToggleRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 12 },
  accessToggleLabel: { flex: 1, fontSize: 12, lineHeight: 17 },
  pagination: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  pageCount: { textAlign: "center", fontSize: 11, lineHeight: 16 },
  search: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 13,
    fontSize: 14,
  },
  catalogRow: {
    minHeight: 94,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 17,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  empty: { paddingVertical: 14, fontSize: 13, lineHeight: 18 },
});
