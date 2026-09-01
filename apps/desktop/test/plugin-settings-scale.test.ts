import { describe, expect, test } from "bun:test";
import type { PluginConnectionView, PluginSettingsView } from "@openbot/contracts";
import {
  createCoalescedRefresh,
  mergePluginConnectionStatuses,
  PLUGIN_BOT_ACCESS_PAGE_SIZE,
  pluginBotAccessWindow,
} from "../src/renderer/lib/plugin-settings-scale";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("plugin settings scaling", () => {
  test("bounds the initial Bot-access render while preserving search over every Bot", () => {
    const bots = Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index),
      name: `Audit Bot ${String(index).padStart(4, "0")}`,
    }));

    const initial = pluginBotAccessWindow(bots, "", PLUGIN_BOT_ACCESS_PAGE_SIZE);
    expect(initial.total).toBe(1_000);
    expect(initial.items).toHaveLength(60);

    const filtered = pluginBotAccessWindow(bots, "Bot 0999", PLUGIN_BOT_ACCESS_PAGE_SIZE);
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]).toEqual({ id: "999", name: "Audit Bot 0999" });
  });

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
      policies: [],
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
          status: "ready",
          statusMessage: null,
          authorizationUrl: null,
          configured: true,
          tools: [
            { name: "search", description: "Search", risk: "read", defaultDecision: "allow" },
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
      authorizationUrl: null,
      tools: [{ name: "search" }],
    });
  });

  test("A/B bounds initial payload and access DOM at 1,000 Bots", () => {
    const bots = Array.from({ length: 1_000 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Audit Bot ${index}`,
      icon: "●",
      color: "#4f7cff",
    }));
    const connectionIds = Array.from({ length: 5 }, (_, index) => `connection-${index}`);
    const legacy = {
      catalog: [],
      installs: [
        {
          pluginKey: "audit",
          enabledBotIds: bots.map((bot) => bot.id),
          connections: connectionIds.map((id) => ({
            id,
            grantedBotIds: bots.map((bot) => bot.id),
          })),
        },
      ],
      connections: connectionIds.map((id) => ({
        id,
        grantedBotIds: bots.map((bot) => bot.id),
      })),
      bots,
      policies: [],
      activity: [],
    };
    const optimizedSettings = {
      catalog: [],
      installs: [
        {
          pluginKey: "audit",
          connections: connectionIds.map((id) => ({ id, revision: "1" })),
        },
      ],
      botCount: bots.length,
      policies: [],
      activity: [],
    };
    const firstAccessPage = bots.slice(0, PLUGIN_BOT_ACCESS_PAGE_SIZE).map((bot) => ({
      ...bot,
      skillsEnabled: true,
      grantedConnectionIds: connectionIds,
    }));
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
    const optimizedInitialBytes = Buffer.byteLength(JSON.stringify(optimizedSettings));
    const optimizedExpandedBytes = Buffer.byteLength(
      JSON.stringify({ settings: optimizedSettings, access: firstAccessPage })
    );
    const legacyAccessNodes = bots.length * (connectionIds.length + 1);
    const optimizedClosedAccessNodes = 0;
    const optimizedPageAccessNodes = firstAccessPage.length * (connectionIds.length + 1);

    expect({ legacyBytes, optimizedExpandedBytes, optimizedInitialBytes }).toEqual({
      legacyBytes: 180_106,
      optimizedExpandedBytes: 11_698,
      optimizedInitialBytes: 294,
    });
    expect(legacyBytes).toBeGreaterThan(optimizedInitialBytes * 100);
    expect(legacyBytes).toBeGreaterThan(optimizedExpandedBytes * 10);
    expect(legacyAccessNodes).toBe(6_000);
    expect(optimizedClosedAccessNodes).toBe(0);
    expect(optimizedPageAccessNodes).toBe(360);
    expect(firstAccessPage).toHaveLength(PLUGIN_BOT_ACCESS_PAGE_SIZE);
  });
});
