import type { ChannelMessageView, ChannelView, RunView } from "@openbot/contracts";
import { describe, expect, test } from "bun:test";
import {
  groupSidebarRows,
  reconcileSidebarRows,
  type SidebarChannelRow,
} from "../src/renderer/lib/sidebar-rows";

const channel = (id: string, createdAt: string, updatedAt = createdAt) =>
  ({ id, createdAt, updatedAt }) as ChannelView;
const message = (createdAt: string) => ({ createdAt }) as ChannelMessageView;
const run = (id: string) => ({ id }) as RunView;

describe("sidebar row reconciliation", () => {
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
});
