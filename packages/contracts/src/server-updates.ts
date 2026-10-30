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

/** Milestones from the host updater, not an estimate of bytes or time remaining. */
export const SERVER_UPDATE_STEPS = ["Prepare", "Download", "Back up", "Restart", "Verify"] as const;

export function serverUpdateProgress(phase: string | null | undefined) {
  const phases: Record<string, { step: number; title: string }> = {
    queued: { step: 0, title: "Preparing update" },
    checking: { step: 0, title: "Preparing update" },
    downloading: { step: 1, title: "Verifying the release" },
    pulling: { step: 1, title: "Downloading update" },
    "backing-up": { step: 2, title: "Protecting your data" },
    restarting: { step: 3, title: "Restarting services" },
    verifying: { step: 4, title: "Checking server health" },
    "updating-cli": { step: 4, title: "Finishing up" },
    complete: { step: 5, title: "Update complete" },
  };
  return {
    step: phases[phase ?? ""]?.step ?? null,
    title:
      phase === "rolling-back"
        ? "Restoring the previous version"
        : (phases[phase ?? ""]?.title ?? "Update in progress"),
    rollingBack: phase === "rolling-back",
  };
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
