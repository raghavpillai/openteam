import { expect, test } from "bun:test";
import { pluginDynamicNamespaces } from "../src/plugin-namespaces";

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
