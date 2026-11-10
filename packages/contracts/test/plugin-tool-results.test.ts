import { expect, test } from "bun:test";
import { renderPluginResult } from "../src/plugin-tool-results";

const linear = {
  plugin_id: "linear", name: "Linear", description: "Manage Linear issues and projects.", category: "productivity", installed: true,
  connectorCount: 1, skills: [{ name: "triage", description: "Triage incoming issues quickly." }],
  setupFields: [{ key: "API_KEY", label: "API key", required: true, secret: true }],
};
const row = { server_id: "linear--work", name: "Linear", status: "needs_auth", account_label: "work", transport: "http", toolCount: 0, pluginKey: "linear" };

test("SearchPlugins says which installed accounts need sign-in", () => {
  expect(renderPluginResult("SearchPlugins", { plugins: [linear], connections: [row] }, { query: "linear" })).toBe([
    '1 plugin(s) matching "linear" (best first):',
    "- linear: Linear. Manage Linear issues and projects.",
    "  (installed=yes; includes: 1 connector, 1 skill; category=productivity)",
    '  linear--work (account="work") needs sign-in; call AuthenticateMcpServer with its server_id when the task needs it.',
  ].join("\n"));
  expect(renderPluginResult("SearchPlugins", { plugins: [linear], connections: [{ ...row, status: "ready" }] }, {})).not.toContain("needs sign-in");
});

test("GetPlugin leaves live status to GetDynamicTools; InstallPlugin lists full rows", () => {
  expect(renderPluginResult("GetPlugin", { plugin: linear, installed: true, connections: [row] }, { plugin_id: "linear" })).toBe([
    "linear: Linear. Manage Linear issues and projects.",
    "installed=yes · includes: 1 connector, 1 skill · category=productivity",
    "Skills:",
    "  - triage: Triage incoming issues quickly.",
    "Setup fields (pass in InstallPlugin values):",
    "  - API_KEY (API key; required, secret, so ask the user and never guess)",
    "Its installed MCP server(s); GetDynamicTools lists their live status and tools:",
    '- linear--work: Linear · account="work" · transport=http',
  ].join("\n"));
  expect(renderPluginResult("GetPlugin", {}, { id: "lineer" })).toBe('No plugin with id "lineer". Ids come from SearchPlugins. Run it and use the id it lists.');
  const installed = renderPluginResult("InstallPlugin", { completed: true, actionResult: {}, detail: { installed: true, plugin: linear, connections: [row] } }, { plugin_id: "linear" })!;
  expect(installed).toStartWith("Installed Linear (plugin linear).\n");
  expect(installed).toContain('Its installed MCP server(s):\n- linear--work: Linear [needsAuth] · account="work" · transport=http · tools=0 · plugin=linear (remove via UninstallPlugin, which removes the whole plugin)');
});

test("management receipts use the reference wording", () => {
  expect(renderPluginResult("GetMcpServerStatus", { connections: [] }, { server_id: "slack" })).toBe('No installed MCP server "slack". Omit server_id to list every server with its identifier.');
  expect(renderPluginResult("GetMcpServerStatus", { connections: [row] }, { server_id: "linear--work" })).toStartWith("- linear--work: Linear [needsAuth]");
  expect(renderPluginResult("UninstallPlugin", { completed: true, actionResult: { uninstalled: true, pluginName: "Linear" } }, { pluginId: "linear" })).toBe(
    "Uninstalled Linear (plugin linear). Its install record and every connector it added are gone, and the user is signed out of those connectors."
  );
  expect(renderPluginResult("UninstallMcpServer", { completed: true, actionResult: { uninstalled: true, name: "Ramp" }, connections: [] }, { server_id: "ramp" })).toStartWith("Removed MCP server Ramp (ramp).\n");
  expect(renderPluginResult("SetMcpInstructions", { completed: true, actionResult: {}, connections: [] }, { server_id: "slack", instructions: "  " })).toStartWith("Cleared custom instructions");
});
