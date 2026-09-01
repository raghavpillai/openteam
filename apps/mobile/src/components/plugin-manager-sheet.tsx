import type {
  PluginBotAccessItemView,
  PluginBotAccessView,
  PluginCatalogItemView,
  PluginConnectionView,
  PluginSettingsView,
} from "@openbot/contracts";
import {
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  PLUGIN_BOT_ACCESS_QUERY_MAX_LENGTH,
} from "@openbot/contracts/plugin-settings";
import {
  executePluginAccessTransition,
  planPluginConnectionGrant,
  planPluginSkillAccess,
} from "@openbot/product-core/plugin-access";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useOpenBot } from "../state/openbot-context";
import { useTheme } from "../theme";

const emptySettings = (): PluginSettingsView => ({
  catalog: [],
  installs: [],
  botCount: 0,
  policies: [],
  activity: [],
});

interface MutationOptions {
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
    installPlugin,
    pluginBotAccess,
    pluginSettings,
    setPluginEnablement,
    setPluginGrant,
    uninstallPlugin,
  } = useOpenBot();
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
        setError(clientErrorMessage(cause, "OpenBot could not load plugins."));
      }
    } finally {
      if (settingsRequestId.current === requestId) setLoading(false);
    }
  }, [pluginSettings]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [refresh, visible]);

  const mutate = useCallback(
    async (key: string, operation: () => Promise<void>, options: MutationOptions = {}) => {
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      setMutationKey(key);
      setError(null);
      options.optimistic?.();
      try {
        await operation();
        if (options.refreshSettings !== false) await refresh();
      } catch (cause) {
        options.rollback?.();
        setError(clientErrorMessage(cause, "OpenBot could not update this plugin."));
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
              setError(clientErrorMessage(cause, "OpenBot could not load Bot access."));
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
    const fields = plugin.setup?.fields ?? plugin.setupFields;
    if (fields.length === 0) {
      void mutate(plugin.key, () => installPlugin(plugin.key));
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
    const key = `connection:${connection.id}`;
    if (connection.status === "ready") {
      void mutate(key, () => disconnectPlugin(connection.id));
      return;
    }
    if (connection.canAuthenticate || connection.status === "needs_auth") {
      void mutate(key, async () => {
        const authorizationUrl = await authenticatePlugin(connection.id);
        if (authorizationUrl) await Linking.openURL(authorizationUrl);
      });
      return;
    }
    void mutate(key, () => connectPlugin(connection.id));
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { borderBottomColor: theme.separator }]}>
          <Pressable
            accessible
            accessibilityLabel="Close plugin manager"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionText, { color: theme.accent }]}>Done</Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Plugins</Text>
          <Pressable
            accessibilityLabel="Refresh plugins"
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={styles.headerAction}
          >
            {loading ? (
              <ActivityIndicator color={theme.accent} size="small" />
            ) : (
              <Text style={[styles.headerActionText, { color: theme.accent }]}>Refresh</Text>
            )}
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
                      <Pressable
                        accessibilityRole="button"
                        disabled={Boolean(mutationKey)}
                        onPress={() => connectionAction(connection)}
                        style={({ pressed }) => [
                          styles.compactButton,
                          { borderColor: theme.border },
                          pressed && styles.pressed,
                        ]}
                      >
                        {mutationKey === `connection:${connection.id}` ? (
                          <ActivityIndicator color={theme.text} size="small" />
                        ) : (
                          <Text style={[styles.compactLabel, { color: theme.text }]}>
                            {connection.status === "ready"
                              ? "Disconnect"
                              : connection.canAuthenticate || connection.status === "needs_auth"
                                ? "Authorize"
                                : "Connect"}
                          </Text>
                        )}
                      </Pressable>
                    </View>
                  ))}
                  <View style={styles.cardActions}>
                    {install.hasSkills || install.connections.length > 0 ? (
                      <Pressable
                        accessibilityLabel={`Manage ${install.name} Bot access`}
                        accessibilityRole="button"
                        onPress={() => openAccess(install.pluginKey)}
                        style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
                      >
                        <Text style={[styles.textButtonLabel, { color: theme.accent }]}>
                          Bot access
                        </Text>
                      </Pressable>
                    ) : (
                      <View />
                    )}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        Alert.alert(
                          `Remove ${install.name}?`,
                          "This disconnects its accounts and removes it from OpenBot.",
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
                      style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
                    >
                      <Text style={[styles.textButtonLabel, { color: theme.danger }]}>Remove</Text>
                    </Pressable>
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
                <Pressable
                  accessibilityRole="button"
                  onPress={closeAccess}
                  style={styles.textButton}
                >
                  <Text style={[styles.textButtonLabel, { color: theme.accent }]}>Close</Text>
                </Pressable>
              </View>
              <TextInput
                accessibilityLabel="Filter Bot access"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
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
                        trackColor={{ false: theme.surfacePressed, true: theme.text }}
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
                          trackColor={{ false: theme.surfacePressed, true: theme.text }}
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
                  <Pressable
                    accessibilityLabel="Previous Bot access page"
                    accessibilityRole="button"
                    disabled={accessLoading || access.offset === 0}
                    onPress={() =>
                      setAccessOffset(Math.max(0, access.offset - PLUGIN_BOT_ACCESS_PAGE_SIZE))
                    }
                    style={({ pressed }) => [styles.pageButton, pressed && styles.pressed]}
                  >
                    <Text style={[styles.pageLabel, { color: theme.accent }]}>Previous</Text>
                  </Pressable>
                  <Text style={[styles.pageCount, { color: theme.textMuted }]}>
                    {access.bots.length ? access.offset + 1 : 0}–
                    {access.offset + access.bots.length} of {access.total}
                  </Text>
                  <Pressable
                    accessibilityLabel="Next Bot access page"
                    accessibilityRole="button"
                    disabled={accessLoading || access.offset + access.bots.length >= access.total}
                    onPress={() => setAccessOffset(access.offset + PLUGIN_BOT_ACCESS_PAGE_SIZE)}
                    style={({ pressed }) => [styles.pageButton, pressed && styles.pressed]}
                  >
                    <Text style={[styles.pageLabel, { color: theme.accent }]}>Next</Text>
                  </Pressable>
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
                <View style={styles.flex}>
                  <Text style={[styles.title, { color: theme.text }]}>{plugin.name}</Text>
                  <Text numberOfLines={2} style={[styles.description, { color: theme.textMuted }]}>
                    {plugin.description}
                  </Text>
                  <Text style={[styles.publisher, { color: theme.textFaint }]}>
                    {plugin.publisher} · {plugin.category}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={installed || Boolean(mutationKey)}
                  onPress={() => beginInstall(plugin)}
                  style={({ pressed }) => [
                    styles.installButton,
                    { backgroundColor: installed ? theme.surfacePressed : theme.text },
                    pressed && styles.pressed,
                  ]}
                >
                  {mutationKey === plugin.key ? (
                    <ActivityIndicator color={theme.background} size="small" />
                  ) : (
                    <Text
                      style={[
                        styles.installLabel,
                        { color: installed ? theme.textMuted : theme.background },
                      ]}
                    >
                      {installed ? "Installed" : "Install"}
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
          {!loading && visibleCatalog.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>No plugins found.</Text>
          ) : null}
        </ScrollView>

        {setupPlugin ? (
          <View
            style={[
              styles.setup,
              { backgroundColor: theme.background, borderTopColor: theme.separator },
            ]}
          >
            <Text style={[styles.title, { color: theme.text }]}>Set up {setupPlugin.name}</Text>
            <Text style={[styles.description, { color: theme.textMuted }]}>
              {setupPlugin.setup?.description || "Enter the credentials required by this plugin."}
            </Text>
            {(setupPlugin.setup?.fields ?? setupPlugin.setupFields).map((field) => (
              <TextInput
                accessibilityLabel={field.label}
                autoCapitalize="none"
                autoCorrect={false}
                key={field.key}
                onChangeText={(value) =>
                  setSetupValues((current) => ({ ...current, [field.key]: value }))
                }
                placeholder={
                  "placeholder" in field && typeof field.placeholder === "string"
                    ? field.placeholder
                    : field.label
                }
                placeholderTextColor={theme.textFaint}
                secureTextEntry={field.secret}
                style={[
                  styles.search,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={setupValues[field.key] ?? ""}
              />
            ))}
            <View style={styles.setupActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSetupPlugin(null)}
                style={styles.setupButton}
              >
                <Text style={[styles.compactLabel, { color: theme.textMuted }]}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const plugin = setupPlugin;
                  setSetupPlugin(null);
                  void mutate(plugin.key, () => installPlugin(plugin.key, setupValues));
                }}
                style={[styles.setupButton, { backgroundColor: theme.text }]}
              >
                <Text style={[styles.compactLabel, { color: theme.background }]}>Install</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    minHeight: 58,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerAction: { width: 72, minHeight: 44, alignItems: "center", justifyContent: "center" },
  headerActionText: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  headerTitle: { fontSize: 16, lineHeight: 21, fontWeight: "700" },
  content: { padding: 18, paddingBottom: 54, gap: 12 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 6 },
  error: { fontSize: 13, lineHeight: 18, marginBottom: 4 },
  eyebrow: { marginTop: 14, fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 0.7 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 15, gap: 9 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  publisher: { fontSize: 11, lineHeight: 15 },
  status: { fontSize: 11, lineHeight: 15, fontWeight: "600", textTransform: "capitalize" },
  description: { fontSize: 12, lineHeight: 17 },
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
  compactButton: {
    minWidth: 82,
    minHeight: 38,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  compactLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  cardActions: { flexDirection: "row", justifyContent: "space-between" },
  textButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 4 },
  textButtonLabel: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
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
  pageButton: { minHeight: 40, minWidth: 68, alignItems: "center", justifyContent: "center" },
  pageLabel: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
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
  installButton: {
    minWidth: 72,
    minHeight: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  installLabel: { fontSize: 12, lineHeight: 16, fontWeight: "700" },
  empty: { paddingVertical: 14, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.65 },
  setup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 10,
  },
  setupActions: { flexDirection: "row", justifyContent: "flex-end", gap: 9 },
  setupButton: {
    minWidth: 82,
    minHeight: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
});
