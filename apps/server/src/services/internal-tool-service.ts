import {
  AgentSendMessageInput,
  ApiError,
  CheckSubagentInput,
  CreateAgentInput,
  CreateChannelInput,
  type DynamicToolCallRequest,
  MessageSubagentInput,
  ReactToMessageInput,
  SendToAgentInput,
  StopSubagentInput,
  TaskInput,
  TodoWriteInput,
  UpdateAgentInput,
  UpdateChannelInput,
  UpdateStateInput,
} from "@openbot/contracts";
import type { PrismaClient } from "@openbot/db";
import type { AgentMessaging } from "@openbot/messaging";
import { Effect, Schema } from "effect";
import type { DurableStateService } from "../update-state";
import type { AdministrationService } from "./administration-service";
import { toError } from "./service-utils";
import type { SubagentService } from "./subagent-service";
import type { TodoService } from "./todo-service";

export class InternalToolService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly durableState: DurableStateService,
    private readonly interruptNonUserRun: (runId: string) => Promise<void>,
    private readonly todos: TodoService,
    private readonly subagents: SubagentService,
    private readonly administration: AdministrationService
  ) {}

  execute = (request: DynamicToolCallRequest) =>
    Effect.tryPromise({
      try: async () => {
        const run = await this.prisma.run.findUnique({
          where: { id: request.runId },
          include: {
            inboxEvents: {
              orderBy: { createdAt: "desc" },
              select: { payload: true },
              take: 1,
            },
          },
        });
        if (
          !run ||
          run.botId !== request.botId ||
          run.conversationId !== request.conversationId ||
          run.channelId !== request.channelId ||
          run.deliveryId !== request.deliveryId ||
          !["running", "waiting_approval"].includes(run.status)
        ) {
          throw new ApiError(409, "tool_context_invalid", "Dynamic tool context is not active");
        }
        const inboxPayload = run.inboxEvents[0]?.payload as Record<string, unknown> | undefined;
        const context = {
          runId: request.runId,
          botId: request.botId,
          conversationId: request.conversationId,
          channelId: request.channelId,
          deliveryId: request.deliveryId,
          callId: request.callId,
          timeZone: typeof inboxPayload?.timeZone === "string" ? inboxPayload.timeZone : undefined,
        };
        const childIdentity = await this.prisma.subagent.findUnique({
          where: { childBotId: request.botId },
          select: { id: true },
        });
        const parentOnlyTools = new Set([
          "Task",
          "CheckSubagent",
          "MessageSubagent",
          "StopSubagent",
          "CreateAgent",
          "UpdateAgent",
          "CreateChannel",
          "UpdateChannel",
          "SendToAgent",
        ]);
        if (childIdentity && parentOnlyTools.has(request.tool)) {
          throw new ApiError(403, "subagent_tool_forbidden", "This tool is parent-agent only");
        }
        if (request.tool === "update_state") {
          return this.durableState.execute(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(UpdateStateInput)(request.arguments),
            request.runId
          );
        }
        if (request.tool === "ReactToMessage") {
          return this.messaging.reactToMessage(
            context,
            Schema.decodeUnknownSync(ReactToMessageInput)(request.arguments)
          );
        }
        if (request.tool === "TodoWrite") {
          return this.todos.write(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(TodoWriteInput)(request.arguments)
          );
        }
        if (request.tool === "Task") {
          return this.subagents.task(
            context,
            Schema.decodeUnknownSync(TaskInput)(request.arguments)
          );
        }
        if (request.tool === "CheckSubagent") {
          return this.subagents.check(
            request.botId,
            Schema.decodeUnknownSync(CheckSubagentInput)(request.arguments)
          );
        }
        if (request.tool === "MessageSubagent") {
          return this.subagents.message(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(MessageSubagentInput)(request.arguments)
          );
        }
        if (request.tool === "StopSubagent") {
          return this.subagents.stop(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(StopSubagentInput)(request.arguments)
          );
        }
        if (request.tool === "CreateAgent") {
          return this.administration.createAgent(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(CreateAgentInput)(request.arguments)
          );
        }
        if (request.tool === "UpdateAgent") {
          return this.administration.updateAgent(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(UpdateAgentInput)(request.arguments)
          );
        }
        if (request.tool === "CreateChannel") {
          return this.administration.createChannel(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(CreateChannelInput)(request.arguments)
          );
        }
        if (request.tool === "UpdateChannel") {
          return this.administration.updateChannel(
            request.botId,
            request.callId,
            Schema.decodeUnknownSync(UpdateChannelInput)(request.arguments)
          );
        }
        const result =
          request.tool === "SendToAgent"
            ? await this.messaging.sendToAgent(
                context,
                Schema.decodeUnknownSync(SendToAgentInput)(request.arguments)
              )
            : request.tool === "SendMessage"
              ? await this.messaging.sendVisible(
                  context,
                  Schema.decodeUnknownSync(AgentSendMessageInput)(request.arguments)
                )
              : (() => {
                  throw new ApiError(400, "unknown_dynamic_tool", `Unknown tool ${request.tool}`);
                })();
        if (result.interruptRunId) await this.interruptNonUserRun(result.interruptRunId);
        return result.acknowledgement;
      },
      catch: toError,
    });
}
