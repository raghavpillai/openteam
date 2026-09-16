export const DESKTOP_UPDATE_RESTART_EVENT = "openteam:request-update-restart";

export function requestDesktopUpdateRestart(update: OpenTeamUpdateStatus) {
  window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_RESTART_EVENT, { detail: update }));
}
