const NETWORK_FAILURE_MARKERS = [
  "could not connect",
  "fetch failed",
  "network request failed",
  "network connection was lost",
  "the internet connection appears to be offline",
] as const;

export const networkFailureMessage = (cause: unknown): string | null => {
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const normalized = detail.toLocaleLowerCase("en-US");
  return NETWORK_FAILURE_MARKERS.some((marker) => normalized.includes(marker))
    ? "OpenTeam couldn't reach your server. Check the connection and try again."
    : null;
};
