import type {
  PluginConnectionStatusesView,
  PluginConnectionView,
  PluginSettingsView,
} from "@openteam/contracts";

const mergeConnectionStatus = (
  connection: PluginConnectionView,
  status: PluginConnectionStatusesView["connections"][number] | undefined
): PluginConnectionView => {
  if (!status || status.revision <= connection.revision) return connection;
  return {
    ...connection,
    revision: status.revision,
    status: status.status,
    statusMessage: status.statusMessage,
    authorizationUrl: status.authorizationUrl,
    authorizationExpiresAt: status.authorizationExpiresAt,
    oauthCallbackMode: status.oauthCallbackMode ?? connection.oauthCallbackMode,
    setupPhase: status.setupPhase ?? connection.setupPhase,
    configured: status.configured,
    tools: status.tools,
  };
};

/** Merge a small status poll without replacing catalog or activity. */
export const mergePluginConnectionStatuses = (
  settings: PluginSettingsView,
  statuses: PluginConnectionStatusesView
): PluginSettingsView => {
  const byId = new Map(statuses.connections.map((status) => [status.id, status]));
  let changed = false;
  const installs = settings.installs.map((install) => {
    let installChanged = false;
    const connections = install.connections.map((connection) => {
      const merged = mergeConnectionStatus(connection, byId.get(connection.id));
      if (merged !== connection) installChanged = true;
      return merged;
    });
    if (!installChanged) return install;
    changed = true;
    return { ...install, connections };
  });
  return changed ? { ...settings, installs } : settings;
};

/** Collapse any refresh burst into the active request plus one latest rerun. */
export const createCoalescedRefresh = <T>(
  load: () => Promise<T>,
  commit: (value: T) => void
): (() => Promise<void>) => {
  let active: Promise<void> | null = null;
  let rerun = false;
  return () => {
    if (active) {
      rerun = true;
      return active;
    }
    const run = async () => {
      do {
        rerun = false;
        commit(await load());
      } while (rerun);
    };
    active = run().finally(() => {
      active = null;
    });
    return active;
  };
};
