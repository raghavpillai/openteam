import { pluginCatalog } from "../plugins/catalog";
import { parseOpenTeamMarketplace } from "../plugins/openteam-marketplace";
import { createHash } from "node:crypto";
import { ApiError, parseBotRecipe, type BotRecipe } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import { Effect } from "effect";
import type { BotService } from "./bot-service";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";
const unavailable = (message: string): never => {
  throw new ApiError(409, "template_unavailable", message);
};
export class SharedTemplateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly bots?: BotService
  ) {}
  async publish(context: ToolContext, raw: unknown) {
    if (process.env.OPENTEAM_TEMPLATE_SHARING === "false")
      return unavailable("Template sharing is disabled on this deployment");
    const channel =
      context.channelId &&
      (await this.prisma.channel.findUnique({ where: { id: context.channelId } }));
    if (!channel || channel.kind !== "bot_dm")
      return unavailable("Publish a template from the bot’s direct chat");
    const recipe = parseBotRecipe(raw);
    if (recipe.visibility === "public" && process.env.OPENTEAM_PUBLIC_TEMPLATES !== "true")
      return unavailable("Public templates are disabled. Choose team visibility");
    const installations = await this.prisma.pluginInstallation.findMany({
      where: {
        status: "installed",
      },
      select: { pluginKey: true, name: true, manifest: true },
    });
    const marketplaceKeys = new Set(pluginCatalog.map((plugin) => plugin.key));
    for (const source of await this.prisma.pluginSource.findMany({ select: { manifest: true } })) {
      try {
        for (const plugin of parseOpenTeamMarketplace(source.manifest).plugins)
          marketplaceKeys.add(plugin.key);
      } catch {
        /* Ignore invalid source snapshots. */
      }
    }
    const customKeys = new Set(
      (await this.prisma.pluginDraft.findMany({ select: { definition: true } })).map((draft) =>
        String(metadataRecord(draft.definition).key)
      )
    );
    recipe.plugins = recipe.plugins.flatMap((plugin) => {
      const installed = installations.find(
        (item) =>
          item.pluginKey === plugin.pluginId &&
          marketplaceKeys.has(item.pluginKey) &&
          !customKeys.has(item.pluginKey)
      );
      return installed ? [{ pluginId: installed.pluginKey, name: installed.name }] : [];
    });
    const digest = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
    const version = await this.prisma.$transaction(async (tx) => {
      const scope = `template-version:${context.botId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope}))`;
      const prior = await tx.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key: context.callId } },
      });
      if (prior) {
        if (prior.requestHash !== digest)
          return unavailable("This call ID already published different content");
        return Number(metadataRecord(prior.response).version);
      }
      const latest = await tx.idempotencyRecord.findMany({
        where: { scope },
        select: { response: true },
      });
      const next =
        Math.max(0, ...latest.map((item) => Number(metadataRecord(item.response).version) || 0)) +
        1;
      await tx.idempotencyRecord.create({
        data: {
          scope,
          key: context.callId,
          requestHash: digest,
          response: { version: next },
          status: "completed",
          expiresAt: new Date("9999-01-01"),
        },
      });
      return next;
    });
    const result = await this.messaging.sendVisible(context, {
      type: "bot-template", template: { recipe, version, digest },
      content: `Shared ${recipe.profile.name} · version ${version}`, end_turn: false,
    });
    const messageId = String(metadataRecord(result.acknowledgement).message_id);
    const current = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`template-publish:${context.botId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const metadata = metadataRecord(message.metadata);
      if (metadata.cardState) return message;
      const older = await tx.channelMessage.findMany({ where: {
        senderBotId: context.botId, id: { not: messageId },
        AND: [{ metadata: { path: ["type"], equals: "bot-template" } }, { metadata: { path: ["cardState"], equals: "published" } }],
      } });
      for (const prior of older) {
        await tx.channelMessage.update({ where: { id: prior.id }, data: { metadata: toJson({
          ...metadataRecord(prior.metadata), cardState: "unpublished", shareUrl: null,
          outcomeId: crypto.randomUUID(), outcomeText: "A newer template version replaced this publication.", outcomeEchoed: false,
        }) } });
        await appendEvent(tx, "channel.message.updated", prior.id, { channelId: prior.channelId, messageId: prior.id });
      }
      const updated = await tx.channelMessage.update({ where: { id: messageId }, data: { metadata: toJson({
        ...metadata, cardState: "published",
        ...(recipe.visibility === "public" && process.env.OPENTEAM_PUBLIC_URL ? { shareUrl: `${process.env.OPENTEAM_PUBLIC_URL.replace(/\/$/, "")}/api/v0/templates/${messageId}` } : {}),
        outcomeId: crypto.randomUUID(), outcomeText: `Template version ${version} was published with ${recipe.visibility} visibility.`, outcomeEchoed: false,
      }) } });
      await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
      return updated;
    });
    return { ...metadataRecord(result.acknowledgement), message_id: messageId, published: metadataRecord(current.metadata).cardState === "published", version, digest };
  }
  mutate = (messageId: string, raw: unknown) => serviceEffect(async () => {
    const input = metadataRecord(raw);
    if (!["import", "unpublish"].includes(String(input.action))) return unavailable("Choose import or unpublish");
    const message = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUnique({ where: { id: messageId }, include: { channel: true } });
      const metadata = metadataRecord(message?.metadata);
      if (!message?.senderBotId || message.channel.archivedAt || metadata.type !== "bot-template") return unavailable("Shared template not found");
      if (input.action === "import") {
        if (metadata.cardState !== "published") return unavailable("Publish this template before importing");
        return message;
      }
      if (metadata.cardState !== "published") return message;
      const updated = await tx.channelMessage.update({ where: { id: messageId }, data: { metadata: toJson({
        ...metadata, cardState: "unpublished", shareUrl: null,
        outcomeId: crypto.randomUUID(), outcomeText: "The template was unpublished. Its public link no longer serves the recipe.", outcomeEchoed: false,
      }) } });
      await appendEvent(tx, "channel.message.updated", messageId, { channelId: message.channelId, messageId });
      await this.wake(tx, message.senderBotId, message.channelId, messageId);
      return updated;
    });
    if (input.action === "import") {
      if (!this.bots || typeof input.clientId !== "string" || input.clientId.length < 8 || input.clientId.length > 120) return unavailable("An import request ID is required");
      const recipe = parseBotRecipe(metadataRecord(metadataRecord(message.metadata).template).recipe);
      const bot = await Effect.runPromise(this.bots.create({
        clientRequestId: `template:${messageId}:${input.clientId}`, name: recipe.profile.name,
        description: recipe.profile.description, instructions: recipe.profile.description,
      }, recipe));
      return { accepted: true, message: toChannelMessageView(message), runId: null, botId: bot.id };
    }
    return { accepted: true, message: toChannelMessageView(message), runId: null };
  });
  async recipe(messageId: string, publicOnly = false): Promise<BotRecipe> {
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId } });
    const metadata = metadataRecord(message?.metadata),
      template = metadataRecord(metadata.template);
    if (
      metadata.type !== "bot-template" ||
      (publicOnly &&
        (process.env.OPENTEAM_PUBLIC_TEMPLATES !== "true" ||
          process.env.OPENTEAM_TEMPLATE_SHARING === "false")) ||
      (publicOnly &&
        (metadata.cardState !== "published" ||
          metadataRecord(template.recipe).visibility !== "public"))
    )
      throw new ApiError(404, "template_not_found", "Template not found");
    return parseBotRecipe(template.recipe);
  }
  private async wake(
    tx: import("@openteam/db").Prisma.TransactionClient,
    botId: string,
    channelId: string,
    messageId: string
  ) {
    await this.messaging.enqueueWake(tx, {
      botId,
      channelId,
      origin: "user",
      type: "template.updated",
      content: "[SAND_HIDDEN_PROMPT]A shared template changed. Read its outcome context and continue.",
      clientId: `template:${messageId}:${crypto.randomUUID()}`,
      priority: PRIORITY.user,
      wrapUserContent: false,
    });
    await this.messaging.scheduleTranscriptProjection(tx, [botId]);
  }
}
