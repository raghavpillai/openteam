/** Updates always belong to the server handling the authenticated request. */
export interface ServerUpdateView {
  updaterAvailable: boolean;
  status: "ready" | "updating" | "updated" | "unavailable" | "error";
  targetVersion: string | null;
  phase: string | null;
  message: string;
  jobId: string | null;
  safeToCloseDesktop: boolean;
}

export interface ServerUpdateRequest {
  id: string;
  targetVersion: string;
  status: "queued" | "running" | "complete" | "error";
  phase: string;
  message: string;
  jobId: string | null;
}

export interface ServerUpdateHeartbeat {
  requestId?: string;
  status?: "running" | "complete" | "error";
  phase?: string;
  message?: string;
  jobId?: string | null;
}

const BUSY_NOTE = "Nothing changed; try again when";

/** Who an update is waiting for, by the names the user knows them by: "Scout is still working". */
export const stillWorking = (names: readonly string[]): string => {
  const known = names.filter((name) => name.trim());
  if (known.length < 2) return `${known[0] ?? "An agent"} is still working`;
  return `${known.slice(0, -1).join(", ")} and ${known[known.length - 1]} are still working`;
};

/** An update's refusal while bots are working; Desktop shows it as it is. */
export const updateBusyMessage = (names: readonly string[]): string =>
  `${stillWorking(names)}. ${BUSY_NOTE} ${names.filter((name) => name.trim()).length > 1 ? "they're" : "it's"} done.`;

export const isUpdateBusyMessage = (message: string | null | undefined): boolean =>
  Boolean(message?.includes(` still working. ${BUSY_NOTE} `));
