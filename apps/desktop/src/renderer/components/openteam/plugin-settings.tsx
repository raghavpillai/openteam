import type {
PluginCatalogItemView,
PluginConnectionView,
PluginInstallView,
PluginSettingsView
} from "@openteam/contracts";

import { pluginAuthorization,pluginNeedsSetup } from "@openteam/product-core/plugin-authorization";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import {
ChevronDown,
ChevronLeft,
LoaderCircle,
X
} from "lucide-react";
import { lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState } from "react";
import { api } from "../../client/openteam-api";
import {
createCoalescedRefresh,
mergePluginConnectionStatuses
} from "../../lib/plugin-settings-scale";
import { Dialog,DialogContent,DialogDescription,DialogTitle } from "../ui/dialog";
import {
DropdownMenu,
DropdownMenuContent,
DropdownMenuItem,
DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PluginPageStack } from "./plugins/plugin-page-stack";
import { InstalledPluginsSummary,InstalledPluginsView,MarketplaceView } from "./plugins/marketplace-browse";
import { openAutomaticPluginSignIn } from "./plugins/plugin-authorization";

import { savedLoginsCatalog, SAVED_LOGINS_KEY } from "./plugins/saved-logins-catalog";
const OnePasswordSavedLogins = lazy(() => import("./plugins/onepassword-saved-logins").then(module => ({ default: module.OnePasswordSavedLogins })));

const loadPluginWorkspace = () => import("./plugins/plugin-workspace");
const PluginWorkspace = lazy(loadPluginWorkspace);

type MarketplacePage = "saved-logins" | "marketplace" | "installed" | "detail" | "custom" | "manage";

const secondaryButton =
  "inline-flex h-[26px] shrink-0 items-center justify-center gap-1.5 cursor-pointer rounded-full bg-[#77777717] px-3 text-[13px] text-foreground outline-none transition-colors duration-120 ease-out hover:bg-[#7777772b] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-45";

const errorMessage = (cause: unknown) => clientErrorMessage(cause, "Plugin operation failed");

const installFor = (data: PluginSettingsView, pluginKey: string) =>
  data.installs.find((plugin) => plugin.pluginKey === pluginKey);

const catalogPluginForInstall = (install: PluginInstallView): PluginCatalogItemView => ({
  key: install.pluginKey,
  version: install.version,
  name: install.name,
  description: install.description,
  publisher: install.publisher,
  category: "MCP",
  featured: false,
  installed: true,
  components: [
    ...(install.hasSkills ? (["skills"] as const) : []),
    ...(install.connections.length ? (["mcp"] as const) : []),
  ],
  connections: install.connections.map((connection) => ({
    key: connection.connectorKey,
    name: connection.name,
    transport: connection.transport,
    auth: connection.auth,
    tools: connection.tools,
  })),
  skills: [],
  homepageUrl: null,
  sourceUrl: null,
  sourceRevision: null,
  logoUrl: null,
  setupFields: [],
  setup: null,
});

const loadPluginDetail = () => import("./plugin-detail-view");
const PluginDetail = lazy(() =>
  loadPluginDetail().then((module) => ({ default: module.PluginDetail }))
);
const CustomMcpView = lazy(() =>
  loadPluginDetail().then((module) => ({ default: module.CustomMcpView }))
);

