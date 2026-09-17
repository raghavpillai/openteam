import type { PluginCatalogItemView, PluginSettingsView } from "@openteam/contracts";
import type {
  PluginManagementView,
  PluginPackageView,
} from "@openteam/contracts/plugin-management";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
const ConnectionConfiguration = lazy(() => import("./connection-configuration").then(module => ({default:module.ConnectionConfiguration})));
const PackageStudio = lazy(() => import("./package-studio").then(module => ({default:module.PackageStudio})));
import { PluginMark } from "./plugin-mark";
const PrivateSkills = lazy(() => import("./private-skills").then(module => ({default:module.PrivateSkills})));
import {
  downloadPlugin,
  inputClass,
  PluginButton,
  PluginField,
  usePluginOperation,
} from "./plugin-ui";

type Section = "installed" | "private" | "sources" | "develop";
export default function PluginWorkspace({
  settings,
  refresh,
  onOpen,
  initialSection = "installed",
  initialPluginKey,
}: {
  settings: PluginSettingsView;
  refresh: () => Promise<unknown>;
  onOpen: (plugin: PluginCatalogItemView) => void;
  initialSection?: Section;
  initialPluginKey?: string | null;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [data, setData] = useState<PluginManagementView | null>(null);
  const [key, setKey] = useState(
    settings.installs.some((install) => install.pluginKey === initialPluginKey)
      ? initialPluginKey!
      : (settings.installs[0]?.pluginKey ?? "")
  );
  const [packageView, setPackage] = useState<PluginPackageView | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [remove, setRemove] = useState("");
  const load = useCallback(async () => {
    await refresh();
    setData(await api.pluginManagement());
  }, [refresh]);
  const operation = usePluginOperation(load);
  useEffect(() => {
    void operation.run(async () => setData(await api.pluginManagement()));
  }, []);
  useEffect(() => {
    let active = true;
    setPackage(null);
    if (key)
      void api
        .pluginPackage(key)
        .then((value) => {
          if (active) setPackage(value);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [key, settings]);
  const installed = settings.installs.find((entry) => entry.pluginKey === key);
  const connection =
    installed?.connections.find((entry) => entry.id === connectionId) ?? installed?.connections[0];
  const resolvedConnectionId = connection?.id ?? "";
  useEffect(() => {
    // Keep the implicit first selection stable when saving reorders the accounts.
    setConnectionId(resolvedConnectionId);
  }, [resolvedConnectionId]);
  const catalog = installed?.catalog ?? settings.catalog.find((entry) => entry.key === key);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <nav
        aria-label="Plugin management"
        className="flex shrink-0 flex-wrap gap-2 border-b border-black/10 px-8 pb-4 dark:border-white/10"
      >
        {(
          [
            ["installed", "Installed"],
            ["private", "Private skills"],
            ["sources", "Sources"],
            ["develop", "Develop"],
          ] as const
        ).map(([id, name]) => (
          <PluginButton key={id} primary={section === id} onClick={() => setSection(id)}>
            {name}
          </PluginButton>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <Suspense fallback={<p className="text-sm">Loading plugin management…</p>}>
        {operation.feedback}
        {!data ? (
          <p className="text-sm">Loading plugin management…</p>
        ) : section === "develop" ? (
          <PackageStudio data={data} refresh={load} />
        ) : section === "private" ? (
          <PrivateSkills data={data} refresh={load} />
        ) : section === "sources" ? (
          <div className="grid gap-5">
            <div>
              <h3 className="text-lg font-medium">Plugin sources</h3>
              <p className="mt-1 text-sm text-foreground-secondary">
                Add a catalog hosted by you or another publisher. Installed packages keep their own
                snapshot when a source changes or is removed.
              </p>
            </div>
            <div className="rounded-xl border border-black/10 p-4 dark:border-white/10">
              <p className="font-medium">Bundled plugins</p>
              <p className="text-sm text-foreground-secondary">
                Included with this OpenTeam release.
              </p>
            </div>
            {data.sources.map((source) => (
              <div
                key={source.id}
                className="grid gap-2 rounded-xl border border-black/10 p-4 dark:border-white/10"
              >
                <p className="font-medium">
                  {source.name} · {source.pluginCount} plugins
                </p>
                <p className="break-all text-xs text-foreground-secondary">{source.url}</p>
                <p className="text-xs">
                  {source.error ??
                    (source.refreshedAt
                      ? `Refreshed ${new Date(source.refreshedAt).toLocaleString()}`
                      : source.status)}
                </p>
                <div className="flex gap-2">
                  <PluginButton
                    disabled={operation.busy}
                    onClick={() => {
                      setSourceId(source.id);
                      setSourceName(source.name);
                      setSourceUrl(source.url);
                    }}
                  >
                    Edit source
                  </PluginButton>
                  <PluginButton
                    disabled={operation.busy}
                    onClick={() =>
                      void operation.run(
                        () => api.refreshPluginSource(source.id),
                        "Catalog refreshed."
                      )
                    }
                  >
                    Refresh
                  </PluginButton>
                  <PluginButton
                    disabled={operation.busy}
                    onClick={() =>
                      remove === source.id
                        ? void operation.run(async () => {
                            await api.removePluginSource(source.id);
                            if (sourceId === source.id) {
                              setSourceId("");
                              setSourceName("");
                              setSourceUrl("");
                            }
                          })
                        : setRemove(source.id)
                    }
                  >
                    {remove === source.id ? "Confirm remove source" : "Remove"}
                  </PluginButton>
                </div>
              </div>
            ))}
            <PluginField label="Catalog name">
              <input
                className={inputClass}
                value={sourceName}
                onChange={(event) => setSourceName(event.target.value)}
              />
            </PluginField>
            <PluginField label="Catalog manifest URL">
              <input
                className={inputClass}
                placeholder="https://example.com/plugins/marketplace.json"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </PluginField>
            <div>
              <PluginButton
                primary
                disabled={operation.busy || !sourceUrl}
                onClick={() =>
                  void operation.run(async () => {
                    if (sourceId) await api.updatePluginSource(sourceId, sourceUrl, sourceName);
                    else await api.addPluginSource(sourceUrl, sourceName);
                    setSourceId("");
                    setSourceUrl("");
                    setSourceName("");
                  }, "Catalog added.")
                }
              >
                {sourceId ? "Save source" : "Add source"}
              </PluginButton>
            </div>
          </div>
        ) : (
          <div className="grid gap-5">
            <PluginField label="Installed plugin">
              <select
                className={inputClass}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setConnectionId("");
                  setRemove("");
                }}
              >
                <option value="">Choose a plugin…</option>
                {settings.installs.map((entry) => (
                  <option key={entry.id} value={entry.pluginKey}>
                    {entry.name} · {entry.version}
                  </option>
                ))}
              </select>
            </PluginField>
            {installed && (
              <>
                <div className="flex items-center gap-3">
                  <PluginMark logoUrl={catalog?.logoUrl} name={installed.name} />
                  <div>
                    <h3 className="text-[14px] font-medium">{installed.name}</h3>
                    <p className="text-[12px] text-foreground-secondary">{installed.description}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {catalog && (
                    <PluginButton onClick={() => onOpen(catalog)}>
                      Bot access and plugin details
                    </PluginButton>
                  )}
                  <PluginButton
                    disabled={operation.busy}
                    onClick={() => void operation.run(() => downloadPlugin(key))}
                  >
                    Export package
                  </PluginButton>
                  <PluginButton
                    disabled={operation.busy || packageView?.mode === "required"}
                    onClick={() =>
                      remove === key
                        ? void operation.run(async () => {
                            await api.uninstallPlugin(key);
                            setKey("");
                          }, "Plugin, accounts, and grants removed.")
                        : setRemove(key)
                    }
                  >
                    {remove === key ? "Confirm uninstall and remove accounts" : "Uninstall"}
                  </PluginButton>
                </div>
                {packageView && (
                  <details
                    className="rounded-xl border border-black/10 p-4 dark:border-white/10"
                    open={Boolean(packageView.update || packageView.skillSyncStatus === "error")}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      Package version, updates, and workspace policy
                    </summary>
                    <div className="mt-4 grid gap-4">
                      <p className="text-xs text-foreground-secondary">
                        Installed {packageView.definition.version} ·{" "}
                        {packageView.definition.publisher}
                        <br />
                        Snapshot {packageView.digest.slice(0, 16)}
                      </p>
                      {packageView.definition.skills.length > 0 && (
                        <div className="text-sm">
                          <p>Skill files: {packageView.skillSyncStatus}</p>
                          {packageView.skillSyncError && (
                            <p role="alert">{packageView.skillSyncError}</p>
                          )}
                          <PluginButton
                            disabled={operation.busy}
                            onClick={() =>
                              void operation.run(
                                () => api.syncPluginSkills(),
                                "Skill synchronization retried."
                              )
                            }
                          >
                            Retry skill sync
                          </PluginButton>
                        </div>
                      )}
                      <PluginField label="Workspace installation policy">
                        <select
                          className={inputClass}
                          value={packageView.mode}
                          disabled={operation.busy}
                          onChange={(event) =>
                            void operation.run(() =>
                              api.setPluginMode(
                                key,
                                event.target.value as PluginPackageView["mode"]
                              )
                            )
                          }
                        >
                          <option value="optional">Optional — Bots opt in</option>
                          <option value="default">Default — enabled for Bots</option>
                          <option value="required">Required — Bots cannot disable</option>
                          <option value="disabled">Disabled by workspace</option>
                        </select>
                      </PluginField>
                      <p className="text-xs text-foreground-secondary">
                        Account grants remain explicit. Making a plugin required does not share your
                        accounts automatically.
                      </p>
                      {packageView.update && (
                        <section className="rounded-lg bg-blue-500/10 p-3">
                          <p className="font-medium">
                            Available package: {packageView.update.definition.version}
                          </p>
                          <ul className="my-2 list-disc pl-5 text-sm">
                            {packageView.update.changes.map((change) => (
                              <li key={change}>{change}</li>
                            ))}
                          </ul>
                          <p className="mb-3 text-xs">
                            Compatible accounts and tool preferences are retained. Removed
                            connectors lose their accounts. Reconnect after updating to refresh
                            available tools.
                          </p>
                          <PluginButton
                            primary
                            disabled={operation.busy}
                            onClick={() =>
                              void operation.run(
                                () => api.updatePlugin(key, packageView.update!.digest),
                                "Package updated."
                              )
                            }
                          >
                            Apply reviewed update
                          </PluginButton>
                        </section>
                      )}
                      {packageView.hasRollback && (
                        <PluginButton
                          disabled={operation.busy}
                          onClick={() =>
                            void operation.run(
                              () => api.rollbackPlugin(key),
                              "Previous package restored. Reconnect its accounts."
                            )
                          }
                        >
                          Restore previous package
                        </PluginButton>
                      )}
                    </div>
                  </details>
                )}
                {installed.connections.length > 0 ? (
                  <>
                    <PluginField label="Connection / account">
                      <select
                        className={inputClass}
                        value={connection?.id ?? ""}
                        onChange={(event) => setConnectionId(event.target.value)}
                      >
                        {installed.connections.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name} · {entry.alias} · {entry.status.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </PluginField>
                    {connection && (
                      <ConnectionConfiguration
                        key={`${connection.id}:${installed.packageDigest ?? installed.version}`}
                        connection={connection}
                        settings={settings}
                        refresh={load}
                      />
                    )}
                  </>
                ) : (
                  <p className="text-sm text-foreground-secondary">
                    This package provides skills. Open Bot access to enable them for your Bots.
                  </p>
                )}
              </>
            )}
            {!settings.installs.length && (
              <p className="text-sm text-foreground-secondary">
                Browse plugins or load a package from Develop to get started.
              </p>
            )}
          </div>
        )}
        </Suspense>
      </div>
    </div>
  );
}
