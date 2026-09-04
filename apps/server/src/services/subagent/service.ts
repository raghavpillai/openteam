import {
  ApiError,
  formatPiModelRef,
  type CheckSubagentInput,
  type ComputerSteerRequest,
  type MessageSubagentInput,
  resolveBotAvatarMark,
  parsePiModelRef,
  type StopSubagentInput,
  type SubagentType,
  type TaskInput,
} from "@openteam/contracts";
import { COMPUTER_API_PATHS } from "@openteam/contracts/service-protocol";
import { Prisma, type PrismaClient } from "@openteam/db";
import type { AgentDataStore, AgentMessaging, ToolContext } from "@openteam/messaging";
import { Effect } from "effect";
import { fromPrisma } from "pg-boss";
import type { RunService } from "../run-service";
import { appendEvent, type ComputerFetch, hashRequest, toJson } from "../service-utils";

const ACTIVE_STATUSES = ["provisioning", "queued", "running"] as const;

export const graphicalSubagentType = (type: SubagentType): boolean =>
  type === "computerUse" || type === "browserUse";

export const subagentTaskContent = (input: TaskInput): string => input.prompt;

export const subagentTaskWake = (input: TaskInput) => ({
  content: subagentTaskContent(input),
  wrapUserContent: false as const,
});

export const subagentSteerPrompt = (message: string): string =>
  [
    "[Steering message from the parent agent that dispatched you]",
    "",
    message,
    "",
    "Take this into account and continue your task from where you are — do not start over.",
  ].join("\n");

export const botSubagentId = (id: string): string =>
  id.startsWith("sand-subagent-") ? id : `sand-subagent-${id}`;

export const openteamSubagentId = (id: string): string => id.replace(/^sand-subagent-/, "");

export const subagentBackgroundResult = (id: string, transcriptPath: string): string =>
  [
    `Subagent is running in the background. If needed, you can monitor its output by tailing the transcript at: ${transcriptPath}. When you end your turn, you will be automatically sent the subagent's final response upon its completion, so do not wait for it - either end your turn or work on something else.`,
    "Do NOT mention the transcript path to the user. Do NOT try to predict the subagent's response before it replies.",
    "",
    `Agent ID: ${botSubagentId(id)} (can be used with the \`resume\` parameter to send a follow-up after it completes)`,
  ].join("\n");

type SubagentDatabase = PrismaClient | Prisma.TransactionClient;

export const assertSubagentCapacity = async (
  parentBotId: string,
  type: SubagentType,
  database: SubagentDatabase
): Promise<void> => {
  if (type !== "computerUse") return;
  const activeComputerUse = await database.subagent.count({
    where: {
      parentBotId,
      subagentType: "computerUse",
      status: { in: [...ACTIVE_STATUSES] },
    },
  });
  if (activeComputerUse > 0) {
    throw new ApiError(
      409,
      "subagent_computer_in_use",
      "A computerUse subagent is already using the box's desktop. Only one can run at a time — wait for it to finish (you're notified automatically), then dispatch another."
    );
  }
};

