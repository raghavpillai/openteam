import { describe, expect, test } from "bun:test";
import {
  canShowInspector,
  CHAT_MIN_WIDTH,
  COMPACT_SIDEBAR_WIDTH,
  maxInspectorWidthForLayout,
  MIN_EXPANDED_SIDEBAR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  moveSnappedSidebar,
  resizeInspector,
  shouldForceCompactSidebar,
  type SnappedSidebarResizeState,
} from "../src/renderer/lib/panel-resize";

describe("panel resize snapping", () => {
  test("left sidebar stops at its expanded minimum before immediately snapping compact", () => {
    const session: SnappedSidebarResizeState = {
      startX: 300,
      startWidth: 300,
      width: 300,
      mode: "expanded",
    };

    expect(moveSnappedSidebar(session, 230).width).toBe(MIN_EXPANDED_SIDEBAR_WIDTH);
    expect(moveSnappedSidebar(session, 209).mode).toBe("expanded");
    expect(moveSnappedSidebar(session, 207)).toEqual({
      startX: 300,
      startWidth: 300,
      width: COMPACT_SIDEBAR_WIDTH,
      mode: "compact",
    });
  });

  test("left sidebar stays compact until the pointer reaches the expanded minimum", () => {
    const session: SnappedSidebarResizeState = {
      startX: 88,
      startWidth: COMPACT_SIDEBAR_WIDTH,
      width: COMPACT_SIDEBAR_WIDTH,
      mode: "compact",
    };

    expect(moveSnappedSidebar(session, 120).width).toBe(COMPACT_SIDEBAR_WIDTH);
    expect(moveSnappedSidebar(session, 239).width).toBe(COMPACT_SIDEBAR_WIDTH);
    expect(moveSnappedSidebar(session, 240)).toEqual({
      startX: 88,
      startWidth: COMPACT_SIDEBAR_WIDTH,
      width: MIN_EXPANDED_SIDEBAR_WIDTH,
      mode: "expanded",
    });
  });

  test("left sidebar opens at the pointer width and keeps following it", () => {
    const session: SnappedSidebarResizeState = {
      startX: 88,
      startWidth: COMPACT_SIDEBAR_WIDTH,
      width: COMPACT_SIDEBAR_WIDTH,
      mode: "compact",
    };

    const expanded = moveSnappedSidebar(session, 267);
    expect(expanded).toEqual({
      startX: 88,
      startWidth: COMPACT_SIDEBAR_WIDTH,
      width: 267,
      mode: "expanded",
    });
    expect(moveSnappedSidebar(expanded, 284).width).toBe(284);
  });

  test("left sidebar preserves the pointer mapping when it closes and reopens", () => {
    const session: SnappedSidebarResizeState = {
      startX: 300,
      startWidth: 300,
      width: 300,
      mode: "expanded",
    };

    const compact = moveSnappedSidebar(session, 207);
    expect(compact.mode).toBe("compact");
    expect(moveSnappedSidebar(compact, 239).width).toBe(COMPACT_SIDEBAR_WIDTH);
    expect(moveSnappedSidebar(compact, 240).width).toBe(MIN_EXPANDED_SIDEBAR_WIDTH);
  });

  test("right sidebar stops at minimum and only arms closing beyond its buffer", () => {
    expect(resizeInspector(320, 960, 1000)).toEqual({
      width: MIN_INSPECTOR_WIDTH,
      shouldClose: false,
    });
    expect(resizeInspector(320, 960, 1032)).toEqual({
      width: MIN_INSPECTOR_WIDTH,
      shouldClose: false,
    });
    expect(resizeInspector(320, 960, 1033)).toEqual({
      width: MIN_INSPECTOR_WIDTH,
      shouldClose: true,
    });
  });

  test("matches Grok's reversible narrow-window pane thresholds", () => {
    expect(shouldForceCompactSidebar(704, 280)).toBe(false);
    expect(shouldForceCompactSidebar(703, 280)).toBe(true);
    expect(shouldForceCompactSidebar(512, COMPACT_SIDEBAR_WIDTH)).toBe(false);

    expect(canShowInspector(984, 280)).toBe(true);
    expect(canShowInspector(983, 280)).toBe(false);
    expect(canShowInspector(792, COMPACT_SIDEBAR_WIDTH)).toBe(true);
    expect(canShowInspector(791, COMPACT_SIDEBAR_WIDTH)).toBe(false);
    expect(CHAT_MIN_WIDTH).toBe(424);
  });

  test("lets the details pane grow only into space beyond Grok's chat minimum", () => {
    expect(maxInspectorWidthForLayout(1_024, 280)).toBe(320);
    expect(maxInspectorWidthForLayout(984, 280)).toBe(MIN_INSPECTOR_WIDTH);
    expect(maxInspectorWidthForLayout(800, COMPACT_SIDEBAR_WIDTH)).toBe(288);
  });
});
