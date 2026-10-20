import { referenceTool } from "@openteam/contracts/tool-contracts";
export interface BrowserUseToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The browser worker's tools, in the order the model sees them. browser_run_code is the
 * primary tool for page work; the others are its observation tools and stepwise fallbacks. */
export const BROWSER_USE_TOOLS: readonly BrowserUseToolDefinition[] = [
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_find",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_run_code",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
].map(referenceTool);
