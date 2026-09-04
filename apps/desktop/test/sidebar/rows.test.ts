import { describe, expect, test } from "bun:test";
import type { ChannelMessageView, ChannelView, RunView } from "@openteam/contracts";
import {
  groupSidebarRows,
  reconcileSidebarRows,
  sidebarRowIsWorking,
  sidebarUnreadJumpTargets,
  type SidebarChannelRow,
} from "../../src/renderer/lib/sidebar-rows";

const channel = (id: string, createdAt: string, updatedAt = createdAt) =>
  ({ id, createdAt, updatedAt }) as ChannelView;
const message = (createdAt: string) => ({ createdAt }) as ChannelMessageView;
const run = (id: string) => ({ id }) as RunView;

describe("sidebar row reconciliation", () => {
  test("shows working presence only for active work, not approval waits", () => {
    expect(sidebarRowIsWorking({ channel: channel("idle", "2026-08-27T10:00:00.000Z") })).toBe(
      false
    );
    expect(
      sidebarRowIsWorking({
        channel: channel("running", "2026-08-27T10:00:00.000Z"),
        running: { status: "running" } as RunView,
      })
    ).toBe(true);
    expect(
      sidebarRowIsWorking({
        channel: channel("approval", "2026-08-27T10:00:00.000Z"),
        running: { status: "waiting_approval" } as RunView,
      })
    ).toBe(false);
    expect(
      sidebarRowIsWorking({
        channel: channel("background", "2026-08-27T10:00:00.000Z"),
        hasActiveTask: true,
      })
    ).toBe(true);
  });

  test("finds Bot's nearest unread rows outside the visible sidebar viewport", () => {
    expect(
      sidebarUnreadJumpTargets(
        [
          { channelId: "read-above", unread: false, top: -60, bottom: -6 },
          { channelId: "far-above", unread: true, unreadCount: 3, top: -60, bottom: -6 },
          { channelId: "near-above", unread: true, top: -54, bottom: 0 },
          { channelId: "partial", unread: true, top: -4, bottom: 50 },
          { channelId: "visible", unread: true, top: 50, bottom: 104 },
          { channelId: "near-below", unread: true, unreadCount: 2, top: 200, bottom: 254 },
          { channelId: "far-below", unread: true, top: 258, bottom: 312 },
        ],
        0,
        200
      )
    ).toEqual({
      above: { channelId: "near-above", count: 4 },
      below: { channelId: "near-below", count: 3 },
    });
  });

  test("reuses unchanged rows and replaces only changed rows", () => {
    const firstChannel = channel("first", "2026-08-27T10:00:00.000Z");
    const secondChannel = channel("second", "2026-08-27T09:00:00.000Z");
    const firstMessage = message("2026-08-27T11:00:00.000Z");
    const secondMessage = message("2026-08-27T10:30:00.000Z");
    const firstRun = run("run-first");
    const initial = reconcileSidebarRows(
      new Map(),
      [firstChannel, secondChannel],
      new Map([
        [firstChannel.id, firstMessage],
        [secondChannel.id, secondMessage],
      ]),
      new Map([[firstChannel.id, firstRun]])
    );

    const nextSecondMessage = message("2026-08-27T12:00:00.000Z");
    const next = reconcileSidebarRows(
      initial.rowByChannelId,
      [firstChannel, secondChannel],
      new Map([
        [firstChannel.id, firstMessage],
        [secondChannel.id, nextSecondMessage],
      ]),
      new Map([[firstChannel.id, firstRun]])
    );

    expect(next.rows[0]).toBe(initial.rows[0]);
    expect(next.rows[1]).not.toBe(initial.rows[1]);
    expect(next.rows[1]?.latest).toBe(nextSecondMessage);
  });

  test("keeps the parent working while a background child is active", () => {
    const parent = channel("parent", "2026-08-27T10:00:00.000Z");
    const active = reconcileSidebarRows(
      new Map(),
      [parent],
      new Map(),
      new Map(),
      new Set([parent.id])
    );

    expect(active.rows[0]?.running).toBeUndefined();
    expect(active.rows[0]?.hasActiveTask).toBe(true);

    const settled = reconcileSidebarRows(
      active.rowByChannelId,
      [parent],
      new Map(),
      new Map(),
      new Set()
    );
    expect(settled.rows[0]?.hasActiveTask).toBe(false);
    expect(settled.rows[0]).not.toBe(active.rows[0]);
  });
});

describe("sidebar grouping", () => {
  test("groups in one pass and preserves recency ordering", () => {
    const rows = [
      {
        channel: channel("section-older", "2026-08-27T09:00:00.000Z"),
      },
      {
        channel: channel("pinned", "2026-08-27T08:00:00.000Z"),
        latest: message("2026-08-27T13:00:00.000Z"),
      },
      {
        channel: channel("section-newer", "2026-08-27T12:00:00.000Z"),
      },
      {
        channel: channel("unassigned", "2026-08-27T11:00:00.000Z"),
      },
      {
        channel: channel("stale-section", "2026-08-27T10:00:00.000Z"),
      },
    ] satisfies SidebarChannelRow[];

    const groups = groupSidebarRows(rows, new Set(["pinned"]), [{ id: "work" }], {
      "section-older": "work",
      "section-newer": "work",
      "stale-section": "removed-section",
    });

    expect(groups.pinned.map((row) => row.channel.id)).toEqual(["pinned"]);
    expect(groups.bySection.work?.map((row) => row.channel.id)).toEqual([
      "section-newer",
      "section-older",
    ]);
    expect(groups.unassigned.map((row) => row.channel.id)).toEqual(["unassigned", "stale-section"]);
  });

  test("does not treat metadata updates as conversation activity", () => {
    const rows = [
      {
        channel: channel(
          "older-but-reconciled",
          "2026-08-27T09:00:00.000Z",
          "2026-08-27T15:00:00.000Z"
        ),
      },
      {
        channel: channel("newer", "2026-08-27T10:00:00.000Z"),
      },
    ] satisfies SidebarChannelRow[];

    const groups = groupSidebarRows(rows, new Set(), [], {});

    expect(groups.unassigned.map((row) => row.channel.id)).toEqual([
      "newer",
      "older-but-reconciled",
    ]);
  });

  test("keeps the exact pinned, custom-section, and unassigned display order", () => {
    const rows = [
      { channel: channel("unassigned", "2026-08-27T10:00:00.000Z") },
      { channel: channel("second-old", "2026-08-27T11:00:00.000Z") },
      { channel: channel("pinned-old", "2026-08-27T12:00:00.000Z") },
      { channel: channel("first", "2026-08-27T13:00:00.000Z") },
      { channel: channel("pinned-new", "2026-08-27T14:00:00.000Z") },
      { channel: channel("second-new", "2026-08-27T15:00:00.000Z") },
    ] satisfies SidebarChannelRow[];
    const sections = [{ id: "first-section" }, { id: "second-section" }];
    const groups = groupSidebarRows(rows, new Set(["pinned-old", "pinned-new"]), sections, {
      first: "first-section",
      "second-old": "second-section",
      "second-new": "second-section",
    });
    const visibleOrder = [
      ...groups.pinned,
      ...sections.flatMap((section) => groups.bySection[section.id] ?? []),
      ...groups.unassigned,
    ].map((row) => row.channel.id);

    expect(visibleOrder).toEqual([
      "pinned-new",
      "pinned-old",
      "first",
      "second-new",
      "second-old",
      "unassigned",
    ]);
  });
});
