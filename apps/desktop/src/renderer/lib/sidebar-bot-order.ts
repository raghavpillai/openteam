import { createContext, useContext } from "react";

/** Bot ids in the order the sidebar first shows them, for surfaces outside the sidebar. */
export const SidebarBotOrderContext = createContext<readonly string[]>([]);

export const useSidebarBotOrder = () => useContext(SidebarBotOrderContext);

/** The busy bots, first as the sidebar lists them; bots the sidebar doesn't show come last. */
export function inSidebarOrder<T extends { botId: string }>(
  bots: readonly T[],
  order: readonly string[]
): T[] {
  const rank = (botId: string) => {
    const index = order.indexOf(botId);
    return index < 0 ? order.length : index;
  };
  return bots
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => rank(a.bot.botId) - rank(b.bot.botId) || a.index - b.index)
    .map(({ bot }) => bot);
}