export function PluginDialog({
  onOpenChange,
  open,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: { pluginId: string; nonce: number } | null;
}) {
  const [page, setCurrentPage] = useState<MarketplacePage>("marketplace");
  const [direction, setDirection] = useState<"push" | "pop">("push");
  const trail = useRef<Array<{ page: MarketplacePage; selectedKey: string | null; section: "private" | "develop" }>>([]);
  const [installedQuery, setInstalledQuery] = useState("");
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseCategory, setBrowseCategory] = useState("All");
  const setPage = (next: MarketplacePage) => {
    if (next === page) return;
    trail.current.push({ page, selectedKey, section: managementSection });
    setDirection("push");
    setCurrentPage(next);
  };
  const goBack = () => {
    const previous = trail.current.pop();
    setDirection("pop");
    setSelectedKey(previous?.selectedKey ?? null);
    setManagementSection(previous?.section ?? "private");
    setCurrentPage(previous?.page ?? "marketplace");
    setError(null);
  };
  const [managementSection, setManagementSection] = useState<"private" | "develop">("private");
  const openManagement = (section: typeof managementSection = "private") => {
    setManagementSection(section);
    setPage("manage");
  };
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const followedTarget = useRef<typeof target>(null);
  const [data, setData] = useState<PluginSettingsView | null>(null);
  const [savedLoginsConnected, setSavedLoginsConnected] = useState(false);
  const refreshSavedLogins = useCallback(() => {
    void window.openteam?.computer.getCapabilities().then(value => setSavedLoginsConnected(value.credentialProviders.length > 0)).catch(() => undefined);
  }, []);
  useEffect(() => { if (open) refreshSavedLogins(); }, [open, refreshSavedLogins]);
  useEffect(() => { window.addEventListener("openteam:saved-logins-changed", refreshSavedLogins); return () => window.removeEventListener("openteam:saved-logins-changed", refreshSavedLogins); }, [refreshSavedLogins]);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const mutating = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const refresh = useMemo(
    () =>
      createCoalescedRefresh(api.pluginSettings, (settings) => {
        setData(settings);
        setSettingsEpoch((epoch) => epoch + 1);
      }),
    []
  );
  const needsAuthConnectionIds = useMemo(
    () =>
      (data?.installs ?? [])
        .flatMap((install) => install.connections)
        .filter((connection) => connection.status === "needs_auth")
        .map((connection) => connection.id)
        .sort(),
    [data]
  );
  const statusRefresh = useMemo(
    () =>
      createCoalescedRefresh(
        () => api.pluginConnectionStatuses(needsAuthConnectionIds),
        (statuses) => {
          setData((current) =>
            current ? mergePluginConnectionStatuses(current, statuses) : current
          );
        }
      ),
    [needsAuthConnectionIds]
  );
  const reload = useCallback(async () => {
    setReloading(true);
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setReloading(false);
    }
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void reload();
    const reconnect = () => void reload();
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [open, reload]);
  const needsPluginAuthentication = needsAuthConnectionIds.length > 0;
  useEffect(() => {
    const bridge = window.openteam?.pluginOAuth;
    if (!open || !bridge) return;
    const unsubscribe = bridge.onResult(result => {
      if (result.status === "error") setError(result.message ?? "Plugin sign-in failed. Try again.");
      void refresh().catch(cause => setError(errorMessage(cause)));
    });
    return () => { unsubscribe(); void bridge.close().catch(() => {}); };
  }, [open, selectedKey, refresh]);
  useEffect(() => {
    if (!open || !needsPluginAuthentication) return;
    const timer = window.setInterval(() => {
      statusRefresh().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [needsPluginAuthentication, open, statusRefresh]);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setCurrentPage("marketplace");
      trail.current = [];
      setBrowseQuery("");
      setInstalledQuery("");
      setBrowseCategory("All");
      setSelectedKey(null);
      setError(null);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open]);

  const mutate = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      if (mutating.current) return false;
      mutating.current = true;
      setBusy(key);
      setError(null);
      try {
        await action();
        await refresh();
        window.dispatchEvent(new Event("openteam:plugins-changed"));
        return true;
      } catch (cause) {
        await refresh().catch(() => undefined);
        setError(errorMessage(cause));
        return false;
      } finally {
        mutating.current = false;
        setBusy(null);
      }
    },
    [refresh]
  );

  const selected = useMemo(() => {
    const pinned = data?.installs.find((plugin) => plugin.pluginKey === selectedKey)?.catalog;
    if (pinned) return pinned;
    const catalogPlugin = data?.catalog.find((plugin) => plugin.key === selectedKey);
    if (catalogPlugin) return catalogPlugin;
    const install = data?.installs.find((plugin) => plugin.pluginKey === selectedKey);
    return install ? catalogPluginForInstall(install) : null;
  }, [data, selectedKey]);
  useEffect(() => {
    // A custom package can disappear from the catalog when it is uninstalled.
    if (data && page === "detail" && selectedKey && !selected) {
      setPage("marketplace");
      setSelectedKey(null);
    }
  }, [data, page, selected, selectedKey]);
  const openDetail = (plugin: PluginCatalogItemView) => {
    if (plugin.key === SAVED_LOGINS_KEY) { setPage("saved-logins"); setError(null); return; }
    void loadPluginDetail();
    setSelectedKey(plugin.key);
    setPage("detail");
    setError(null);
  };
  useEffect(() => {
    if (
      !open ||
      !target ||
      !data ||
      (followedTarget.current?.nonce === target.nonce &&
        followedTarget.current?.pluginId === target.pluginId)
    )
      return;
    if (target.pluginId === SAVED_LOGINS_KEY) { followedTarget.current = target; setPage("saved-logins"); setError(null); return; }
    const plugin =
      data.installs.find((candidate) => candidate.pluginKey === target.pluginId)?.catalog ??
      data.catalog.find((candidate) => candidate.key === target.pluginId);
    if (plugin) {
      followedTarget.current = target;
      setSelectedKey(plugin.key);
      setPage("detail");
      setError(null);
      return;
    }
    setPage("marketplace");
    setSelectedKey(null);
    setError(`Plugin “${target.pluginId}” is not available in this catalog.`);
  }, [data, open, target]);
  const authenticateConnection = (connection: PluginConnectionView) => {
    if (connection.status === "error") {
      void mutate(connection.id, () => api.restartPluginConnection(connection.id));
      return;
    }
    const session = pluginAuthorization(connection);
    if (session && !session.expired && !window.openteam?.pluginOAuth) {
      openAutomaticPluginSignIn(connection.oauthCallbackMode, session.url);
      return;
    }
    void mutate(connection.id, async () => {
      if (connection.auth !== "oauth") return api.connectPlugin(connection.id);
      const result = await api.authenticatePlugin(connection.id);
      openAutomaticPluginSignIn(connection.oauthCallbackMode, result.authorizationUrl);
      return result;
    });
  };
  const cancelAuthentication = (connection: PluginConnectionView) => {
    const session = pluginAuthorization(connection);
    if (session)
      void mutate(connection.id, () =>
        api.cancelPluginAuthentication(connection.id, session.state)
      );
  };
  const installAndConnect = async (
    plugin: PluginCatalogItemView,
    values?: Record<string, string>
  ) => {
    await api.installPlugin(plugin.key, values);
    const settings = await api.pluginSettings();
    setData(settings);
    const connections =
      settings.installs.find((item) => item.pluginKey === plugin.key)?.connections ?? [];
    // Multi-connector packages expose each account separately; never open several sign-ins at once.
    if (connections.length !== 1) return;
    const connection = connections[0]!;
    if (pluginNeedsSetup(connection, plugin)) return;
    if (connection.status === "ready") return;
    if (connection.auth === "oauth") {
      const result = await api.authenticatePlugin(connection.id);
      openAutomaticPluginSignIn(connection.oauthCallbackMode, result.authorizationUrl);
    } else await api.connectPlugin(connection.id);
  };
  const toggleConnection = (connection: PluginConnectionView) => {
    if (connection.status !== "ready" && connection.auth === "oauth") {
      authenticateConnection(connection);
      return;
    }
    void mutate(connection.id, () =>
      connection.status === "ready"
        ? api.disconnectPlugin(connection.id)
        : api.connectPlugin(connection.id)
    );
  };

  const title =
    page === "saved-logins" ? "1Password" : page === "detail" && selected
      ? selected.name
      : page === "custom"
        ? "Add custom MCP"
        : page === "manage"
          ? managementSection === "private" ? "Private skills" : "Develop plugins"
          : page === "installed" ? "Manage plugins and skills" : "Marketplace";
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        overlayClassName="plugin-overlay"
        className="plugin-dialog flex h-[min(700px,calc(100dvh-48px))] w-[min(800px,calc(100vw-40px))] flex-col max-w-none gap-0 overflow-hidden rounded-[13px] border-black/10 bg-background p-0 text-foreground shadow-[0_24px_72px_rgba(0,0,0,0.24)] dark:border-[#303030]"
        ref={dialogRef}
        onOpenAutoFocus={(event) => { event.preventDefault(); dialogRef.current?.focus(); }}
        onCloseAutoFocus={(event) => {
          const trigger = document.querySelector<HTMLElement>("[data-marketplace-trigger]");
          if (trigger) { event.preventDefault(); trigger.focus(); }
        }}
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("[data-plugin-account-editor]")
          ) {
            event.preventDefault();
          }
        }}
        showCloseButton={false}
        surface="modal"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Browse, install, connect, and configure OpenTeam plugins.
        </DialogDescription>
        <button aria-label="Close plugins" className="absolute right-3.5 top-3.5 z-10 grid size-8 cursor-pointer place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => onOpenChange(false)} type="button"><X className="size-4" strokeWidth={1.7} /></button>
        <PluginPageStack pageKey={`${page}:${page === "detail" ? selectedKey : page === "manage" ? managementSection : ""}`} direction={direction}>
        <header className={`relative flex shrink-0 items-center px-8 ${page === "marketplace" ? "h-[96px]" : "h-[64px]"}`}>
          {page !== "marketplace" ? (
            <button
              aria-label={trail.current.at(-1)?.page === "installed" ? "Back to installed plugins" : "Back to Marketplace"}
              className={`absolute left-3.5 flex h-8 items-center justify-center gap-1 cursor-pointer rounded-full text-foreground-secondary outline-none transition-colors duration-120 ease-out hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${page === "installed" ? "px-2 text-[12px]" : "w-8"}`}
              onClick={goBack}
              type="button"
            >
              <ChevronLeft className="size-4" />
              {page === "installed" ? "Marketplace" : null}
            </button>
          ) : null}
          {page !== "marketplace" ? (
            <span className="sr-only">{title}</span>
          ) : (
            <div className="flex w-full items-center justify-between pr-8">
              <h1 tabIndex={-1} className="text-[16px] font-semibold">Marketplace</h1>
              <div className="flex items-center gap-3">
                {data && <InstalledPluginsSummary data={{ ...data, catalog: [savedLoginsCatalog(null, savedLoginsConnected), ...data.catalog] }} onShowInstalled={() => setPage("installed")} />}
                <DropdownMenu onOpenChange={isOpen => { if (isOpen) void loadPluginWorkspace().then(module => module.preloadPluginManagement()).catch(() => undefined); }}>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={secondaryButton} aria-label="Manage plugins">
                      Manage
                      <ChevronDown className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="plugin-management-menu w-[190px]">
                    <DropdownMenuItem onSelect={() => setPage("installed")}>
                      Your plugins
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("private")}>
                      Private skills
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openManagement("develop")}>
                      Develop plugins
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPage("custom")}>
                      Add custom MCP
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}

        </header>

        {error ? (
          <div
            role="alert"
            className="mx-8 mb-3 flex items-center justify-between gap-3 rounded-[8px] bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300"
          >
            <span>{error}</span>
            <button
              className={secondaryButton}
              disabled={reloading || Boolean(busy)}
              onClick={() => void reload()}
              type="button"
            >
              Reload plugins
            </button>
          </div>
        ) : null}
        {data && page === "marketplace" && (
          <MarketplaceView
            query={browseQuery}
            category={browseCategory}
            onQueryChange={setBrowseQuery}
            onCategoryChange={setBrowseCategory}
            busy={busy}
            data={{ ...data, catalog: [savedLoginsCatalog(null, savedLoginsConnected), ...data.catalog] }}
            onInstall={(plugin) => {
              if (plugin.key === SAVED_LOGINS_KEY) { openDetail(plugin); return; }
              if (plugin.connections.length || plugin.setup || plugin.setupFields.length)
                openDetail(plugin);
              if (
                !plugin.setupFields.some((field) => field.required && field.default === undefined)
              )
                void mutate(plugin.key, () => installAndConnect(plugin));
            }}
            onOpen={openDetail}
          />
        )}
        <Suspense
          fallback={
            <div role="status" className="p-8 text-sm">
              Loading plugin details…
            </div>
          }
        >
          {!data && error ? null : !data ? (
            <div
              role="status"
              aria-label="Loading plugins"
              className="grid flex-1 place-items-center"
            >
              <LoaderCircle className="size-5 animate-spin text-foreground-tertiary" />
            </div>
          ) : page === "saved-logins" ? (
            <OnePasswordSavedLogins logoUrl={null} onChanged={refreshSavedLogins} />
          ) : page === "installed" ? (
            <InstalledPluginsView
              query={installedQuery}
              onQueryChange={setInstalledQuery}
              data={data}
              busy={busy}
              onOpen={openDetail}
              onManage={() => openManagement("private")}
              onRetry={(connection) =>
                connection.auth === "oauth" && connection.status === "needs_auth"
                  ? authenticateConnection(connection)
                  : void mutate(connection.id, () => api.restartPluginConnection(connection.id))
              }
              catalogFallback={catalogPluginForInstall}
              savedLogins={savedLoginsConnected ? savedLoginsCatalog(null, true) : undefined}
            />
          ) : page === "manage" ? (
            <Suspense fallback={<p className="p-8 text-sm">Loading plugin management…</p>}>
              <PluginWorkspace
                key={managementSection}
                initialSection={managementSection}
                settings={data}
                refresh={refresh}
                initialPluginKey={selectedKey}
              />
            </Suspense>
          ) : page === "marketplace" ? null : page === "custom" ? (
            <CustomMcpView
              onBack={goBack}
              busy={busy === "custom-mcp"}
              onSubmit={(input) =>
                void mutate("custom-mcp", () => api.addCustomMcp(input)).then((created) => {
                  if (created) { setDirection("pop"); setCurrentPage("installed"); }
                })
              }
            />
          ) : selected ? (
            <PluginDetail
              advancedSettings={<Suspense fallback={<p className="p-4 text-[13px]">Loading settings…</p>}><PluginWorkspace initialSection="installed" settings={data} refresh={refresh} initialPluginKey={selected.key} /></Suspense>}
              busy={busy}
              data={data}
              key={selected.key}
              onAddAccount={(connection, alias) => {
                let created = false;
                return mutate(`account:${connection.id}`, async () => {
                  await api.addPluginAccount(connection.id, alias);
                  created = true;
                  const settings = await api.pluginSettings();
                  setData(settings);
                  const account = settings.installs
                    .flatMap((row) => row.connections)
                    .find(
                      (row) =>
                        row.pluginKey === connection.pluginKey &&
                        row.connectorKey === connection.connectorKey &&
                        row.alias === alias
                    );
                  if (account?.auth === "oauth" && !pluginNeedsSetup(account, selected)) {
                    const result = await api.authenticatePlugin(account.id);
                    openAutomaticPluginSignIn(account.oauthCallbackMode, result.authorizationUrl);
                  }
                }).then((success) => success || created);
              }}
              onAuthenticate={authenticateConnection}
              onCancelAuthentication={cancelAuthentication}
              onConfigureToken={(connection, token) =>
                void mutate(connection.id, async () => {
                  await api.configurePluginConnection(connection.id, { token });
                  return api.connectPlugin(connection.id);
                })
              }
              onConfigureCallback={(connection, input) => {
                void mutate(connection.id, () => api.savePluginConfiguration(connection.id, input));
              }}
              onConfigureOAuth={(connection, input) =>
                void mutate(connection.id, async () => {
                  await api.configurePluginConnection(connection.id, input);
                  const result = await api.authenticatePlugin(connection.id);
                  openAutomaticPluginSignIn(connection.oauthCallbackMode, result.authorizationUrl);
                  return result;
                })
              }
              onInstructions={(connection, instructions) =>
                void mutate(connection.id, () =>
                  api.setMcpInstructions(connection.id, instructions)
                )
              }
              onInstall={(plugin, values) =>
                void mutate(plugin.key, () => installAndConnect(plugin, values))
              }
              onRemoveAccount={(connection) =>
                void mutate(connection.id, () => api.removePluginAccount(connection.id))
              }
              onRename={(connection, alias) =>
                mutate(connection.id, () => api.renamePluginAccount(connection.id, alias))
              }
              onRemove={(plugin) => void mutate(plugin.key, () => api.uninstallPlugin(plugin.key))}
              onRestart={(connection) =>
                void mutate(connection.id, () => api.restartPluginConnection(connection.id))
              }
              onToggle={toggleConnection}
              plugin={selected}
            />
          ) : null}
        </Suspense>
        </PluginPageStack>
      </DialogContent>
    </Dialog>
  );
}
