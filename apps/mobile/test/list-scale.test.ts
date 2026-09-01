import { describe, expect, test } from "bun:test";
import {
  filterBotRoster,
  MOBILE_VIRTUAL_LIST_TUNING,
  rowsByChannelId,
  selectPinnedRows,
} from "../src/list-scale";

const bots = Array.from({ length: 1_000 }, (_, index) => ({
  id: `bot-${index}`,
  name: `Bot ${index}`,
  title: index === 742 ? "Financial Analyst Specialist" : `Specialist ${index % 20}`,
  description: index === 999 ? "Deep space launch research" : `Description ${index}`,
}));

describe("mobile list scale selectors", () => {
  test("keeps all 1,000 Bots reachable and preserves source order", () => {
    const result = filterBotRoster(bots, "specialist");

    expect(result).toHaveLength(1_000);
    expect(result[0]?.id).toBe("bot-0");
    expect(result[999]?.id).toBe("bot-999");
  });

  test("finds off-window Bots across name, title, and description", () => {
    expect(filterBotRoster(bots, "Bot 999").map((bot) => bot.id)).toEqual(["bot-999"]);
    expect(filterBotRoster(bots, "financial analyst").map((bot) => bot.id)).toEqual(["bot-742"]);
    expect(filterBotRoster(bots, "deep launch").map((bot) => bot.id)).toEqual(["bot-999"]);
  });

  test("normalizes case, whitespace, and compatibility characters", () => {
    expect(filterBotRoster(bots, "  ＦＩＮＡＮＣＩＡＬ   analyst  ").map((bot) => bot.id)).toEqual([
      "bot-742",
    ]);
  });

  test("empty search returns a new ordered array without cloning Bot objects", () => {
    const result = filterBotRoster(bots, "");

    expect(result).not.toBe(bots);
    expect(result).toHaveLength(1_000);
    expect(result[500]).toBe(bots[500]);
  });

  test("indexes 1,100 channels and preserves explicit pin order", () => {
    const rows = Array.from({ length: 1_100 }, (_, index) => ({
      channel: { id: `channel-${index}` },
      marker: index,
    }));
    const index = rowsByChannelId(rows);

    expect(index.size).toBe(1_100);
    expect(index.get("channel-1")?.marker).toBe(1);
    expect(
      selectPinnedRows(rows, ["channel-1099", "missing", "channel-500", "channel-0"]).map(
        (row) => row.marker
      )
    ).toEqual([1_099, 500, 0]);
  });

  test("keeps native virtualization batches deliberately bounded", () => {
    expect(MOBILE_VIRTUAL_LIST_TUNING).toEqual({
      initialNumToRender: 12,
      maxToRenderPerBatch: 10,
      updateCellsBatchingPeriod: 32,
      windowSize: 7,
    });
  });
});
