import { describe, expect, test } from "bun:test";
import { createOpenBotClient } from "../src";

describe("plugin enablement client", () => {
  test("keeps overall and skill access independent without changing legacy calls", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({});
    }) as unknown as typeof globalThis.fetch;
    const client = createOpenBotClient({ baseUrl: "http://openbot.test", fetch });

    await client.setPluginEnablement("plugin/key", "bot-1", true, false);
    await client.setPluginEnablement("plugin/key", "bot-1", false);

    expect(calls).toEqual([
      {
        url: "http://openbot.test/api/v0/plugins/plugin%2Fkey/enablement",
        body: { botId: "bot-1", enabled: true, skillsEnabled: false },
      },
      {
        url: "http://openbot.test/api/v0/plugins/plugin%2Fkey/enablement",
        body: { botId: "bot-1", enabled: false, skillsEnabled: false },
      },
    ]);
  });
});
