export const WINDOW_VISIBILITY_EVENT = "openteam:visibility-change";
let nativeVisible = true;

export const isWindowVisible = () => nativeVisible && !document.hidden;

// Background throttling stays disabled for durable notifications. Explicit native
// visibility controls visual work without falsifying the browser's visibility API.
export const installWindowVisibility = () => {
  const publish = () => {
    document.documentElement.toggleAttribute("data-window-hidden", !isWindowVisible());
    window.dispatchEvent(new Event(WINDOW_VISIBILITY_EVENT));
  };
  const unsubscribe = window.openteam?.visibility?.subscribe((visible) => {
    nativeVisible = visible;
    publish();
  });
  document.addEventListener("visibilitychange", publish);
  publish();
  return () => {
    unsubscribe?.();
    document.removeEventListener("visibilitychange", publish);
    nativeVisible = true;
    document.documentElement.removeAttribute("data-window-hidden");
  };
};
