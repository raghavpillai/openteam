import {
  AgentSendToUserInput,
  ApiError,
  CheckSubagentInput,
  CreateAgentInput,
  CreateChannelInput,
  type DynamicToolCallRequest,
  ListAgentsInput,
  ListGroupsInput,
  MessageSubagentInput,
  ReactToMessageInput,
  RequestBoxHelpInput,
  SendToAgentInput,
  StopSubagentInput,
  TaskInput,
  TodoWriteInput,
  UpdateAgentInput,
  UpdateChannelInput,
  UpdateStateInput,
} from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { type AgentMessaging, validateSendToUserInput } from "@openteam/messaging";
import { Effect, Schema } from "effect";
import type { DurableStateService } from "../update-state";
import type { AdministrationService } from "./administration-service";
import type { PluginService } from "./plugin-service";
import { toError } from "./service-utils";
import type { SubagentService } from "./subagent/service";
import type { TodoService } from "./todo-service";

export class InternalToolService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly durableState: DurableStateService,
    private readonly interruptNonUserRun: (runId: string) => Promise<void>,
    private readonly todos: TodoService,
    private readonly subagents: SubagentService,
    private readonly administration: AdministrationService,
    private readonly plugins: PluginService
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
          origin: run.origin,
          callId: request.callId,
          timeZone: typeof inboxPayload?.timeZone === "string" ? inboxPayload.timeZone : undefined,
          replyToMessageId:
            typeof inboxPayload?.replyToMessageId === "string"
              ? inboxPayload.replyToMessageId
              : null,
          isFork: inboxPayload?.isFork === true,
        };
        const childIdentity = await this.prisma.subagent.findUnique({
          where: { childBotId: request.botId },
          select: { id: true, parentBotId: true, subagentType: true },
        });
        const parentOnlyTools = new Set([
          "Task",
          "CheckSubagent",
          "MessageSubagent",
          "StopSubagent",
          "CreateAgent",
          "UpdateAgent",
          "ListAgents",
          "ListGroups",
          "CreateChannel",
          "UpdateChannel",
          "SendToAgent",
          "SearchPlugins",
          "GetPlugin",
          "GetMcpServerStatus",
          "InstallPlugin",
          "UninstallPlugin",
          "AddMcpServer",
          "UninstallMcpServer",
          "AuthenticateMcpServer",
          "RestartMcpServers",
          "RenameMcpAccount",
          "RemoveMcpAccount",
          "request_box_help",
          "SetMcpInstructions",
        ]);
        if (childIdentity && parentOnlyTools.has(request.tool)) {
          throw new ApiError(403, "subagent_tool_forbidden", "This tool is parent-agent only");
        }
        if (request.tool === "SearchPlugins") {
          const input =
            request.arguments && typeof request.arguments === "object"
              ? (request.arguments as Record<string, unknown>)
              : {};
          return this.plugins.searchCatalog(typeof input.query === "string" ? input.query : "");
        }
        if (request.tool === "GetPlugin") {
          const input =
            request.arguments && typeof request.arguments === "object"
              ? (request.arguments as Record<string, unknown>)
              : {};
          if (typeof input.pluginKey !== "string") {
            throw new ApiError(400, "plugin_key_required", "pluginKey is required");
          }
          return this.plugins.catalogDetail(input.pluginKey);
        }
        if (request.tool === "GetMcpServerStatus") {
          const input =
            request.arguments && typeof request.arguments === "object"
              ? (request.arguments as Record<string, unknown>)
              : {};
          return this.plugins.connectionStatuses(
            typeof input.connectionId === "string" ? input.connectionId : undefined
          );
        }
        if (
          [
            "InstallPlugin",
            "UninstallPlugin",
            "AddMcpServer",
            "UninstallMcpServer",
            "AuthenticateMcpServer",
            "RestartMcpServers",
            "RenameMcpAccount",
            "RemoveMcpAccount",
            "SetMcpInstructions",
          ].includes(request.tool)
        ) {
          return this.plugins.requestAction({
            runId: request.runId,
            botId: request.botId,
            callId: request.callId,
            action: request.tool,
            arguments: request.arguments,
          });
        }
        if (request.tool === "PluginCall") {
          const input =
            request.arguments && typeof request.arguments === "object"
              ? (request.arguments as Record<string, unknown>)
              : {};
          if (typeof input.connectionId !== "string" || typeof input.toolName !== "string") {
            throw new ApiError(400, "invalid_plugin_call", "Plugin call is missing identifiers");
          }
          return this.plugins.invoke({
            connectionId: input.connectionId,
            botId:
              childIdentity?.subagentType === "executor"
                ? childIdentity.parentBotId
                : request.botId,
            runId: request.runId,
            callId: request.callId,
            toolName: input.toolName,
            arguments: input.arguments ?? {},
          });
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
        if (request.tool === "ListAgents") {
          return this.administration.listAgents(
            request.botId,
            Schema.decodeUnknownSync(ListAgentsInput)(request.arguments)
          );
        }
        if (request.tool === "ListGroups") {
          return this.administration.listGroups(
            request.botId,
            Schema.decodeUnknownSync(ListGroupsInput)(request.arguments)
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
        if (request.tool === "request_box_help") {
          const input = Schema.decodeUnknownSync(RequestBoxHelpInput)(request.arguments);
          const reason = input.reason ?? "Please complete the manual step on the computer.";
          const result = await this.messaging.sendVisible(context, {
            type: "computer-handoff",
            content: reason,
            computerHandoff: { reason },
          });
          return {
            sent: true,
            acknowledgement: result.acknowledgement,
            waiting_for_user: true,
            instruction: "Stop this turn. You will be resumed when the user finishes or skips.",
          };
        }
        let result;
        if (request.tool === "SendToAgent") {
          result = await this.messaging.sendToAgent(
            context,
            Schema.decodeUnknownSync(SendToAgentInput)(request.arguments)
          );
        } else if (request.tool === "SendToUser") {
          validateSendToUserInput(request.arguments);
          const input = Schema.decodeUnknownSync(AgentSendToUserInput)(request.arguments);
          if (!input.channel) {
            result = await this.messaging.sendVisible(context, input);
          } else {
            const content =
              input.type === "text"
                ? [
                    input.content ?? "",
                    ...(input.images ?? []).map((image) =>
                      image.alt ? `${image.alt}: ${image.url}` : image.url
                    ),
                  ]
                    .filter(Boolean)
                    .join("\n")
                : [input.alt, input.url].filter(Boolean).join("\n");
            try {
              const delivery = await this.plugins.deliverConnectedChannel({
                botId: request.botId,
                runId: request.runId,
                callId: request.callId,
                address: input.channel,
                content,
              });
              result = {
                acknowledgement: {
                  sent: true,
                  channel: input.channel,
                  connection_id: delivery.connectionId,
                  tool: delivery.toolName,
                },
                interruptRunId: null,
              };
            } catch (error) {
              const recoveryRunId = await this.messaging.enqueueChannelDeliveryFailure(
                context,
                input.channel,
                error
              );
              result = {
                acknowledgement: {
                  sent: false,
                  channel: input.channel,
                  delivery_failed: true,
                  recovery_run_id: recoveryRunId,
                },
                interruptRunId: null,
              };
            }
          }
        } else {
          throw new ApiError(400, "unknown_dynamic_tool", `Unknown tool ${request.tool}`);
        }
        if (result.interruptRunId) await this.interruptNonUserRun(result.interruptRunId);
        return result.acknowledgement;
      },
      catch: toError,
    });
}
