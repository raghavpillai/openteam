const NETWORK_FAILURE_MARKERS = [
  "could not connect",
  "fetch failed",
  "network request failed",
  "network connection was lost",
  "the internet connection appears to be offline",
] as const;

export const searchFailureMessage = (cause: unknown): string => {
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const normalized = detail.toLocaleLowerCase("en-US");

  if (NETWORK_FAILURE_MARKERS.some((marker) => normalized.includes(marker))) {
    return "OpenTeam couldn't reach your server. Check the connection and try again.";
  }

  return "Search couldn't be completed. Try again.";
};
