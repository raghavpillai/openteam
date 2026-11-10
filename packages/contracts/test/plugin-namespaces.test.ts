import { expect, test } from "bun:test";
import { connectorCustomInstructionsSection, pluginDynamicNamespaces } from "../src/plugin-namespaces";

const connection = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: "Gmail", alias: "default", connectorKey: "gmail", status: "ready", statusMessage: null,
  instructions: "", toolSnapshot: [{ name: "search_threads", description: "Search", inputSchema: { type: "object" } }],
  installation: { pluginKey: "gmail" }, ...overrides,
});
const names = new Map([["a", "gmail"], ["b", "gmail--work"], ["c", "linear"], ["d", "hex"]]);

test("namespaces carry the account and a not-ready reason, never saved instructions", () => {
  const [ready, signedOut] = pluginDynamicNamespaces([
    connection("a", { instructions: "Reply in threads.", statusMessage: "stale" }),
    connection("b", { alias: "work", status: "needs_auth", statusMessage: "Sign in again" }),
  ], names);
  expect(ready).toEqual({
    name: "gmail", description: "Gmail (default)", namespaceStatus: "ready", fileTransfers: { upload: true, download: true },
    tools: [{ connectionId: "a", name: "search_threads", description: "Search", inputSchema: { type: "object" }, source: "gmail/gmail" }],
  });
  expect(signedOut).toMatchObject({ name: "gmail--work", description: "Gmail (work)", namespaceStatus: "needsAuth", statusMessage: "Sign in again" });
});

test("shared server and worker namespaces hide manifest-declared and metadata-only host tools", () => {
  const hostNames = ["start_link", "finish_link", "link_status", "cancel_link", "remove_account", "poll_events", "send_draft"];
  const [namespace] = pluginDynamicNamespaces([connection("a", {
    installation: { pluginKey: "signal", manifest: { connections: [{
      key: "gmail", deviceLink: { startTool: hostNames[0], finishTool: hostNames[1], statusTool: hostNames[2],
        cancelTool: hostNames[3], removeTool: hostNames[4] },
      events: { pollTool: hostNames[5] }, drafts: { tool: hostNames[6] },
    }, { key: "another", deviceLink: { startTool: "public_read" } }] } },
    toolSnapshot: [
      ...hostNames.map(name => ({ name, description: "host", inputSchema: {} })),
      { name: "metadata_host", _meta: { "openteam/hostOnly": true } },
      { name: "public_read", description: "Public", inputSchema: {}, risk: "read" },
    ],
  })], names);
  expect(namespace!.tools).toEqual([{ connectionId: "a", name: "public_read", description: "Public",
    inputSchema: {}, source: "signal/gmail", readOnly: true }]);
});

test("saved instructions of connected accounts become the reference's always-follow section", () => {
  expect(connectorCustomInstructionsSection([
    connection("c", { name: "Linear", installation: { pluginKey: "linear" }, instructions: "  Use the ENG team.  " }),
    connection("b", { alias: "work", instructions: "Reply in threads." }),
    connection("a", { status: "needs_auth", instructions: "Signed out, so not listed." }),
    connection("d", { name: "Hex", installation: { pluginKey: "custom-mcp-1" } }),
  ], names)).toBe([
    "## Connector custom instructions",
    "Custom instructions are configured for some connected tools (MCP connectors). Always follow the matching instruction whenever you use that connector's tools, even before your first call to it:",
    "- Gmail (work), namespace gmail--work: Reply in threads.",
    "- Hex (default), namespace hex: When using Hex, get the underlying numbers as data: download/export the results as CSV or use the data the connector returns, and analyze those raw values directly. Don't read rendered charts or graphs from screenshots (computer-use chart reading is unreliable) — work from the actual data.",
    "- Linear (default), namespace linear: Use the ENG team.",
  ].join("\n"));
  expect(connectorCustomInstructionsSection([connection("a")], names)).toBe("");
});
