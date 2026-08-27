import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { Type } from "typebox";
import { BROWSER_USE_TOOLS, assertAllowedCdpMethod } from "../src/browser-use";

const EXPECTED_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_mouse_click_xy",
  "browser_type",
  "browser_fill",
  "browser_select_option",
  "browser_press_key",
  "browser_scroll",
  "browser_drag",
  "browser_get_bounding_box",
  "browser_highlight",
  "browser_cdp",
  "browser_tabs",
  "browser_take_screenshot",
];

describe("browser-use tool surface", () => {
  test("exposes the complete page-level browser tool set", () => {
    expect(BROWSER_USE_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    const navigate = BROWSER_USE_TOOLS.find((tool) => tool.name === "browser_navigate");
    expect(
      Value.Check(Type.Unsafe<Record<string, unknown>>(navigate!.inputSchema), {
        url: "https://example.com",
        newTab: true,
      })
    ).toBe(true);
    expect(
      Value.Check(Type.Unsafe<Record<string, unknown>>(navigate!.inputSchema), { newTab: true })
    ).toBe(false);
  });

  test("allows tab-scoped inspection and blocks privileged CDP domains", () => {
    expect(() => assertAllowedCdpMethod("Runtime.evaluate")).not.toThrow();
    expect(() => assertAllowedCdpMethod("Performance.getMetrics")).not.toThrow();
    for (const method of [
      "Input.dispatchMouseEvent",
      "Browser.close",
      "Storage.getCookies",
      "Target.createTarget",
      "Network.getAllCookies",
      "Network.clearBrowserCache",
    ]) {
      expect(() => assertAllowedCdpMethod(method)).toThrow("not allowed");
    }
  });
});
