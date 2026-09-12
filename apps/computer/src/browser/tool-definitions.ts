import { objectToolSchema } from "../tool-schema";
export interface BrowserUseToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const viewId = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description: "Optional tab viewId returned by a prior browser action.",
} as const;

export const element = {
  type: "string",
  maxLength: 500,
  description: "Concise description of the target element and intended action.",
} as const;

export const BROWSER_USE_TOOLS: readonly BrowserUseToolDefinition[] = [
  {
    name: "browser_navigate",
    description:
      "Navigate the box browser to a URL. By default reuses your leased tab; set newTab: true to open another leased tab. Returns the resulting page state with a screenshot.",
    inputSchema: objectToolSchema(
      { url: { type: "string" }, viewId, newTab: { type: "boolean" } },
      ["url"]
    ),
  },
  {
    name: "browser_snapshot",
    description:
      "Capture a structured ARIA snapshot with [ref=eN] handles for interactive elements. It pierces open shadow roots and same-origin iframes; cross-origin frames are called out but not inspected. Refs point to exact nodes from this tab's latest snapshot. The explicit >>> selector combinator re-roots each following stage at the previous match.",
    inputSchema: objectToolSchema({
      viewId,
      interactive: { type: "boolean" },
      maxDepth: { type: "number", description: "Maximum snapshot depth. Defaults to 20." },
      selector: { type: "string", maxLength: 1_000 },
    }),
  },
  {
    name: "browser_click",
    description:
      "Click an element by ref from browser_snapshot. Scrolls it into view first and returns the resulting page with a screenshot.",
    inputSchema: objectToolSchema(
      {
        ref: { type: "string" },
        element,
        offsetX: { type: "number", description: "X offset from the element center." },
        offsetY: { type: "number", description: "Y offset from the element center." },
        doubleClick: { type: "boolean" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta", "ControlOrMeta"] },
          maxItems: 4,
        },
        holdDurationMs: { type: "integer", minimum: 0, maximum: 10_000 },
        viewId,
      },
      ["ref"]
    ),
  },
  {
    name: "browser_mouse_click_xy",
    description: "Click at viewport coordinates. Prefer browser_click with refs when possible.",
    inputSchema: objectToolSchema(
      {
        x: { type: "number", minimum: 0 },
        y: { type: "number", minimum: 0 },
        element,
        button: { type: "string", enum: ["left", "right", "middle"] },
        viewId,
      },
      ["x", "y"]
    ),
  },
  {
    name: "browser_type",
    description: "Type text into an editable element by ref.",
    inputSchema: objectToolSchema(
      {
        ref: { type: "string" },
        text: { type: "string", maxLength: 100_000 },
        element,
        clear: { type: "boolean" },
        submit: { type: "boolean" },
        slowly: { type: "boolean" },
        viewId,
      },
      ["ref", "text"]
    ),
  },
  {
    name: "browser_fill",
    description: "Set the value of an editable element by ref.",
    inputSchema: objectToolSchema(
      {
        ref: { type: "string" },
        value: { type: "string", maxLength: 100_000 },
        element,
        viewId,
      },
      ["ref", "value"]
    ),
  },
  {
    name: "browser_select_option",
    description: "Select one or more option values or labels in a select element by ref.",
    inputSchema: objectToolSchema(
      {
        ref: { type: "string" },
        values: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        element,
        viewId,
      },
      ["ref", "values"]
    ),
  },
  {
    name: "browser_press_key",
    description: "Press a key or key chord in the selected browser page.",
    inputSchema: objectToolSchema(
      { key: { type: "string", minLength: 1, maxLength: 100 }, viewId },
      ["key"]
    ),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page or scroll a referenced element into view.",
    inputSchema: objectToolSchema({
      ref: { type: "string" },
      element,
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "number", minimum: 0, maximum: 100_000 },
      deltaX: { type: "number", minimum: -100_000, maximum: 100_000 },
      deltaY: { type: "number", minimum: -100_000, maximum: 100_000 },
      viewId,
    }),
  },
  {
    name: "browser_drag",
    description: "Drag an element by ref to another ref or viewport coordinates.",
    inputSchema: objectToolSchema(
      {
        sourceRef: { type: "string" },
        element,
        targetRef: { type: "string" },
        targetX: { type: "number", minimum: 0 },
        targetY: { type: "number", minimum: 0 },
        viewId,
      },
      ["sourceRef"]
    ),
  },
  {
    name: "browser_get_bounding_box",
    description: "Get the viewport bounding box for an element ref.",
    inputSchema: objectToolSchema({ ref: { type: "string" }, element, viewId }, ["ref"]),
  },
  {
    name: "browser_highlight",
    description: "Highlight an element by ref and return a screenshot showing the highlight.",
    inputSchema: objectToolSchema(
      {
        ref: { type: "string" },
        element,
        durationMs: { type: "integer", minimum: 0, maximum: 10_000 },
        viewId,
      },
      ["ref"]
    ),
  },
  {
    name: "browser_cdp",
    description:
      "Send an allowed Chrome DevTools Protocol command to the selected tab. Input, browser-wide, storage, cookie, cache, permission, and target-management commands are denied.",
    inputSchema: objectToolSchema(
      { method: { type: "string" }, params: { type: "object" }, viewId },
      ["method"]
    ),
  },
  {
    name: "browser_tabs",
    description: "List, create, close, or select a browser tab.",
    inputSchema: objectToolSchema(
      {
        action: { type: "string", enum: ["list", "new", "close", "select"] },
        index: { type: "integer", minimum: 0 },
      },
      ["action"]
    ),
  },
  {
    name: "browser_take_screenshot",
    description: "Take a viewport or full-page screenshot of the selected page.",
    inputSchema: objectToolSchema({ viewId, fullPage: { type: "boolean" } }),
  },
] as const;
