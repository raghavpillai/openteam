export const RUNTIME_REFRESH_EVENT = "openteam:runtime-refresh";

/** Re-reads server health now, e.g. right after a model is connected. */
export const requestRuntimeRefresh = () => window.dispatchEvent(new Event(RUNTIME_REFRESH_EVENT));
