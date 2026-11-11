/** A newer message interrupts a model turn, not the user's unfinished request.
 * Explicit stops still win, including those recorded after an interruption. */
export const requestIsStopped = (run: { requestStoppedAt?: Date | null; status: string; error?: unknown }) => {
  const error = run.error && typeof run.error === "object" ? run.error as { code?: unknown } : null;
  return !!run.requestStoppedAt || (run.status === "cancelled" && error?.code !== "priority_peer_interrupt");
};
