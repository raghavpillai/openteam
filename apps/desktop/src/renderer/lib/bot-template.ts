import type { BotView } from "@openteam/contracts";
import type { BotRecipe } from "@openteam/contracts/bot-recipe";
import { describeRoutineSchedules, routineScheduleDrafts, type RoutineView } from "./routines";

export const BOT_TEMPLATE_FILENAME = "Bot Template.json";

const scheduleSummary = (routine: RoutineView) =>
  routine.scheduleKind === "event"
    ? "On an event"
    : describeRoutineSchedules(routineScheduleDrafts(routine));

/**
 * A bot's shareable template: profile, instructions and routines, as the iPhone app's
 * Share as template builds it. Account data, memories and connector credentials stay out.
 */
export function botTemplateRecipe(
  bot: Pick<BotView, "name" | "description" | "instructions" | "color" | "icon">,
  routines: readonly RoutineView[]
): BotRecipe {
  const hasInstructions = bot.instructions.trim().length > 0;
  return {
    profile: {
      name: bot.name,
      description: bot.description || bot.name,
      avatarColor: bot.color,
      avatarShape: bot.icon,
    },
    visibility: "team",
    memory: [],
    plugins: [],
    skills: hasInstructions
      ? [
          {
            name: "Instructions",
            description: "Bot instructions",
            content: `# Instructions\n\n${bot.instructions}`,
          },
        ]
      : [],
    routines: routines.map((routine) => {
      const summary = scheduleSummary(routine);
      return {
        slug: routine.id,
        name: routine.name,
        description: summary,
        content: `Schedule: ${summary}\nTime zone: ${routine.timezone}\n\n${routine.prompt}`,
      };
    }),
    ...(hasInstructions ? { gettingStarted: { skill: "Instructions" } } : {}),
  };
}

/** Saves the template the way plugin bundles are exported: a file download. */
export function downloadBotTemplate(recipe: BotRecipe) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(recipe)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = BOT_TEMPLATE_FILENAME;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
