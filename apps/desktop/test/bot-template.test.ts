import { describe, expect, test } from "bun:test";
import { parseBotRecipe } from "@openteam/contracts/bot-recipe";
import { botTemplateRecipe } from "../src/renderer/lib/bot-template";
import type { RoutineView } from "../src/renderer/lib/routines";

const routine = (overrides: Partial<RoutineView>): RoutineView =>
  ({
    id: "r1",
    name: "Morning brief",
    prompt: "Summarize my inbox.",
    schedule: "0 8 * * 1-5",
    schedules: [],
    scheduleKind: "cron",
    timezone: "America/New_York",
    triggerPresentation: null,
    ...overrides,
  }) as unknown as RoutineView;

const bot = {
  name: "Scout",
  description: "",
  instructions: "Reply in English.",
  color: "#A47952",
  icon: "classic",
};

describe("bot template export", () => {
  test("matches the iPhone app's recipe and passes the server's parser", () => {
    const recipe = botTemplateRecipe(bot, [routine({})]);
    expect(recipe.profile).toEqual({
      name: "Scout",
      description: "Scout",
      avatarColor: "#A47952",
      avatarShape: "classic",
    });
    expect(recipe.skills).toEqual([
      {
        name: "Instructions",
        description: "Bot instructions",
        content: "# Instructions\n\nReply in English.",
      },
    ]);
    expect(recipe.gettingStarted).toEqual({ skill: "Instructions" });
    expect(recipe.routines).toHaveLength(1);
    expect(recipe.routines[0]?.slug).toBe("r1");
    expect(recipe.routines[0]?.content).toStartWith("Schedule: ");
    expect(recipe.routines[0]?.content).toContain("Time zone: America/New_York\n\nSummarize my inbox.");
    expect(parseBotRecipe(JSON.parse(JSON.stringify(recipe)))).toBeTruthy();
  });

  test("leaves out the instructions skill when there are none", () => {
    const recipe = botTemplateRecipe(
      { ...bot, description: "Research", instructions: "  " },
      [routine({ scheduleKind: "event" })]
    );
    expect(recipe.profile.description).toBe("Research");
    expect(recipe.skills).toEqual([]);
    expect(recipe.gettingStarted).toBeUndefined();
    expect(recipe.routines[0]?.description).toBe("On an event");
  });
});
