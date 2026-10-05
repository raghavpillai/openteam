import type { PluginSettingsView } from "@openteam/contracts";
import type {
  PluginManagementView,
  PluginPackageView,
} from "@openteam/contracts/plugin-management";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api } from "../../../client/openteam-api";
const ConnectionConfiguration = lazy(() => import("./connection-configuration").then(module => ({default:module.ConnectionConfiguration})));
const loadPackageStudio = () => import("./package-studio");
const PackageStudio = lazy(() => loadPackageStudio().then(module => ({default:module.PackageStudio})));
const loadPrivateSkills = () => import("./private-skills");
const PrivateSkills = lazy(() => loadPrivateSkills().then(module => ({default:module.PrivateSkills})));
export const preloadPluginManagement = () => Promise.all([loadPrivateSkills(), loadPackageStudio()]);
import {
  downloadPlugin,
  inputClass,
  PluginButton,
  PluginField,
  usePluginOperation,
} from "./plugin-ui";

type Section = "installed" | "private" | "develop";
export default function PluginWorkspace({
  settings,
  refresh,
  initialSection = "installed",
  initialPluginKey,
}: {
  settings: PluginSettingsView;
  refresh: () => Promise<unknown>;
  initialSection?: Section;
  initialPluginKey?: string | null;
}) {
  const section = initialSection;
  const [data, setData] = useState<PluginManagementView | null>(null);
  const [key] = useState(
    settings.installs.some((install) => install.pluginKey === initialPluginKey)
      ? initialPluginKey!
      : (settings.installs[0]?.pluginKey ?? "")
  );
  const [packageView, setPackage] = useState<PluginPackageView | null>(null);
  const [connectionId, setConnectionId] = useState("");
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
    if (key && section === "installed")
      void api
        .pluginPackage(key)
        .then((value) => {
          if (active) setPackage(value);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [key, settings, section]);
  const installed = settings.installs.find((entry) => entry.pluginKey === key);
  const connection =
    installed?.connections.find((entry) => entry.id === connectionId) ?? installed?.connections[0];
  const resolvedConnectionId = connection?.id ?? "";
  useEffect(() => {
    // Keep the implicit first selection stable when saving reorders the accounts.
    setConnectionId(resolvedConnectionId);
  }, [resolvedConnectionId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={section === "installed" ? "grid gap-4" : "bot-scrollbar min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-2 max-sm:px-5"}>
        <Suspense fallback={<p className="text-sm">Loading plugin management…</p>}>
        {operation.feedback}
        {!data ? (
          <p className="text-sm">Loading plugin management…</p>
        ) : section === "develop" ? (
          <PackageStudio data={data} refresh={load} />
        ) : section === "private" ? (
          <PrivateSkills data={data} refresh={load} />
        ) : (
          <div className="grid gap-5">
            {installed && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <PluginButton
                    disabled={operation.busy}
                    onClick={() => void operation.run(() => downloadPlugin(key))}
                  >
                    Export package
                  </PluginButton>
                </div>
                {packageView && (
                  <details
                    className="animated-disclosure rounded-xl border border-black/10 p-4 dark:border-white/10"
                    open={Boolean(packageView.update || packageView.skillSyncStatus === "error")}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      Package version and updates
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
                    This package provides skills for your Bots.
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
