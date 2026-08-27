export const COMPACT_SIDEBAR_WIDTH = 88;
export const MIN_EXPANDED_SIDEBAR_WIDTH = 240;
export const SIDEBAR_SNAP_DISTANCE = 32;

export type SnappedSidebarResizeState = {
  startX: number;
  startWidth: number;
  width: number;
  mode: "compact" | "expanded";
};

export function moveSnappedSidebar(
  session: SnappedSidebarResizeState,
  pointerX: number
): SnappedSidebarResizeState {
  const rawWidth = session.startWidth + pointerX - session.startX;

  if (session.mode === "expanded") {
    if (rawWidth < MIN_EXPANDED_SIDEBAR_WIDTH - SIDEBAR_SNAP_DISTANCE) {
      return {
        ...session,
        width: COMPACT_SIDEBAR_WIDTH,
        mode: "compact",
      };
    }
    return {
      ...session,
      width: Math.max(MIN_EXPANDED_SIDEBAR_WIDTH, rawWidth),
    };
  }

  if (rawWidth >= MIN_EXPANDED_SIDEBAR_WIDTH) {
    return {
      ...session,
      width: rawWidth,
      mode: "expanded",
    };
  }
  return { ...session, width: COMPACT_SIDEBAR_WIDTH };
}

export const MIN_INSPECTOR_WIDTH = 280;
export const INSPECTOR_CLOSE_DISTANCE = 32;

export function resizeInspector(startWidth: number, startX: number, pointerX: number) {
  const rawWidth = startWidth - (pointerX - startX);
  return {
    width: Math.max(MIN_INSPECTOR_WIDTH, rawWidth),
    shouldClose: rawWidth < MIN_INSPECTOR_WIDTH - INSPECTOR_CLOSE_DISTANCE,
  };
}
