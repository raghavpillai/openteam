import { expect, test } from "bun:test";
import { pluginToolArguments } from "../../src/services/plugin/tool-arguments";

test("normalizes captured MCP arguments while preserving distinct source and destination labels", () => {
  expect(
    pluginToolArguments("RenameMcpAccount", {
      server_id: "server",
      account_label: 'account="work"',
      new_account_label: "personal",
    })
  ).toEqual({ server_id: "server", account_label: "work", accountLabel: "personal" });
  expect(pluginToolArguments("InstallPlugin", { plugin_id: "slack" })).toEqual({
    pluginKey: "slack",
  });
  expect(pluginToolArguments("AuthenticateMcpServer", { force_reauth: true })).toEqual({
    forceReauth: true,
  });
  expect(() => pluginToolArguments("GetPlugin", { plugin_id: "one", pluginKey: "two" })).toThrow(
    "Conflicting"
  );
});

test("validates the captured OAuth object before creating a review or mutating accounts", () => {
  const good = {
    url: "https://fixture.example.test/mcp",
    auth: { CLIENT_ID: "public-client", scopes: ["read", "offline_access"] },
  };
  expect(pluginToolArguments("AddMcpServer", good)).toEqual(good);
  for (const auth of [
    null,
    [],
    { CLIENT_ID: "" },
    { CLIENT_ID: "id", CLIENT_SECRET: {} },
    { CLIENT_ID: "id", scopes: [42] },
  ])
    expect(() => pluginToolArguments("AddMcpServer", { url: good.url, auth })).toThrow(
      "OAuth settings"
    );
  expect(() => pluginToolArguments("AddMcpServer", { ...good, command: "bun" })).toThrow(
    "OAuth settings"
  );
});

test("plugin_id also arrives as id or pluginId, and conflicting spellings are refused", () => {
  for (const action of ["GetPlugin", "InstallPlugin", "UninstallPlugin"]) {
    expect(pluginToolArguments(action, { id: "linear" })).toEqual({ pluginKey: "linear" });
    expect(pluginToolArguments(action, { pluginId: "linear", values: {} })).toEqual({ pluginKey: "linear", values: {} });
    expect(pluginToolArguments(action, { plugin_id: "linear", id: "linear" })).toEqual({ pluginKey: "linear" });
    expect(() => pluginToolArguments(action, { plugin_id: "linear", id: "notion" })).toThrow(
      "Pass the plugin's id once, as plugin_id (from SearchPlugins)."
    );
  }
  // A new account label is stored the way the reference stores it.
  expect(pluginToolArguments("RenameMcpAccount", { server_id: "s", account_label: "Work", new_account_label: "  Personal " })).toMatchObject({ accountLabel: "personal" });
});
