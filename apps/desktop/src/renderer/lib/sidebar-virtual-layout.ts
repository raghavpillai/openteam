export const EXPANDED_SIDEBAR_VIRTUAL_THRESHOLD = 180;
export const EXPANDED_SIDEBAR_MAX_MOUNTED_ITEMS = 48;
export const EXPANDED_SIDEBAR_OVERSCAN = 232;
export const SIDEBAR_CHANNEL_ROW_SIZE = 58;
export const SIDEBAR_PINNED_MAX_MOUNTED_GRID_ROWS = 24;
/** 106px tile plus Bot's 12px pinned-grid row gap. */
export const SIDEBAR_PINNED_GRID_ROW_SIZE = 118;

export type SidebarSectionLayoutInput = {
  id: string;
  collapsed: boolean;
};

export const shouldVirtualizeExpandedSidebar = (channelCount: number, sectionCount: number) =>
  channelCount + sectionCount > EXPANDED_SIDEBAR_VIRTUAL_THRESHOLD;

export const pinnedGridColumnCount = (sidebarWidth: number) =>
  Math.max(1, Math.floor(Math.max(90, sidebarWidth - 24) / 90));

export function chunkPinnedRows<T>(rows: readonly T[], columns: number) {
  const safeColumns = Math.max(1, Math.floor(columns));
  return Array.from({ length: Math.ceil(rows.length / safeColumns) }, (_, index) =>
    rows.slice(index * safeColumns, (index + 1) * safeColumns)
  );
}

/** Mirrors the 30px header, 10px section gap, 4px open-content pad and 58px rows. */
export const estimateSidebarSectionSize = (section: SidebarSectionLayoutInput, rowCount: number) =>
  40 + (section.collapsed ? 0 : 4 + (rowCount > 0 ? rowCount * SIDEBAR_CHANNEL_ROW_SIZE : 28));
