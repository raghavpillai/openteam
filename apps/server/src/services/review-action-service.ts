import { pluginCatalog } from "../plugins/catalog";
import { parseOpenTeamMarketplace } from "../plugins/openteam-marketplace";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ApiError, parseBotRecipe, type BotRecipe } from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { type AgentMessaging, type ToolContext, PRIORITY } from "@openteam/messaging";
import { Effect } from "effect";
import type { BotService } from "./bot-service";
import { appendEvent, metadataRecord, serviceEffect, toJson } from "./service-utils";
import { toChannelMessageView } from "./view-mappers";
const unavailable = (message: string): never => {
  throw new ApiError(409, "review_unavailable", message);
};
export class ReviewActionService {
  private readonly feedbackWaiters = new Set<string>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly bots?: BotService
  ) {}
  async stage(context: ToolContext, tool: "SendFeedback" | "create_bot_share_json", raw: unknown) {
    if (tool === "SendFeedback") {
      if (
        process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT !== "true" ||
        !process.env.OPENTEAM_FEEDBACK_URL
      )
        return unavailable(
          "Agent feedback is disabled by the deployment privacy settings or has no configured support destination. Nothing was sent."
        );
      const input = metadataRecord(raw);
      if (
        typeof input.message !== "string" ||
        !input.message.trim() ||
        input.message.length > 4000 ||
        typeof input.wantsResponse !== "boolean"
      )
        return unavailable("Provide the user’s feedback and explicit wantsResponse preference");
      if (input.wantsResponse && !process.env.OPENTEAM_FEEDBACK_CONTACT)
        return unavailable(
          "A support reply address must be configured in the deployment before requesting a reply"
        );
      const destination = new URL(process.env.OPENTEAM_FEEDBACK_URL);
      if (
        destination.protocol !== "https:" &&
        destination.hostname !== "127.0.0.1" &&
        destination.hostname !== "localhost"
      )
        return unavailable("The feedback endpoint must use HTTPS");
      const result = await this.messaging.sendVisible(context, {
        type: "review-action",
        review: {
          kind: "feedback",
          message: input.message.trim(),
          wantsResponse: input.wantsResponse,
          destination: destination.origin,
          endpointHash: createHash("sha256").update(destination.href).digest("hex"),
        },
        content: "Review product feedback",
        end_turn: false,
      });
      return result.acknowledgement;
    }
    if (process.env.OPENTEAM_TEMPLATE_SHARING === "false")
      return unavailable("Template sharing is disabled on this deployment");
    const channel =
      context.channelId &&
      (await this.prisma.channel.findUnique({ where: { id: context.channelId } }));
    if (!channel || channel.kind !== "bot_dm")
      return unavailable("Stage a template from the bot’s direct chat");
    const recipe = parseBotRecipe(raw);
    if (recipe.visibility === "public" && process.env.OPENTEAM_PUBLIC_TEMPLATES !== "true")
      return unavailable("Public templates are disabled. Choose team visibility");
    const installations = await this.prisma.pluginInstallation.findMany({
      where: {
        status: "installed",
        enablements: { some: { botId: context.botId, enabled: true } },
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
          return unavailable("This call ID already staged different content");
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
      type: "review-action",
      review: { kind: "template", recipe, version, digest },
      content: `Review ${recipe.profile.name} · version ${version}`,
      end_turn: false,
    });
    return {
      ...metadataRecord(result.acknowledgement),
      staged: true,
      published: false,
      version,
      digest,
    };
  }
  async sendFeedback(context: ToolContext, raw: unknown, signal?: AbortSignal) {
    const ack = metadataRecord(await this.stage(context, "SendFeedback", raw));
    const messageId = String(ack.message_id);
    this.feedbackWaiters.add(messageId);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const result = await this.prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
          const message = await tx.channelMessage.findUniqueOrThrow({where:{id:messageId}});
          const metadata = metadataRecord(message.metadata);
          if (!metadata.cardState || ["pending","sending"].includes(String(metadata.cardState))) return null;
          await tx.channelMessage.update({where:{id:messageId},data:{metadata:toJson({...metadata,outcomeEchoed:true})}});
          return {feedbackStatus:metadata.cardState, wantsResponse:metadataRecord(metadata.review).wantsResponse, outcome:metadata.outcomeText};
        });
        if (result) return result;
        await delay(250, undefined, {signal});
      }
    } finally {
      this.feedbackWaiters.delete(messageId);
      // If the invocation was cancelled after settlement, preserve the durable wake.
      if (signal?.aborted) await this.prisma.$transaction(async tx => {
        const message = await tx.channelMessage.findUnique({where:{id:messageId}});
        const metadata = metadataRecord(message?.metadata);
        if (message && metadata.outcomeId && !metadata.outcomeEchoed) await this.wake(tx,context.botId,message.channelId,messageId);
      });
    }
  }
  mutate = (messageId: string, raw: unknown) =>
    serviceEffect(async () => {
      const input = metadataRecord(raw);
      if (!["approve", "cancel", "refresh", "import", "unpublish"].includes(String(input.action)))
        return unavailable("Choose approve, cancel, refresh, import or unpublish");
      const owner = await this.prisma.channelMessage.findUnique({
        where: { id: messageId },
        select: { senderBotId: true },
      });
      const claim = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`template-publish:${owner?.senderBotId ?? messageId}`}))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
        const message = await tx.channelMessage.findUnique({
          where: { id: messageId },
          include: { channel: true },
        });
        const metadata = metadataRecord(message?.metadata),
          review = metadataRecord(metadata.review);
        if (
          !message?.senderBotId ||
          message.channel.archivedAt ||
          metadata.type !== "review-action"
        )
          return unavailable("Review card not found");
        if (input.action === "unpublish" && review.kind !== "template")
          return unavailable("Only templates can be unpublished");
        if (
          input.action === "import" ||
          input.action === "refresh" ||
          (metadata.cardState &&
            metadata.cardState !== "pending" &&
            !(
              review.kind === "template" &&
              ((input.action === "unpublish" && metadata.cardState === "published") ||
                (input.action === "approve" && metadata.cardState === "unpublished"))
            ))
        )
          return { message, claimed: false };
        const failFeedback = async (text: string) => {
          const updated = await tx.channelMessage.update({where:{id:messageId},data:{metadata:toJson({...metadata,cardState:"failed",outcomeId:crypto.randomUUID(),outcomeText:text,outcomeEchoed:false})}});
          await appendEvent(tx,"channel.message.updated",messageId,{channelId:message.channelId,messageId});
          await this.wake(tx,message.senderBotId!,message.channelId,messageId);
          return {message:updated,claimed:false};
        };
        if (input.action === "approve" && review.kind === "feedback") {
          if (
            process.env.OPENTEAM_FEEDBACK_ALLOW_AGENT !== "true" ||
            !process.env.OPENTEAM_FEEDBACK_URL ||
            createHash("sha256")
              .update(new URL(process.env.OPENTEAM_FEEDBACK_URL).href)
              .digest("hex") !== review.endpointHash
          )
            return failFeedback(
              "The feedback destination or privacy settings changed. Nothing was sent; stage a new review"
            );
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('feedback-rate-limit'))`;
          const recent = await tx.channelMessage.findFirst({
            where: {
              metadata: {
                path: ["feedbackClaimedAt"],
                gte: new Date(Date.now() - 300_000).toISOString(),
              },
            },
          });
          if (recent)
            return failFeedback(
              "Feedback is rate limited. Try again after five minutes; nothing was sent"
            );
        }
        if (
          input.action === "approve" &&
          review.kind === "template" &&
          (process.env.OPENTEAM_TEMPLATE_SHARING === "false" ||
            (metadataRecord(review.recipe).visibility === "public" &&
              process.env.OPENTEAM_PUBLIC_TEMPLATES !== "true"))
        )
          return unavailable("Template sharing settings changed. Nothing was published");
        const state =
          input.action === "unpublish"
            ? "unpublished"
            : input.action === "cancel"
              ? "dismissed"
              : review.kind === "template"
                ? "published"
                : "sending";
        if (state === "published") {
          const older = await tx.channelMessage.findMany({
            where: {
              senderBotId: message.senderBotId,
              id: { not: messageId },
              AND: [
                { metadata: { path: ["review", "kind"], equals: "template" } },
                { metadata: { path: ["cardState"], equals: "published" } },
              ],
            },
          });
          for (const prior of older) {
            await tx.channelMessage.update({
              where: { id: prior.id },
              data: {
                metadata: toJson({
                  ...metadataRecord(prior.metadata),
                  cardState: "unpublished",
                  shareUrl: null,
                  outcomeId: crypto.randomUUID(),
                  outcomeText: "A newer template version replaced this publication.",
                  outcomeEchoed: false,
                }),
              },
            });
            await appendEvent(tx, "channel.message.updated", prior.id, {
              channelId: prior.channelId,
              messageId: prior.id,
            });
          }
        }
        const outcome =
          state === "unpublished"
            ? "The template was unpublished. Its public link no longer serves the recipe."
            : state === "published"
              ? `Template version ${String(review.version)} was published with ${String(metadataRecord(review.recipe).visibility)} visibility.`
              : state === "dismissed"
                ? "The user cancelled this review."
                : undefined;
        const updated = await tx.channelMessage.update({
          where: { id: messageId },
          data: {
            metadata: toJson({
              ...metadata,
              cardState: state,
              ...(state === "unpublished" ? { shareUrl: null } : {}),
              ...(state === "sending" ? { feedbackClaimedAt: new Date().toISOString() } : {}),
              ...(state === "published" &&
              metadataRecord(review.recipe).visibility === "public" &&
              process.env.OPENTEAM_PUBLIC_URL
                ? {
                    shareUrl: `${process.env.OPENTEAM_PUBLIC_URL.replace(/\/$/, "")}/api/v0/templates/${messageId}`,
                  }
                : {}),
              ...(outcome
                ? { outcomeId: crypto.randomUUID(), outcomeText: outcome, outcomeEchoed: false }
                : {}),
            }),
          },
        });
        await appendEvent(tx, "channel.message.updated", messageId, {
          channelId: message.channelId,
          messageId,
        });
        if (outcome) await this.wake(tx, message.senderBotId, message.channelId, messageId);
        return { message: updated, claimed: state === "sending" };
      });
      const metadata = metadataRecord(claim.message.metadata),
        review = metadataRecord(metadata.review);
      if (input.action === "import") {
        if (review.kind !== "template" || metadata.cardState !== "published" || !this.bots)
          return unavailable("Publish this template before importing");
        if (
          typeof input.clientId !== "string" ||
          input.clientId.length < 8 ||
          input.clientId.length > 120
        )
          return unavailable("An import request ID is required");
        const recipe = parseBotRecipe(review.recipe);
        const instructions = recipe.profile.description;
        const bot = await Effect.runPromise(
          this.bots.create(
            {
              clientRequestId: `template:${messageId}:${input.clientId}`,
              name: recipe.profile.name,
              description: recipe.profile.description,
              instructions,
            },
            recipe
          )
        );
        return {
          accepted: true,
          message: toChannelMessageView(claim.message),
          runId: null,
          botId: bot.id,
        };
      }
      if (!claim.claimed) {
        if (
          metadata.cardState === "sending" &&
          Date.now() - Date.parse(String(metadata.feedbackClaimedAt)) > 120_000
        )
          return this.settle(
            messageId,
            "unknown",
            "Feedback delivery was interrupted. It will not be retried automatically."
          );
        return { accepted: false, message: toChannelMessageView(claim.message), runId: null };
      }
      try {
        const response = await fetch(process.env.OPENTEAM_FEEDBACK_URL!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `feedback:${messageId}`,
            ...(process.env.OPENTEAM_FEEDBACK_TOKEN
              ? { authorization: `Bearer ${process.env.OPENTEAM_FEEDBACK_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({
            id: messageId,
            product: "OpenTeam",
            message: review.message,
            wantsResponse: review.wantsResponse,
            ...(review.wantsResponse ? { replyTo: process.env.OPENTEAM_FEEDBACK_CONTACT } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok)
          return this.settle(
            messageId,
            response.status === 429 ? "failed" : "unknown",
            response.status === 429
              ? "Support rate limited this feedback. Nothing will be retried automatically."
              : "Support did not confirm receipt. Check with support before retrying."
          );
        return this.settle(
          messageId,
          "sent",
          "The configured OpenTeam support destination accepted the feedback."
        );
      } catch {
        return this.settle(
          messageId,
          "unknown",
          "Feedback delivery was not confirmed. It will not be retried automatically."
        );
      }
    });
  async recipe(messageId: string, publicOnly = false): Promise<BotRecipe> {
    const message = await this.prisma.channelMessage.findUnique({ where: { id: messageId } });
    const metadata = metadataRecord(message?.metadata),
      review = metadataRecord(metadata.review);
    if (
      review.kind !== "template" ||
      (publicOnly &&
        (process.env.OPENTEAM_PUBLIC_TEMPLATES !== "true" ||
          process.env.OPENTEAM_TEMPLATE_SHARING === "false")) ||
      (publicOnly &&
        (metadata.cardState !== "published" ||
          metadataRecord(review.recipe).visibility !== "public"))
    )
      throw new ApiError(404, "template_not_found", "Template not found");
    return parseBotRecipe(review.recipe);
  }
  private async wake(
    tx: import("@openteam/db").Prisma.TransactionClient,
    botId: string,
    channelId: string,
    messageId: string
  ) {
    if (this.feedbackWaiters.has(messageId)) return;
    await this.messaging.enqueueWake(tx, {
      botId,
      channelId,
      origin: "user",
      type: "review.response",
      content: "[SAND_HIDDEN_PROMPT]A review card settled. Read its outcome context and continue.",
      clientId: `review:${messageId}:${crypto.randomUUID()}`,
      priority: PRIORITY.user,
      wrapUserContent: false,
    });
    await this.messaging.scheduleTranscriptProjection(tx, [botId]);
  }
  private async settle(messageId: string, state: string, text: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rich-message:${messageId}`}))`;
      const message = await tx.channelMessage.findUniqueOrThrow({ where: { id: messageId } });
      const metadata = metadataRecord(message.metadata);
      if (metadata.cardState !== "sending")
        return { accepted: false, message: toChannelMessageView(message), runId: null };
      const updated = await tx.channelMessage.update({
        where: { id: messageId },
        data: {
          metadata: toJson({
            ...metadata,
            cardState: state,
            outcomeId: `${messageId}:${state}`,
            outcomeText: text,
            outcomeEchoed: false,
          }),
        },
      });
      await appendEvent(tx, "channel.message.updated", messageId, {
        channelId: message.channelId,
        messageId,
      });
      await this.wake(tx, message.senderBotId!, message.channelId, messageId);
      return { accepted: true, message: toChannelMessageView(updated), runId: null };
    });
  }
}
