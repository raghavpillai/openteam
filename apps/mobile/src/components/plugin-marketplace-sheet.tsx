import { PluginSetupSheet } from "./plugins/plugin-setup-sheet";
import { useInstallPlugin } from "./plugins/use-install-plugin";
import * as Haptics from "../haptics";
import {
  PLUGIN_MARKETPLACE_CATEGORIES,
  type PluginMarketplaceCategory,
  pluginMatchesMarketplaceCategory,
} from "@openteam/client-core/plugin-marketplace";
import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { pluginAuthorization, pluginNeedsSetup } from "@openteam/product-core/plugin-authorization";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useOpenTeam } from "../state/openteam-context";
import { useTheme } from "../theme";
import { PluginMark } from "./plugins/plugin-mark";
import { GlassSurface } from "./glass-surface";
import { NativeActionButton, NativeToolbarButton } from "./native-controls";
import { PluginManagerSheet as InstalledPluginManager } from "./plugin-manager-sheet";

const emptySettings = (): PluginSettingsView => ({
  catalog: [],
  installs: [],
  botCount: 0,
  policies: [],
  activity: [],
});

function MarketplaceRow({
  busy,
  install,
  onAction,
  plugin,
}: {
  busy: boolean;
  install: PluginInstallView | null;
  onAction: () => void;
  plugin: PluginCatalogItemView;
}) {
  const theme = useTheme();
  const connection = install?.connections[0];
  const actionLabel = !install
    ? "Add"
    : !connection || connection.status === "ready" ? "Added"
    : connection.status === "error" ? "Retry"
    : pluginAuthorization(connection) ? pluginAuthorization(connection)?.expired ? "Try again" : "Reopen"
    : pluginNeedsSetup(connection, plugin) ? "Set up"
    : connection.auth === "oauth" ? "Authorize" : "Connect";
  const primary = actionLabel === "Authorize";
  return (
    <View style={styles.pluginRow}>
      <PluginMark logoUrl={plugin.logoUrl} />
      <View style={styles.pluginCopy}>
        <Text numberOfLines={1} style={[styles.pluginName, { color: theme.text }]}>
          {plugin.name}
        </Text>
        <Text numberOfLines={2} style={[styles.pluginDescription, { color: theme.textMuted }]}>
          {plugin.description}
        </Text>
      </View>
      <NativeActionButton
        title={actionLabel}
        label={`${actionLabel} ${plugin.name}`}
        disabled={busy}
        busy={busy}
        onPress={onAction}
        variant={primary ? "filled" : "tinted"}
        style={{ alignSelf: "center" }}
      />
    </View>
  );
}

function SectionHeading({
  children,
  onViewAll,
}: {
  children: React.ReactNode;
  onViewAll?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeading}>
      <Text style={[styles.sectionTitle, { color: theme.textFaint }]}>{children}</Text>
      {onViewAll ? (
        <NativeActionButton
          title="View all"
          label={`View all ${children}`}
          onPress={onViewAll}
          variant="plain"
        />
      ) : null}
    </View>
  );
}

