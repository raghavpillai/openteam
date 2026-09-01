import type {
  PluginCatalogItemView,
  PluginConnectionView,
  PluginInstallView,
  PluginSettingsView,
} from "@openbot/contracts";
import {
  PLUGIN_MARKETPLACE_CATEGORIES,
  type PluginMarketplaceCategory,
  pluginMatchesMarketplaceCategory,
} from "@openbot/client-core/plugin-marketplace";
import { clientErrorMessage } from "@openbot/product-core/redaction";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useOpenBot } from "../state/openbot-context";
import { type Theme, useTheme } from "../theme";
import { GlassSurface } from "./glass-surface";
import { IconButton } from "./icon-button";
import { PluginManagerSheet as InstalledPluginManager } from "./plugin-manager-sheet";

const emptySettings = (): PluginSettingsView => ({
  catalog: [],
  installs: [],
  botCount: 0,
  policies: [],
  activity: [],
});

function PluginMark({
  logoUrl,
  name,
  size = 36,
  theme,
}: {
  logoUrl: string | null;
  name: string;
  size?: number;
  theme: Theme;
}) {
  const [failed, setFailed] = useState(false);
  const google = name === "Gmail" || name.startsWith("Google");
  return (
    <View
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: Math.max(9, size * 0.24),
          backgroundColor: google ? "#FFFFFF" : theme.surfacePressed,
        },
      ]}
    >
      {logoUrl && !failed ? (
        <Image
          onError={() => setFailed(true)}
          resizeMode="contain"
          source={{ uri: logoUrl }}
          style={{ width: size * 0.8, height: size * 0.8 }}
        />
      ) : google ? (
        <Text style={[styles.googleMark, { fontSize: size * 0.47 }]}>{name[0]}</Text>
      ) : (
        <SymbolView
          name="puzzlepiece.extension.fill"
          size={size * 0.55}
          tintColor={theme.textMuted}
        />
      )}
    </View>
  );
}

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
    : connection?.status === "needs_auth" || connection?.canAuthenticate
      ? "Authorize"
      : connection && connection.status !== "ready"
        ? "Connect"
        : "Added";
  const primary = actionLabel === "Authorize";
  return (
    <View style={styles.pluginRow}>
      <PluginMark logoUrl={plugin.logoUrl} name={plugin.name} theme={theme} />
      <View style={styles.pluginCopy}>
        <Text numberOfLines={1} style={[styles.pluginName, { color: theme.text }]}>
          {plugin.name}
        </Text>
        <Text numberOfLines={2} style={[styles.pluginDescription, { color: theme.textMuted }]}>
          {plugin.description}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`${actionLabel} ${plugin.name}`}
        accessibilityRole="button"
        disabled={busy}
        onPress={onAction}
        style={({ pressed }) => [
          styles.actionPill,
          { backgroundColor: primary ? "#087EF5" : theme.surfacePressed },
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={primary ? "#FFFFFF" : theme.text} size="small" />
        ) : (
          <Text style={[styles.actionText, { color: primary ? "#FFFFFF" : theme.text }]}>
            {actionLabel}
          </Text>
        )}
      </Pressable>
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
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onViewAll}>
          <Text style={[styles.viewAll, { color: theme.textMuted }]}>View all</Text>
        </Pressable>
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
  const { authenticatePlugin, connectPlugin, installPlugin, pluginSettings } = useOpenBot();
  const [data, setData] = useState<PluginSettingsView>(emptySettings);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PluginMarketplaceCategory>("All");
  const [filterOpen, setFilterOpen] = useState(false);
  const [installedOpen, setInstalledOpen] = useState(false);
  const [setupPlugin, setSetupPlugin] = useState<PluginCatalogItemView | null>(null);
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await pluginSettings();
      if (requestId.current === id) setData(next);
    } catch (cause) {
      if (requestId.current === id) {
        setError(clientErrorMessage(cause, "OpenBot could not load plugins."));
      }
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [pluginSettings]);

  useEffect(() => {
    if (visible && !installedOpen) void refresh();
  }, [installedOpen, refresh, visible]);

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

  const mutate = async (key: string, action: () => Promise<void>) => {
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenBot could not update this plugin."));
    } finally {
      setBusyKey(null);
    }
  };

  const beginInstall = (plugin: PluginCatalogItemView) => {
    const fields = plugin.setup?.fields ?? plugin.setupFields;
    if (fields.length > 0) {
      setSetupPlugin(plugin);
      setSetupValues({});
      return;
    }
    void mutate(plugin.key, () => installPlugin(plugin.key));
  };

  const handleConnection = (connection: PluginConnectionView) => {
    const key = `connection:${connection.id}`;
    if (connection.status === "ready") {
      setInstalledOpen(true);
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

  const firstInstall = data.installs[0];
  const firstCatalog = firstInstall
    ? (data.catalog.find((plugin) => plugin.key === firstInstall.pluginKey) ?? null)
    : null;

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <IconButton
          label="Back to settings"
          name="chevron.left"
          onPress={onClose}
          size={38}
          symbolSize={18}
          tone="surface"
        />
        <Text style={[styles.headerTitle, { color: theme.text }]}>Plugins</Text>
        <Pressable
          accessibilityLabel={`${data.installs.length} installed plugins`}
          accessibilityRole="button"
          onPress={() => setInstalledOpen(true)}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <GlassSurface
            fallbackColor={theme.surfaceElevated}
            interactive
            style={[styles.installedPill, { borderColor: theme.border }]}
          >
            {firstInstall ? (
              <PluginMark
                logoUrl={firstCatalog?.logoUrl ?? null}
                name={firstInstall.name}
                size={22}
                theme={theme}
              />
            ) : (
              <SymbolView name="puzzlepiece.extension.fill" size={16} tintColor={theme.textMuted} />
            )}
            <Text style={[styles.installedText, { color: theme.text }]}>
              {data.installs.length} installed
            </Text>
          </GlassSurface>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <View
          style={[styles.searchWrap, { backgroundColor: theme.field, borderColor: theme.border }]}
        >
          <SymbolView name="magnifyingglass" size={16} tintColor={theme.textFaint} />
          <TextInput
            accessibilityLabel="Search plugins"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search plugins"
            placeholderTextColor={theme.textFaint}
            style={[styles.searchInput, { color: theme.text }]}
            value={query}
          />
        </View>
        <IconButton
          label="Filter plugins"
          name="line.3.horizontal.decrease"
          onPress={() => setFilterOpen(true)}
          size={38}
          symbolSize={17}
          tone="surface"
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

      {filterOpen ? (
        <View style={StyleSheet.absoluteFill}>
          <Pressable
            accessibilityLabel="Close plugin filters"
            onPress={() => setFilterOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <GlassSurface
            fallbackColor="rgba(55,55,55,0.97)"
            style={[styles.filterMenu, { borderColor: theme.border }]}
          >
            <ScrollView
              contentContainerStyle={styles.filterContent}
              persistentScrollbar
              showsVerticalScrollIndicator
            >
              {PLUGIN_MARKETPLACE_CATEGORIES.map((item) => (
                <Pressable
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: item === category }}
                  key={item}
                  onPress={() => {
                    setCategory(item);
                    setFilterOpen(false);
                  }}
                  style={({ pressed }) => [styles.filterItem, pressed && styles.filterPressed]}
                >
                  <View style={styles.checkSlot}>
                    {item === category ? (
                      <SymbolView
                        name="checkmark"
                        size={14}
                        tintColor={theme.text}
                        weight="medium"
                      />
                    ) : null}
                  </View>
                  <Text style={[styles.filterLabel, { color: theme.text }]}>{item}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </GlassSurface>
        </View>
      ) : null}

      {setupPlugin ? (
        <View style={StyleSheet.absoluteFill}>
          <Pressable
            accessibilityLabel="Cancel plugin setup"
            onPress={() => setSetupPlugin(null)}
            style={[StyleSheet.absoluteFill, styles.setupBackdrop]}
          />
          <GlassSurface
            fallbackColor={theme.surfaceElevated}
            style={[styles.setup, { borderColor: theme.border }]}
          >
            <Text style={[styles.setupTitle, { color: theme.text }]}>
              Set up {setupPlugin.name}
            </Text>
            <Text style={[styles.pluginDescription, { color: theme.textMuted }]}>
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
                  styles.setupField,
                  { backgroundColor: theme.field, borderColor: theme.border, color: theme.text },
                ]}
                value={setupValues[field.key] ?? ""}
              />
            ))}
            <View style={styles.setupActions}>
              <Pressable onPress={() => setSetupPlugin(null)} style={styles.setupButton}>
                <Text style={[styles.setupButtonText, { color: theme.textMuted }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const plugin = setupPlugin;
                  setSetupPlugin(null);
                  void mutate(plugin.key, () => installPlugin(plugin.key, setupValues));
                }}
                style={[styles.setupButton, { backgroundColor: theme.text }]}
              >
                <Text style={[styles.setupButtonText, { color: theme.background }]}>Install</Text>
              </Pressable>
            </View>
          </GlassSurface>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20 },
  header: { height: 72, flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitle: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  installedPill: {
    height: 38,
    minWidth: 116,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  installedText: { fontSize: 14, lineHeight: 18, fontWeight: "500" },
  searchRow: { height: 47, flexDirection: "row", alignItems: "center", gap: 7 },
  searchWrap: {
    flex: 1,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: { flex: 1, height: 38, padding: 0, fontSize: 14, lineHeight: 18 },
  error: { marginHorizontal: 7, marginTop: 5, fontSize: 12, lineHeight: 17 },
  catalogContent: { paddingTop: 20, paddingBottom: 42 },
  section: { marginBottom: 22 },
  sectionHeading: {
    height: 28,
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { fontSize: 12, lineHeight: 17 },
  viewAll: { fontSize: 11, lineHeight: 15 },
  pluginRow: {
    minHeight: 71,
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  mark: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  googleMark: { color: "#4285F4", fontWeight: "800" },
  pluginCopy: { flex: 1, minWidth: 0 },
  pluginName: { fontSize: 15, lineHeight: 20, fontWeight: "500" },
  pluginDescription: { marginTop: 1, fontSize: 12, lineHeight: 16 },
  actionPill: {
    minWidth: 45,
    minHeight: 30,
    borderRadius: 15,
    paddingHorizontal: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  loading: { height: 130 },
  empty: { paddingVertical: 30, paddingHorizontal: 6, fontSize: 13, lineHeight: 18 },
  filterMenu: {
    position: "absolute",
    right: 1,
    top: 64,
    width: 222,
    maxHeight: 470,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOpacity: 0.36,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  filterContent: { paddingVertical: 9, paddingRight: 5 },
  filterItem: { minHeight: 38, paddingHorizontal: 13, flexDirection: "row", alignItems: "center" },
  filterPressed: { backgroundColor: "rgba(255,255,255,0.08)" },
  checkSlot: { width: 26, alignItems: "flex-start" },
  filterLabel: { flex: 1, fontSize: 15, lineHeight: 20 },
  setupBackdrop: { backgroundColor: "rgba(0,0,0,0.24)" },
  setup: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 10,
  },
  setupTitle: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  setupField: {
    minHeight: 44,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    fontSize: 14,
  },
  setupActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  setupButton: {
    minWidth: 76,
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  setupButtonText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.42 },
});
