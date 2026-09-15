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
