import type { SetPluginToolPolicyInput } from "@openteam/contracts";
import { ApiError } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { appendEvent, serviceEffect } from "../service-utils";
import { toolSnapshot } from "./values";

export class PluginAccess {
  constructor(private readonly prisma: PrismaClient) {}
  setGrant = (connectionId: string, botId: string, enabled: boolean) =>
    serviceEffect(async () => {
      const [connection, bot] = await Promise.all([
        this.prisma.pluginConnection.findUnique({ where: { id: connectionId } }),
        this.prisma.bot.findUnique({ where: { id: botId } }),
      ]);
      if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
      if (!bot || bot.status === "archived") {
        throw new ApiError(404, "bot_not_found", "Bot not found");
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.botPluginEnablement.upsert({
          where: {
            botId_installationId: { botId, installationId: connection.installationId },
          },
          create: { botId, installationId: connection.installationId, enabled: true },
          update: { enabled: true },
        });
        await tx.botPluginConnectionGrant.upsert({
          where: { botId_connectionId: { botId, connectionId } },
          create: { botId, connectionId, enabled },
          update: { enabled },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId,
            botId,
            kind: enabled ? "grant.enabled" : "grant.disabled",
            summary: `${enabled ? "Granted" : "Revoked"} ${connection.name} access for ${bot.name}`,
          },
        });
        await appendEvent(tx, "plugin.grant.updated", connectionId, { botId, enabled });
      });
      return { connectionId, botId, enabled };
    });

  setEnablement = (pluginKey: string, botId: string, enabled: boolean, skillsEnabled = enabled) =>
    serviceEffect(async () => {
      const [installation, bot] = await Promise.all([
        this.prisma.pluginInstallation.findUnique({ where: { pluginKey } }),
        this.prisma.bot.findUnique({ where: { id: botId } }),
      ]);
      if (!installation) {
        throw new ApiError(404, "plugin_not_installed", "Plugin is not installed");
      }
      if (!bot || bot.status === "archived") {
        throw new ApiError(404, "bot_not_found", "Bot not found");
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.botPluginEnablement.upsert({
          where: { botId_installationId: { botId, installationId: installation.id } },
          create: { botId, installationId: installation.id, enabled, skillsEnabled },
          update: { enabled, skillsEnabled },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: installation.id,
            botId,
            kind: enabled ? "plugin.bot_enabled" : "plugin.bot_disabled",
            summary: `${enabled ? "Enabled" : "Disabled"} ${installation.name} for ${bot.name}`,
          },
        });
        await appendEvent(tx, "plugin.bot_enablement.updated", installation.id, {
          botId,
          enabled,
          skillsEnabled,
        });
      });
      return { pluginKey, botId, enabled, skillsEnabled };
    });

  setPolicy = (connectionId: string, input: SetPluginToolPolicyInput) =>
    serviceEffect(async () => {
      const connection = await this.prisma.pluginConnection.findUnique({
        where: { id: connectionId },
      });
      if (!connection) throw new ApiError(404, "connection_not_found", "Connection not found");
      if (!toolSnapshot(connection.toolSnapshot).some((tool) => tool.name === input.toolName)) {
        throw new ApiError(404, "plugin_tool_not_found", "Tool not found on this connection");
      }
      if (input.botId) {
        const bot = await this.prisma.bot.findUnique({ where: { id: input.botId } });
        if (!bot) throw new ApiError(404, "bot_not_found", "Bot not found");
      }
      const policy = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.pluginToolPolicy.findFirst({
          where: { connectionId, botId: input.botId, toolName: input.toolName },
        });
        const value = existing
          ? await tx.pluginToolPolicy.update({
              where: { id: existing.id },
              data: { decision: input.decision },
            })
          : await tx.pluginToolPolicy.create({
              data: { connectionId, ...input },
            });
        await tx.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId,
            botId: input.botId,
            kind: "policy.updated",
            summary: `${input.toolName} is now ${input.decision}`,
          },
        });
        await appendEvent(tx, "plugin.policy.updated", connectionId, input);
        return value;
      });
      return { id: policy.id, decision: policy.decision };
    });
}
