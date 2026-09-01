import { describe, expect, test } from "bun:test";
import type { PluginBotAccessItemView } from "@openbot/contracts";
import {
  executePluginAccessTransition,
  planPluginConnectionGrant,
  planPluginSkillAccess,
} from "../src/plugin-access";

const bot = (overrides: Partial<PluginBotAccessItemView> = {}): PluginBotAccessItemView => ({
  id: "bot-1",
  name: "Builder",
  icon: "hammer",
  color: "#000000",
  skillsEnabled: false,
  grantedConnectionIds: [],
  ...overrides,
});

describe("shared plugin access transitions", () => {
  test("keeps overall plugin access enabled while another capability remains", () => {
    const skillOff = planPluginSkillAccess(
      "plugin-1",
      bot({ skillsEnabled: true, grantedConnectionIds: ["connection-1"] }),
      false
    );
    expect(skillOff.operations).toEqual([
      {
        type: "enablement",
        pluginKey: "plugin-1",
        botId: "bot-1",
        enabled: true,
        skillsEnabled: false,
      },
    ]);

    const finalGrantOff = planPluginConnectionGrant(
      "plugin-1",
      bot({ grantedConnectionIds: ["connection-1"] }),
      "connection-1",
      false
    );
    expect(finalGrantOff.operations.map((operation) => operation.type)).toEqual([
      "grant",
      "enablement",
    ]);
    expect(finalGrantOff.next.grantedConnectionIds).toEqual([]);
  });

  test("rolls back a partially applied transition", async () => {
    const transition = planPluginConnectionGrant("plugin-1", bot(), "connection-1", true);
    const calls: string[] = [];
    await expect(
      executePluginAccessTransition(transition, {
        setEnablement: async (_pluginKey, _botId, enabled) => {
          calls.push(`enable:${enabled}`);
        },
        setGrant: async (_connectionId, _botId, enabled) => {
          calls.push(`grant:${enabled}`);
          if (enabled) throw new Error("grant failed");
        },
      })
    ).rejects.toThrow("grant failed");
    expect(calls).toEqual(["enable:true", "grant:true", "grant:false", "enable:false"]);
  });
});