export function PluginMarketplaceSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { authenticatePlugin, connectPlugin, pluginSettings, pluginOperation } = useOpenTeam();
  const [data, setData] = useState<PluginSettingsView>(emptySettings);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PluginMarketplaceCategory>("All");
  const [installedOpen, setInstalledOpen] = useState(false);
  const [setupPlugin, setSetupPlugin] = useState<PluginCatalogItemView | null>(null);
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const requestId = useRef(0);
  const mutating = useRef(false);
  const installAndConnect = useInstallPlugin(() => setInstalledOpen(true));

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await pluginSettings();
      if (requestId.current === id) setData(next);
    } catch (cause) {
      if (requestId.current === id) {
        setError(clientErrorMessage(cause, "OpenTeam could not load plugins."));
      }
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [pluginSettings]);

  useEffect(() => {
    if (visible && !installedOpen) void refresh();
  }, [installedOpen, refresh, visible]);
  useEffect(() => {
    if (!visible || installedOpen) return;
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => subscription.remove();
  }, [visible, installedOpen, refresh]);

  const installs = useMemo(
    () => new Map(data.installs.map((install) => [install.pluginKey, install] as const)),
    [data.installs]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const filtered = useMemo(
    () =>
      data.catalog.filter(
        (plugin) =>
          pluginMatchesMarketplaceCategory(plugin, category) &&
          (!normalizedQuery ||
            `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.category}`
              .toLocaleLowerCase("en-US")
              .includes(normalizedQuery))
      ),
    [category, data.catalog, normalizedQuery]
  );
  const featured = data.catalog.filter((plugin) => plugin.featured);
  const teamPlugins = data.catalog.filter((plugin) => !plugin.featured);

  const mutate = async (
    key: string,
    action: () => Promise<void>,
    options: { successFeedback?: boolean } = {}
  ) => {
    if (mutating.current) return false;
    mutating.current = true;
    setBusyKey(key);
    setError(null);
    try {
      await action();
      await refresh();
      if (options.successFeedback !== false) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      return true;
    } catch (cause) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      await refresh();
      setError(clientErrorMessage(cause, "OpenTeam could not update this plugin."));
      return false;
    } finally {
      mutating.current = false;
      setBusyKey(null);
    }
  };

  const beginInstall = (plugin: PluginCatalogItemView) => {
    const fields = plugin.setupFields;
    if (fields.length > 0) {
      setSetupPlugin(plugin);
      setSetupValues({});
      return;
    }
    void mutate(plugin.key, () => installAndConnect(plugin));
  };

  const handleConnection = (connection: PluginConnectionView) => {
    const key = `connection:${connection.id}`;
    if (connection.status === "error") {
      void mutate(key, async () => { await pluginOperation(api => api.restartPluginConnection(connection.id)); });
      return;
    }
    if (connection.status === "ready") {
      setInstalledOpen(true);
      return;
    }
    if (pluginNeedsSetup(connection, installs.get(connection.pluginKey)?.catalog)) {
      setInstalledOpen(true);
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

  const pluginAction = (plugin: PluginCatalogItemView) => {
    const install = installs.get(plugin.key);
    if (!install) {
      beginInstall(plugin);
      return;
    }
    const connection = install.connections[0];
    if (connection) handleConnection(connection);
    else setInstalledOpen(true);
  };

  if (!visible) return null;
  if (installedOpen) {
    return (
      <InstalledPluginManager
        onClose={() => {
          setInstalledOpen(false);
          void refresh();
        }}
        visible
      />
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.dark ? "#141414" : theme.background }]}>
      <View style={styles.header}>
        <NativeToolbarButton
          label="Back to settings"
          name="chevron.left"
          onPress={onClose}
          symbolSize={18}
        />
        <Text style={[styles.headerTitle, { color: theme.text }]}>Plugins</Text>
        <NativeActionButton
          title={`${data.installs.length} installed`}
          label={`${data.installs.length} installed plugins`}
          onPress={() => setInstalledOpen(true)}
          variant="glass"
          style={{ alignSelf: "center" }}
        />
      </View>

      <View style={styles.searchRow}>
        <GlassSurface
          fallbackColor={theme.field}
          interactive
          style={[styles.searchWrap, { borderColor: theme.border }]}
        >
          <SymbolView name="magnifyingglass" size={16} tintColor={theme.textFaint} />
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
            style={[styles.searchInput, { color: theme.text }]}
            value={query}
          />
        </GlassSurface>
        <NativeToolbarButton
          label={`Filter plugins: ${category}`}
          name="line.3.horizontal.decrease"
          actions={PLUGIN_MARKETPLACE_CATEGORIES.map((item) => ({
            id: item,
            title: item,
            selected: item === category,
          }))}
          onAction={(id) => {
            const next = PLUGIN_MARKETPLACE_CATEGORIES.find((item) => item === id);
            if (next && next !== category) {
              void Haptics.selectionAsync();
              setCategory(next);
            }
          }}
          symbolSize={18}
        />
      </View>

      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.catalogContent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {loading && data.catalog.length === 0 ? (
          <ActivityIndicator color={theme.textMuted} style={styles.loading} />
        ) : category === "All" && !normalizedQuery ? (
          <>
            {featured.length ? (
              <View style={styles.section}>
                <SectionHeading onViewAll={() => setCategory("Featured")}>Featured</SectionHeading>
                {featured.slice(0, 4).map((plugin) => (
                  <MarketplaceRow
                    busy={busyKey === plugin.key}
                    install={installs.get(plugin.key) ?? null}
                    key={plugin.key}
                    onAction={() => pluginAction(plugin)}
                    plugin={plugin}
                  />
                ))}
              </View>
            ) : null}
            {teamPlugins.length ? (
              <View style={styles.section}>
                <SectionHeading onViewAll={() => setCategory("Team plugins")}>
                  Team plugins
                </SectionHeading>
                {teamPlugins.slice(0, 8).map((plugin) => (
                  <MarketplaceRow
                    busy={busyKey === plugin.key}
                    install={installs.get(plugin.key) ?? null}
                    key={plugin.key}
                    onAction={() => pluginAction(plugin)}
                    plugin={plugin}
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : filtered.length ? (
          <View style={styles.section}>
            <SectionHeading>{normalizedQuery ? "Results" : category}</SectionHeading>
            {filtered.map((plugin) => (
              <MarketplaceRow
                busy={busyKey === plugin.key}
                install={installs.get(plugin.key) ?? null}
                key={plugin.key}
                onAction={() => pluginAction(plugin)}
                plugin={plugin}
              />
            ))}
          </View>
        ) : (
          <Text style={[styles.empty, { color: theme.textMuted }]}>No plugins found.</Text>
        )}
      </ScrollView>

      {setupPlugin ? (
        <PluginSetupSheet
          busy={Boolean(busyKey)}
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 14 },
  header: { height: 76, flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitle: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  searchRow: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  searchWrap: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: { flex: 1, height: 40, padding: 0, fontSize: 17, lineHeight: 22 },
  error: { marginHorizontal: 7, marginTop: 5, fontSize: 12, lineHeight: 17 },
  catalogContent: { paddingTop: 17, paddingBottom: 42 },
  section: { marginBottom: 22 },
  sectionHeading: {
    minHeight: 44,
    paddingHorizontal: 5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { fontSize: 15, lineHeight: 20 },
  pluginRow: {
    minHeight: 88,
    paddingHorizontal: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  pluginCopy: { flex: 1, minWidth: 0 },
  pluginName: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
  pluginDescription: { marginTop: 3, fontSize: 14, lineHeight: 19 },
  loading: { height: 130 },
  empty: { paddingVertical: 30, paddingHorizontal: 6, fontSize: 13, lineHeight: 18 },
});
