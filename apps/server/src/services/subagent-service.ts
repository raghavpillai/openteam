import { resolve, sep } from "node:path";
import {
  ApiError,
  type CheckSubagentInput,
  type MessageSubagentInput,
  type StopSubagentInput,
  type TaskInput,
} from "@openbot/contracts";
import { Prisma, type PrismaClient } from "@openbot/db";
import type { AgentMessaging, ToolContext } from "@openbot/messaging";
import { Effect } from "effect";
import { fromPrisma } from "pg-boss";
import type { RunService } from "./run-service";
import {
  appendEvent,
  botColor,
  type ComputerFetch,
  hashRequest,
  slugify,
  toJson,
} from "./service-utils";

const ACTIVE_STATUSES = ["provisioning", "queued", "running"] as const;

export class SubagentService {
  private readonly perParentLimit = Number(process.env.OPENBOT_SUBAGENT_PER_PARENT_LIMIT ?? 4);
  private readonly globalLimit = Number(process.env.OPENBOT_SUBAGENT_GLOBAL_LIMIT ?? 8);
  private readonly model = process.env.OPENBOT_PI_MODEL ?? "gpt-5.5";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly runs: RunService,
    private readonly workspaceRoot: string,
    private readonly computerFetch: ComputerFetch
  ) {}

  async task(context: ToolContext, input: TaskInput) {
    if (input.model && input.model !== this.model) {
      throw new ApiError(
        400,
        "subagent_model_unavailable",
        `This OpenBot runtime currently offers ${this.model} to subagents`
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
    let subagent = replayId ? await this.owned(context.botId, replayId) : null;
    if (!subagent && receipt) {
      subagent = await this.prisma.subagent.findUnique({
        where: {
          parentBotId_launchCallId: { parentBotId: context.botId, launchCallId: context.callId },
        },
      });
    }
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
        subagent = input.resume
          ? await this.resume(context, input)
          : await this.launch(context, input);
        await this.prisma.idempotencyRecord.update({
          where: { scope_key: { scope, key: context.callId } },
          data: { status: "completed", response: toJson({ subagentId: subagent.id }) },
        });
      } catch (error) {
        await this.prisma.idempotencyRecord.deleteMany({
          where: { scope, key: context.callId, status: "processing" },
        });
        throw error;
      }
    }
    if (input.run_in_background === false) {
      return this.waitForCompletion(context.botId, subagent.id);
    }
    return this.taskResult(subagent);
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
      return { subagents: await Promise.all(running.map((subagent) => this.inspect(subagent))) };
    }
    const subagent = await this.owned(parentBotId, input.subagent_id);
    return this.inspect(subagent);
  }

  async message(parentBotId: string, callId: string, input: MessageSubagentInput) {
    const subagent = await this.owned(parentBotId, input.subagent_id);
    if (subagent.status !== "running" || !subagent.currentRunId) {
      throw new ApiError(409, "subagent_not_running", "The subagent is not currently running");
    }
    const dispatch = await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: subagent.currentRunId! },
        include: { conversation: true },
      });
      if (!run || !["running", "waiting_approval"].includes(run.status)) {
        throw new ApiError(409, "subagent_not_running", "The subagent is not currently running");
      }
      const clientMessageId = `subagent-steer:${callId}`;
      const content = `[Instruction from parent agent]\n${input.message}`;
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
      const response = await this.computerFetch(`/v1/turns/${dispatch.runId}/steer`, {
        method: "POST",
        body: JSON.stringify({
          inboxId: dispatch.inboxId,
          clientMessageId: dispatch.clientMessageId,
          content: dispatch.content,
        }),
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
    return { delivered: true, subagent_id: subagent.id, run_id: dispatch.runId };
  }

  async stop(parentBotId: string, callId: string, input: StopSubagentInput) {
    const subagent = await this.owned(parentBotId, input.subagent_id);
    if (["completed", "failed", "stopped"].includes(subagent.status)) {
      return {
        stopped: subagent.status === "stopped",
        subagent_id: subagent.id,
        status: subagent.status,
      };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subagent.update({
        where: { id: subagent.id },
        data: { status: "stopped", stoppedAt: new Date(), completedAt: new Date() },
      });
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
    return { stopped: true, subagent_id: subagent.id, status: "stopped" };
  }

  private async launch(context: ToolContext, input: TaskInput) {
    await this.assertCapacity(context.botId);
    const parent = await this.prisma.bot.findUnique({ where: { id: context.botId } });
    if (!parent || parent.status !== "active") {
      throw new ApiError(409, "parent_not_active", "The parent agent is not active");
    }
    const subagentId = crypto.randomUUID();
    const childBotId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const type = input.subagent_type ?? "executor";
    const name = input.description.trim() || "Background task";
    const directory = resolve(
      this.workspaceRoot,
      "bots",
      `${slugify(`subagent-${name}`)}-${childBotId.slice(0, 8)}`
    );
    if (!directory.startsWith(`${this.workspaceRoot}${sep}`)) {
      throw new ApiError(400, "invalid_workspace", "Generated workspace path escaped root");
    }
    const outputPath = `/home/openbot/agent-data/agent-transcripts/${childBotId}/${childBotId}.jsonl`;
    const prompt = this.runtimePrompt(parent.name, type, input);
    return this.prisma.$transaction(async (tx) => {
      await tx.bot.create({
        data: {
          id: childBotId,
          name,
          title: `Subagent (${type})`,
          description: `Background subagent owned by ${parent.name}`,
          instructions: this.childInstructions(context.botId, subagentId, type),
          icon: "◌",
          color: botColor(childBotId),
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
          model: input.model ?? this.model,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: input.run_in_background !== false,
          outputPath,
        },
      });
      const wake = await this.messaging.enqueueWake(tx, {
        botId: childBotId,
        channelId,
        origin: "agent",
        type: "subagent.task",
        content: prompt,
        clientId: `subagent:${subagentId}:initial`,
        priority: 350,
      });
      const updated = await tx.subagent.update({
        where: { id: created.id },
        data: { currentRunId: wake.run.id },
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
      return updated;
    });
  }

  private async resume(context: ToolContext, input: TaskInput) {
    const subagent = await this.owned(context.botId, input.resume!);
    if (!["completed", "failed"].includes(subagent.status)) {
      throw new ApiError(409, "subagent_not_resumable", "Only a finished subagent can be resumed");
    }
    if (input.model) {
      throw new ApiError(400, "resume_model_forbidden", "Do not provide model when resuming");
    }
    await this.assertCapacity(context.botId);
    return this.prisma.$transaction(async (tx) => {
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
        content: this.runtimePrompt("parent agent", subagent.subagentType, input),
        clientId: `subagent:${subagent.id}:resume:${context.callId}`,
        priority: 350,
      });
      const updated = await tx.subagent.update({
        where: { id: subagent.id },
        data: {
          parentRunId: context.runId,
          parentChannelId: context.channelId,
          launchCallId: context.callId,
          currentRunId: wake.run.id,
          description: input.description.trim() || subagent.description,
          prompt: input.prompt,
          fileAttachments: (input.file_attachments ?? []) as Prisma.InputJsonValue,
          runInBackground: input.run_in_background !== false,
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
      return updated;
    });
  }

  private runtimePrompt(parentName: string, type: string, input: TaskInput): string {
    const attachments = input.file_attachments?.length
      ? `\n\nAttached file paths available on the shared computer:\n${input.file_attachments.map((path) => `- ${path}`).join("\n")}`
      : "";
    return [
      `[Background task from ${parentName}]`,
      `Specialization: ${type}`,
      input.prompt,
      attachments,
      "Return one self-contained final report. Your plain final assistant message is delivered privately to your parent; do not contact the user or other agents.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private childInstructions(parentBotId: string, subagentId: string, type: string): string {
    const specialization =
      type === "computerUse"
        ? "Drive the graphical desktop with Screenshot and the dynamically discovered Computer tool."
        : type === "browserUse"
          ? "Use Screenshot and the dynamically discovered Computer tool to work through Chromium on your graphical desktop."
          : type === "videoReview" || type === "watchVideo"
            ? "Review the attached media frames directly. The original video path is also available if shell-based inspection is useful."
            : "Use Shell, Read, and the other native tools for general execution.";
    return [
      `You are a ${type} background subagent with Agent ID ${subagentId}.`,
      `You are owned by parent agent ${parentBotId}.`,
      specialization,
      "Work autonomously on only the supplied task. You share the same computer and filesystem as the parent.",
      "Your plain final assistant message is your private report to the parent. Do not use SendMessage or SendToAgent.",
      "You cannot launch, inspect, message, or stop other subagents and cannot administer agents or channels.",
    ].join("\n");
  }

  private async assertCapacity(parentBotId: string) {
    const [parentCount, globalCount] = await Promise.all([
      this.prisma.subagent.count({ where: { parentBotId, status: { in: [...ACTIVE_STATUSES] } } }),
      this.prisma.subagent.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
    ]);
    if (parentCount >= this.perParentLimit) {
      throw new ApiError(429, "subagent_parent_pool_full", "This agent's subagent pool is full");
    }
    if (globalCount >= this.globalLimit) {
      throw new ApiError(429, "subagent_pool_full", "The OpenBot subagent pool is full");
    }
  }

  private async owned(parentBotId: string, id: string) {
    const subagent = await this.prisma.subagent.findFirst({ where: { id, parentBotId } });
    if (!subagent) throw new ApiError(404, "subagent_not_found", "Subagent not found");
    return subagent;
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
      subagent_id: subagent.id,
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

  private taskResult(subagent: Awaited<ReturnType<SubagentService["owned"]>>) {
    return {
      agent_id: subagent.id,
      status: subagent.status,
      output_file: subagent.outputPath,
      run_id: subagent.currentRunId,
      background: subagent.runInBackground,
      result: subagent.result,
    };
  }

  private async waitForCompletion(parentBotId: string, subagentId: string) {
    const deadline = Date.now() + 24 * 60 * 60_000;
    while (Date.now() < deadline) {
      const current = await this.owned(parentBotId, subagentId);
      if (["completed", "failed", "stopped"].includes(current.status)) {
        return this.taskResult(current);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ApiError(504, "subagent_timeout", "Subagent did not finish within 24 hours");
  }
}
