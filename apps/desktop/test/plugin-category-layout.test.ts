import { describe, expect, test } from "bun:test";
import { visiblePluginCategoryCount } from "../src/renderer/lib/plugin-category-layout";

describe("responsive plugin categories", () => {
  test("uses the full row when every category fits without a toggle", () => {
    expect(visiblePluginCategoryCount(166, [50, 50, 50], 8, 60)).toBe(3);
  });

  test("reserves both the toggle width and its gap as soon as one category overflows", () => {
    expect(visiblePluginCategoryCount(165, [50, 50, 50], 8, 60)).toBe(1);
    expect(visiblePluginCategoryCount(176, [50, 50, 50, 50], 8, 60)).toBe(2);
    expect(visiblePluginCategoryCount(175, [50, 50, 50, 50], 8, 60)).toBe(1);
  });

  test("keeps categories in order with varying label widths", () => {
    expect(visiblePluginCategoryCount(250, [45, 90, 180, 30], 8, 60)).toBe(2);
  });

  test("still exposes the toggle on narrow layouts", () => {
    expect(visiblePluginCategoryCount(90, [50, 90], 8, 60)).toBe(0);
    expect(visiblePluginCategoryCount(200, [], 8, 60)).toBe(0);
  });
});
