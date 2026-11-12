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
