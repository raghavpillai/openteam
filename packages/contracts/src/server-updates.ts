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
