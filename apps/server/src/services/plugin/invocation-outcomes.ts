export const PLUGIN_RESTART_UNKNOWN_OUTCOME =
  "OpenTeam restarted before the tool result was saved. The operation may have completed remotely. Reconcile its saved identifiers before retrying; do not replay it automatically.";

export const PLUGIN_UNSAVED_UNKNOWN_OUTCOME =
  "OpenTeam could not confirm that the tool result was saved. The operation may have completed remotely. Reconcile its saved identifiers before retrying; do not replay it automatically.";

export const isUnknownPluginOutcome = (error: string | null): boolean =>
  error === PLUGIN_RESTART_UNKNOWN_OUTCOME || error === PLUGIN_UNSAVED_UNKNOWN_OUTCOME;
