import { describe, expect, test } from "bun:test";
import type { PluginConnectionView, PluginSettingsView } from "@openteam/contracts";
import {
  createCoalescedRefresh,
  mergePluginConnectionStatuses,
} from "../src/renderer/lib/plugin-settings-scale";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("plugin settings scaling", () => {;

  test("coalesces a polling burst into one active request and one rerun", async () => {
    const resolvers: Array<(value: number) => void> = [];
    const committed: number[] = [];
    let loads = 0;
    const refresh = createCoalescedRefresh(
      () => {
        loads += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
      (value) => committed.push(value)
    );

    const first = refresh();
    const second = refresh();
    const third = refresh();
    expect(loads).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);

    resolvers[0]?.(1);
    while (loads < 2) await tick();
    expect(loads).toBe(2);
    resolvers[1]?.(2);
    await Promise.all([first, second, third]);
    expect(committed).toEqual([1, 2]);
  });

  test("merges status-only polling without replacing stable settings data", () => {
    const connection = {
      id: "connection-1",
      revision: "2026-08-31T12:00:00.000Z",
      status: "needs_auth",
      statusMessage: "Open the authorization page",
      authorizationUrl: "https://example.com/authorize",
      configured: true,
      tools: [],
    } as PluginConnectionView;
    const settings = {
      catalog: [],
      installs: [{ id: "install-1", pluginKey: "example", connections: [connection] }],
      botCount: 1_000,
      activity: [],
    } as PluginSettingsView;
    const unchanged = mergePluginConnectionStatuses(settings, {
      connections: [
        {
          id: connection.id,
          revision: connection.revision,
          status: "ready",
          statusMessage: null,
          authorizationUrl: null,
          configured: true,
          tools: [],
        },
      ],
    });
    expect(unchanged).toBe(settings);

    const merged = mergePluginConnectionStatuses(settings, {
      connections: [
        {
          id: connection.id,
          revision: "2026-08-31T12:00:01.000Z",
          setupPhase: "connected",
          oauthCallbackMode: "manual",
          status: "ready",
          statusMessage: null,
          authorizationUrl: null,
          configured: true,
          tools: [
            { name: "search", description: "Search", risk: "read", },
          ],
        },
      ],
    });
    expect(merged).not.toBe(settings);
    expect(merged.catalog).toBe(settings.catalog);
    expect(merged.policies).toBe(settings.policies);
    expect(merged.activity).toBe(settings.activity);
    expect(merged.installs[0]?.connections[0]).toMatchObject({
      status: "ready",
      setupPhase: "connected",
      oauthCallbackMode: "manual",
      authorizationUrl: null,
      tools: [{ name: "search" }],
    });
  });;
});
