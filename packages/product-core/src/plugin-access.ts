import type { PluginBotAccessItemView } from "@openteam/contracts";

export type PluginAccessOperation =
  | {
      type: "enablement";
      pluginKey: string;
      botId: string;
      enabled: boolean;
      skillsEnabled: boolean;
    }
  | {
      type: "grant";
      connectionId: string;
      botId: string;
      enabled: boolean;
    };

export interface PluginAccessTransition {
  previous: PluginBotAccessItemView;
  next: PluginBotAccessItemView;
  operations: readonly PluginAccessOperation[];
  rollback: readonly PluginAccessOperation[];
}

const overallAccessEnabled = (
  skillsEnabled: boolean,
  grantedConnectionIds: readonly string[]
): boolean => skillsEnabled || grantedConnectionIds.length > 0;

const enablementOperation = (
  pluginKey: string,
  botId: string,
  skillsEnabled: boolean,
  grantedConnectionIds: readonly string[]
): PluginAccessOperation => ({
  type: "enablement",
  pluginKey,
  botId,
  enabled: overallAccessEnabled(skillsEnabled, grantedConnectionIds),
  skillsEnabled,
});

export const planPluginSkillAccess = (
  pluginKey: string,
  bot: PluginBotAccessItemView,
  skillsEnabled: boolean
): PluginAccessTransition => {
  const next = { ...bot, skillsEnabled };
  return {
    previous: bot,
    next,
    operations: [
      enablementOperation(pluginKey, bot.id, next.skillsEnabled, next.grantedConnectionIds),
    ],
    rollback: [enablementOperation(pluginKey, bot.id, bot.skillsEnabled, bot.grantedConnectionIds)],
  };
};

export const planPluginConnectionGrant = (
  pluginKey: string,
  bot: PluginBotAccessItemView,
  connectionId: string,
  enabled: boolean
): PluginAccessTransition => {
  const hadGrant = bot.grantedConnectionIds.includes(connectionId);
  const grantedConnectionIds = enabled
    ? [...new Set([...bot.grantedConnectionIds, connectionId])]
    : bot.grantedConnectionIds.filter((id) => id !== connectionId);
  const next = { ...bot, grantedConnectionIds };
  const grant: PluginAccessOperation = { type: "grant", connectionId, botId: bot.id, enabled };
  const restoreGrant: PluginAccessOperation = {
    type: "grant",
    connectionId,
    botId: bot.id,
    enabled: hadGrant,
  };
  const nextEnablement = enablementOperation(
    pluginKey,
    bot.id,
    next.skillsEnabled,
    next.grantedConnectionIds
  );
  const previousEnablement = enablementOperation(
    pluginKey,
    bot.id,
    bot.skillsEnabled,
    bot.grantedConnectionIds
  );
  const nextOverall = overallAccessEnabled(next.skillsEnabled, next.grantedConnectionIds);
  const previousOverall = overallAccessEnabled(bot.skillsEnabled, bot.grantedConnectionIds);

  return {
    previous: bot,
    next,
    operations: nextOverall ? [nextEnablement, grant] : [grant, nextEnablement],
    rollback: nextOverall
      ? [restoreGrant, ...(previousOverall ? [] : [previousEnablement])]
      : [restoreGrant, previousEnablement],
  };
};

export interface PluginAccessAdapter {
  setEnablement: (
    pluginKey: string,
    botId: string,
    enabled: boolean,
    skillsEnabled: boolean
  ) => Promise<unknown>;
  setGrant: (connectionId: string, botId: string, enabled: boolean) => Promise<unknown>;
}

const applyOperation = (
  operation: PluginAccessOperation,
  adapter: PluginAccessAdapter
): Promise<unknown> =>
  operation.type === "grant"
    ? adapter.setGrant(operation.connectionId, operation.botId, operation.enabled)
    : adapter.setEnablement(
        operation.pluginKey,
        operation.botId,
        operation.enabled,
        operation.skillsEnabled
      );

export const executePluginAccessTransition = async (
  transition: PluginAccessTransition,
  adapter: PluginAccessAdapter
): Promise<void> => {
  try {
    for (const operation of transition.operations) await applyOperation(operation, adapter);
  } catch (cause) {
    for (const operation of transition.rollback) {
      await applyOperation(operation, adapter).catch(() => undefined);
    }
    throw cause;
  }
};
