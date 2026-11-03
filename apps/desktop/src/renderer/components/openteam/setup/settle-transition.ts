/**
 * Handles a view transition's promises. One that starts while another is still running
 * skips the older one, whose promises then reject ("Transition was skipped"); fast Esc and
 * Enter in setup do this often. The page still updates, so only a failed update is reported.
 */
export function settleTransition(transition: ViewTransition) {
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  transition.updateCallbackDone.catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
  });
}
