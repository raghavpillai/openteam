export const WINDOW_VISIBILITY_EVENT = "openteam:visibility-change";
export const WINDOW_ACTIVITY_EVENT = "openteam:window-activity-change";
let nativeVisible = true;
let nativeActive: boolean | undefined;

export const isWindowVisible = () => nativeVisible && !document.hidden;
// A shown window can be behind another app. Keep transport visibility separate
// from foreground-only decoration and polling so notifications stay connected.
export const isWindowActive = () => isWindowVisible() && (nativeActive ?? document.hasFocus());

export const subscribeWindowActivity = (onChange: () => void) => {
  window.addEventListener(WINDOW_ACTIVITY_EVENT, onChange);
  return () => window.removeEventListener(WINDOW_ACTIVITY_EVENT, onChange);
};

// Background throttling stays disabled for durable notifications. Explicit native
// visibility controls visual work without falsifying the browser's visibility API.
export const installWindowVisibility = () => {
  const publishActivity = () => {
    document.documentElement.toggleAttribute("data-window-inactive", !isWindowActive());
    window.dispatchEvent(new Event(WINDOW_ACTIVITY_EVENT));
  };
  const publish = () => {
    document.documentElement.toggleAttribute("data-window-hidden", !isWindowVisible());
    publishActivity();
    window.dispatchEvent(new Event(WINDOW_VISIBILITY_EVENT));
  };
  const unsubscribe = window.openteam?.visibility?.subscribe((visible) => {
    nativeVisible = visible;
    publish();
  });
  const unsubscribeActivity = window.openteam?.visibility?.subscribeActivity?.((active) => {
    nativeActive = active;
    publishActivity();
  });
  document.addEventListener("visibilitychange", publish);
  window.addEventListener("focus", publishActivity);
  window.addEventListener("blur", publishActivity);
  publish();
  return () => {
    unsubscribe?.();
    unsubscribeActivity?.();
    document.removeEventListener("visibilitychange", publish);
    window.removeEventListener("focus", publishActivity);
    window.removeEventListener("blur", publishActivity);
    nativeVisible = true;
    nativeActive = undefined;
    document.documentElement.removeAttribute("data-window-hidden");
    document.documentElement.removeAttribute("data-window-inactive");
  };
};