export class SubagentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly runs: RunService,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch,
    private readonly agentData: AgentDataStore
  ) {}

  async task(context: ToolContext, input: TaskInput) {
    const configuredModel = await this.agentData.loadInferenceSettings();
    const model = formatPiModelRef(configuredModel);
    if (
      input.model &&
      formatPiModelRef(parsePiModelRef(input.model, configuredModel.providerId)) !== model
    ) {
      throw new ApiError(
        400,
        "subagent_model_unavailable",
        `This OpenTeam runtime currently offers ${model} to subagents`
      );
    }
    const nested = await this.prisma.subagent.findUnique({ where: { childBotId: context.botId } });
    if (nested) {
      throw new ApiError(403, "nested_subagent_forbidden", "Subagents cannot launch subagents");
    }
    const scope = `subagent-task:${context.botId}`;
    const requestHash = hashRequest(input);
    let receipt = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope, key: context.callId } },
    });
    if (receipt && receipt.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "This Task call id was reused");
    }
    const replayId = this.receiptSubagentId(receipt?.response);
    let attempt = receipt ? await this.attemptForCall(context.botId, context.callId) : null;
    let subagent = attempt
      ? await this.owned(context.botId, attempt.subagentId)
      : replayId
        ? await this.owned(context.botId, replayId)
        : null;
    if (!subagent && receipt) {
      throw new ApiError(409, "request_in_progress", "This Task call is already being accepted");
    }
    if (!receipt) {
      try {
        receipt = await this.prisma.idempotencyRecord.create({
          data: {
            scope,
            key: context.callId,
            requestHash,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        throw new ApiError(409, "request_in_progress", "This Task call is already being accepted");
      }
    }
    if (!subagent) {
      try {
        const accepted = input.resume
          ? await this.resume(context, input)
          : await this.launch(context, input);
        subagent = accepted.subagent;
        attempt = accepted.attempt;
        await this.prisma.idempotencyRecord.update({
          where: { scope_key: { scope, key: context.callId } },
          data: {
            status: "completed",
            response: toJson({ subagentId: subagent.id, attemptId: accepted.attempt.id }),
          },
        });
      } catch (error) {
        await this.prisma.idempotencyRecord.deleteMany({
          where: { scope, key: context.callId, status: "processing" },
        });
        throw error;
      }
    }
    attempt ??= await this.attemptForCall(context.botId, context.callId);
    if (!attempt) {
      throw new ApiError(409, "subagent_attempt_missing", "This Task attempt is unavailable");
    }
    return this.taskResult(subagent, attempt);
  }

  private receiptSubagentId(response: Prisma.JsonValue | null | undefined): string | null {
    return response &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      typeof (response as Record<string, unknown>).subagentId === "string"
      ? ((response as Record<string, unknown>).subagentId as string)
      : null;
  }

  async check(parentBotId: string, input: CheckSubagentInput) {
    if (!input.subagent_id) {
      const running = await this.prisma.subagent.findMany({
        where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: "asc" },
      });
      if (running.length === 0) return "No background subagents are running right now.";
      return { subagents: await Promise.all(running.map((subagent) => this.inspect(subagent))) };
    }
    const subagent = await this.activeOwned(parentBotId, input.subagent_id).catch((error) => {
      if (error instanceof ApiError) return error.message;
      throw error;
    });
    if (typeof subagent === "string") return subagent;
    return this.inspect(subagent);
  }

  async message(parentBotId: string, callId: string, input: MessageSubagentInput) {
    const subagent = await this.activeOwned(parentBotId, input.subagent_id);
    const currentRunId = subagent.currentRunId;
    if (subagent.status !== "running" || !currentRunId) {
      throw new ApiError(409, "subagent_not_running", "The subagent is not currently running");
    }
    const dispatch = await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: currentRunId },
        include: { conversation: true },
      });
      if (!run || !["running", "waiting_approval"].includes(run.status)) {
        throw new ApiError(409, "subagent_not_running", "The subagent is not currently running");
      }
      const clientMessageId = `subagent-steer:${callId}`;
      const content = subagentSteerPrompt(input.message);
      const duplicate = await tx.inboxEvent.findUnique({
        where: { idempotencyKey: clientMessageId },
      });
      if (duplicate) {
        if (duplicate.status === "failed") {
          await tx.inboxEvent.update({
            where: { id: duplicate.id },
            data: {
              status: "processing",
              attempts: { increment: 1 },
              claimedAt: new Date(),
              completedAt: null,
              error: Prisma.DbNull,
            },
          });
          return {
            runId: run.id,
            inboxId: duplicate.id,
            clientMessageId,
            content,
            duplicate: false,
          };
        }
        return { runId: run.id, inboxId: duplicate.id, clientMessageId, content, duplicate: true };
      }
      const message = await tx.message.create({
        data: {
          botId: subagent.childBotId,
          conversationId: run.conversationId,
          runId: run.id,
          clientId: clientMessageId,
          role: "user",
          content,
          status: "completed",
        },
      });
      const inbox = await tx.inboxEvent.create({
        data: {
          botId: subagent.childBotId,
          conversationId: run.conversationId,
          runId: run.id,
          idempotencyKey: clientMessageId,
          type: "subagent.steer",
          deliveryMode: "steer",
          status: "processing",
          attempts: 1,
          claimedAt: new Date(),
          priority: 400,
          payload: {
            messageId: message.id,
            content,
            clientId: clientMessageId,
            channelId: run.channelId,
            origin: "agent",
            deliveryMode: "steer",
          },
        },
      });
      await appendEvent(tx, "subagent.message_accepted", subagent.id, {
        parentBotId,
        subagentId: subagent.id,
        runId: run.id,
        inboxId: inbox.id,
        callId,
      });
      return { runId: run.id, inboxId: inbox.id, clientMessageId, content, duplicate: false };
    });
    if (!dispatch.duplicate) {
      const input = {
        inboxId: dispatch.inboxId,
        clientMessageId: dispatch.clientMessageId,
        content: dispatch.content,
      } satisfies ComputerSteerRequest;
      const response = await this.computerFetch(COMPUTER_API_PATHS.turnSteer(dispatch.runId), {
        method: "POST",
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await this.prisma.inboxEvent.update({
          where: { id: dispatch.inboxId },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: { code: "steer_rejected", status: response.status },
          },
        });
        throw new ApiError(409, "subagent_steer_rejected", await response.text());
      }
    }
    return { delivered: true, subagent_id: botSubagentId(subagent.id), run_id: dispatch.runId };
  }

  async stop(parentBotId: string, callId: string, input: StopSubagentInput) {
    const subagent = await this.activeOwned(parentBotId, input.subagent_id);
    await this.prisma.$transaction(async (tx) => {
      const stoppedAt = new Date();
      await tx.subagent.update({
        where: { id: subagent.id },
        data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
      });
      if (subagent.currentRunId) {
        await tx.subagentAttempt.updateMany({
          where: {
            subagentId: subagent.id,
            childRunId: subagent.currentRunId,
            status: { in: ["provisioning", "queued", "running"] },
          },
          data: { status: "stopped", stoppedAt, completedAt: stoppedAt },
        });
      }
      await appendEvent(tx, "subagent.stopped", subagent.id, {
        parentBotId,
        subagentId: subagent.id,
        runId: subagent.currentRunId,
        callId,
      });
    });
    if (subagent.currentRunId) {
      try {
        await Effect.runPromise(this.runs.cancel(subagent.currentRunId));
      } catch {
        // The durable stopped state wins if the turn ended while cancellation was dispatched.
      }
    }
    return { stopped: true, subagent_id: botSubagentId(subagent.id), status: "stopped" };
  }

  private async launch(context: ToolContext, input: TaskInput, restoredId?: string) {
    const configuredInference = await this.agentData.loadInferenceSettings();
    const selectedModel = formatPiModelRef(
      input.model
        ? parsePiModelRef(input.model, configuredInference.providerId)
        : configuredInference
    );
    const type = input.subagent_type ?? "executor";
    const parent = await this.prisma.bot.findUnique({ where: { id: context.botId } });
    if (!parent || parent.status !== "active") {
      throw new ApiError(409, "parent_not_active", "The parent agent is not active");
    }
    const subagentId =
      restoredId && /^[0-9a-f-]{36}$/i.test(restoredId) ? restoredId : crypto.randomUUID();
    const childBotId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const name = input.description.trim() || "Background task";
    const directory = this.workspaceRoot;
    const outputPath = `/home/box/agent-data/agent-transcripts/${childBotId}/${childBotId}.jsonl`;
    const avatar = resolveBotAvatarMark({ agentId: childBotId });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openteam-subagent-capacity'))`;
      await assertSubagentCapacity(context.botId, type, tx);
      await tx.bot.create({
        data: {
          id: childBotId,
          name,
          title: `Subagent (${type})`,
          description: `Background subagent owned by ${parent.name}`,
          instructions: this.childInstructions(),
          icon: avatar.shape,
          color: avatar.color,
          notificationsEnabled: false,
          hiddenFromSidebar: true,
          defaultDirectory: directory,
          status: "provisioning",
          onboardingStatus: "skipped_by_user",
          onboardingCompletedAt: new Date(),
          conversation: { create: { id: conversationId } },
        },
      });
      await tx.channel.create({
        data: {
          id: channelId,
          kind: "bot_dm",
          name,
          directKey: `bot:${childBotId}`,
          members: { create: { botId: childBotId, ordinal: 0 } },
        },
      });
      const created = await tx.subagent.create({
        data: {
          id: subagentId,
          parentBotId: context.botId,
          childBotId,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          launchCallId: context.callId,
          description: name,
          prompt: input.prompt,
          subagentType: type,
          model: selectedModel,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: true,
          outputPath,
        },
      });
      const wake = await this.messaging.enqueueWake(tx, {
        botId: childBotId,
        channelId,
        origin: "agent",
        type: "subagent.task",
        ...subagentTaskWake(input),
        clientId: `subagent:${subagentId}:initial`,
        priority: 350,
      });
      const updated = await tx.subagent.update({
        where: { id: created.id },
        data: { currentRunId: wake.run.id },
      });
      const attempt = await tx.subagentAttempt.create({
        data: {
          subagentId,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          parentToolCallId: context.callId,
          childRunId: wake.run.id,
          description: name,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: true,
          status: "provisioning",
        },
      });
      await appendEvent(tx, "subagent.created", subagentId, {
        parentBotId: context.botId,
        parentRunId: context.runId,
        childBotId,
        runId: wake.run.id,
        type,
      });
      await this.messaging.boss.send(
        "bot-provision",
        { botId: childBotId },
        {
          db: fromPrisma(tx),
          retryLimit: 8,
          retryDelay: 2,
          retryBackoff: true,
          expireInSeconds: 3 * 60,
        }
      );
      return { subagent: updated, attempt };
    });
  }

  private async resume(context: ToolContext, input: TaskInput) {
    if (input.model) {
      throw new ApiError(400, "resume_model_forbidden", "Do not provide model when resuming");
    }
    if (!input.resume) throw new ApiError(400, "resume_id_required", "resume is required");
    const restoredId = openteamSubagentId(input.resume);
    const subagent = await this.prisma.subagent.findFirst({
      where: { id: restoredId, parentBotId: context.botId },
    });
    if (!subagent) {
      return this.launch(context, { ...input, resume: undefined }, restoredId);
    }
    if (["provisioning", "queued", "running"].includes(subagent.status)) {
      throw new ApiError(
        409,
        "subagent_not_resumable",
        "That background subagent is still running, so it can't be resumed yet — you're notified automatically when it finishes. To act on it while it runs, use MessageSubagent to send it an instruction or StopSubagent to abort it (CheckSubagent shows how it's doing)."
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('openteam-subagent-capacity'))`;
      await assertSubagentCapacity(context.botId, subagent.subagentType as SubagentType, tx);
      const child = await tx.bot.findUnique({
        where: { id: subagent.childBotId },
        include: {
          conversation: true,
          channelMemberships: { where: { channel: { kind: "bot_dm" } } },
        },
      });
      const channelId = child?.channelMemberships[0]?.channelId;
      if (!child?.conversation || child.status !== "active" || !channelId) {
        throw new ApiError(
          409,
          "subagent_unavailable",
          "The prior subagent runtime is unavailable"
        );
      }
      const wake = await this.messaging.enqueueWake(tx, {
        botId: child.id,
        channelId,
        origin: "agent",
        type: "subagent.resume",
        ...subagentTaskWake(input),
        clientId: `subagent:${subagent.id}:resume:${context.callId}`,
        priority: 350,
      });
      const description = input.description.trim() || subagent.description;
      const attempt = await tx.subagentAttempt.create({
        data: {
          subagentId: subagent.id,
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          parentToolCallId: context.callId,
          childRunId: wake.run.id,
          description,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: true,
          status: "queued",
        },
      });
      const updated = await tx.subagent.update({
        where: { id: subagent.id },
        data: {
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          launchCallId: context.callId,
          currentRunId: wake.run.id,
          description,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: true,
          status: "queued",
          result: null,
          error: Prisma.DbNull,
          startedAt: null,
          completedAt: null,
          stoppedAt: null,
        },
      });
      await appendEvent(tx, "subagent.resumed", subagent.id, {
        parentBotId: context.botId,
        parentRunId: context.runId,
        runId: wake.run.id,
      });
      return { subagent: updated, attempt };
    });
  }

  private childInstructions(): string {
    return [
      "You are running as a subagent under a parent agent.",
      "Do not spawn additional subagents unless requested by the user or by your instructions.",
      "Do not create Canvas files unless requested by the user or by your instructions.",
    ].join("\n");
  }

  private async owned(parentBotId: string, id: string) {
    const subagent = await this.prisma.subagent.findFirst({
      where: { id: openteamSubagentId(id), parentBotId },
    });
    if (!subagent) throw new ApiError(404, "subagent_not_found", "Subagent not found");
    return subagent;
  }

  private async activeOwned(parentBotId: string, id: string) {
    const subagent = await this.prisma.subagent.findFirst({
      where: {
        id: openteamSubagentId(id),
        parentBotId,
        status: { in: [...ACTIVE_STATUSES] },
      },
    });
    if (!subagent) {
      throw new ApiError(
        404,
        "subagent_not_running",
        await this.noRunningSubagentMessage(parentBotId, id)
      );
    }
    return subagent;
  }

  private async noRunningSubagentMessage(parentBotId: string, id: string): Promise<string> {
    const running = await this.prisma.subagent.findMany({
      where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const suffix = running.length
      ? ` Currently running: ${running.map(({ id: candidate }) => botSubagentId(candidate)).join(", ")}.`
      : " No subagents are running right now.";
    return `No subagent "${botSubagentId(openteamSubagentId(id))}" is currently running. It may have already finished (you're revived automatically with a finished subagent's result), or the id is wrong.${suffix}`;
  }

  private attemptForCall(parentBotId: string, parentToolCallId: string) {
    return this.prisma.subagentAttempt.findFirst({
      where: { parentToolCallId, subagent: { parentBotId } },
    });
  }

  private async inspect(subagent: Awaited<ReturnType<SubagentService["owned"]>>) {
    const recentToolCalls = subagent.currentRunId
      ? await this.prisma.runItem.findMany({
          where: {
            runId: subagent.currentRunId,
            kind: { in: ["command", "file_change", "tool"] },
          },
          orderBy: { createdAt: "desc" },
          take: 8,
        })
      : [];
    const end = subagent.completedAt ?? subagent.stoppedAt ?? new Date();
    return {
      subagent_id: botSubagentId(subagent.id),
      description: subagent.description,
      subagent_type: subagent.subagentType,
      status: subagent.status,
      elapsed_seconds: Math.max(
        0,
        Math.round((end.getTime() - (subagent.startedAt ?? subagent.createdAt).getTime()) / 1_000)
      ),
      recent_tool_calls: recentToolCalls.map((item) => ({
        tool: item.title ?? item.kind,
        status: item.status,
        at: item.createdAt.toISOString(),
      })),
      transcript_path: subagent.outputPath,
      result: subagent.result,
      error: subagent.error,
    };
  }

  private taskResult(
    subagent: Awaited<ReturnType<SubagentService["owned"]>>,
    _attempt: NonNullable<Awaited<ReturnType<SubagentService["attemptForCall"]>>>
  ) {
    return subagentBackgroundResult(subagent.id, subagent.outputPath);
  }
}
