import {
  AgentSendToUserInput,
  validateProcessSecretName,
  AUTOMATION_PARENT_ONLY_TOOLS,
  WakeParentInput,
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
import { type AgentMessaging, validateSendToUserInput, wakeAutomationParent, automationContextRunId } from "@openteam/messaging";
import { Schema } from "effect";
import type { DurableStateService } from "../update-state";
import { formatMemoryToolResult } from "../memory-tool-result";
import type { AdministrationService } from "./administration-service";
import type { PluginService } from "./plugin-service";
import { serviceEffect } from "./service-utils";
import type { SubagentService } from "./subagent/service";
import type { TodoService } from "./todo-service";
import type { RichMessageService } from "./rich-message-service";
import { processEnvironment } from "./process-secrets";

export class InternalToolService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messaging: AgentMessaging,
    private readonly durableState: DurableStateService,
    private readonly interruptNonUserRun: (runId: string) => Promise<void>,
    private readonly todos: TodoService,
    private readonly subagents: SubagentService,
    private readonly administration: AdministrationService,
    private readonly plugins: PluginService,
    private readonly richMessages?: RichMessageService
  ) {}

  execute = (request: DynamicToolCallRequest) =>
    serviceEffect(async (signal) => {
      const reviewedExternal=request.tool==="ReviewedExternalFileDelivery";
      if(reviewedExternal)request={...request,tool:"SendToUser"};
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
          typeof inboxPayload?.replyToMessageId === "string" ? inboxPayload.replyToMessageId : null,
        isFork: inboxPayload?.isFork === true,
      };
      const childIdentity = await this.prisma.subagent.findUnique({
        where: { childBotId: request.botId },
        select: { id: true, parentBotId: true, parentRunId: true, subagentType: true },
      });
      // Private supervisor operation, never registered in any model catalog.
      if (request.tool === "ReadProcessSecrets") return { environment: await processEnvironment(this.prisma, request.botId) };
      if (request.tool === "PrepareConnectorTransfer" || request.tool === "ExecuteConnectorTransfer") {
        if (childIdentity || run.origin === "routine") throw new ApiError(403, "parent_transfer_required", "File transfers with review must be performed by the parent bot");
        const args = request.arguments as Record<string, unknown>;
        return request.tool === "PrepareConnectorTransfer" ? this.plugins.fileTransfers.prepare(context, args) : this.plugins.fileTransfers.execute(context, args, signal);
      }
      if (run.origin === "routine" && AUTOMATION_PARENT_ONLY_TOOLS.has(request.tool)) {
        throw new ApiError(403, "automation_tool_forbidden", "Use WakeParent to hand this communication or review to the parent agent");
      }
      if (request.tool === "WakeParent") {
        if (childIdentity) throw new ApiError(403, "wake_parent_unavailable", "Only the automation itself can wake its parent");
        return wakeAutomationParent(this.messaging, context, Schema.decodeUnknownSync(WakeParentInput)(request.arguments));
      }
      if (run.origin === "routine" && !["RefreshPromptContext", "AcknowledgePromptContext", "AcknowledgeCardOutcomes"].includes(request.tool) &&
        (await this.prisma.automationResult.findUnique({ where: { runId: automationContextRunId(run.id, inboxPayload) }, select: { wakeRunId: true } }))?.wakeRunId) {
        throw new ApiError(409, "automation_turn_ended", "This automation already handed control to its parent");
      }
      if (request.tool === "AcknowledgeCardOutcomes") {
        await this.messaging.acknowledgeCardOutcomes(request.botId, (request.arguments as { receipts: Array<{ messageId: string; outcomeId: string }> }).receipts);
        return { acknowledged: true };
      }
      if (request.tool === "RecordUserFormRemap" && !childIdentity && this.richMessages) {
        return this.richMessages.recordFormRemap(request.botId, request.arguments as import("@openteam/contracts").UserFormReceipt);
      }
      if (["RefreshPromptContext", "AcknowledgePromptContext"].includes(request.tool)) {
        const args = request.arguments as { contextSessionId?: string; epoch?: number; connectorInstructions?: string; acknowledgement?: unknown };
        const session = await this.prisma.contextSession.findFirst({ where: { id: args.contextSessionId, botId: request.botId } });
        if (!session || !args.contextSessionId) throw new ApiError(403, "context_unavailable", "Context does not belong to this bot");
        if (request.tool === "AcknowledgePromptContext") {
          await this.messaging.acknowledgePlatformPrompt(request.botId, session.id, {
            acknowledgement: args.acknowledgement,
          } as Parameters<AgentMessaging["acknowledgePlatformPrompt"]>[2]);
          return { acknowledged: true };
        }
        if (!Number.isSafeInteger(args.epoch) || args.epoch! < session.compactionEpoch || args.epoch! > session.compactionEpoch + 1) {
          throw new ApiError(409, "context_epoch_invalid", "Context epoch is not the current or next summary");
        }
        await this.prisma.contextSession.updateMany({ where: { id: session.id, compactionEpoch: { lt: args.epoch! } }, data: { compactionEpoch: args.epoch } });
        return this.messaging.platformPrompt(request.botId, session.id, args.connectorInstructions ?? "", run.memoryConversationId ?? undefined);
      }
      const parentOnlyTools = new Set([
        "DraftExternalMessage", "SendFeedback", "create_bot_share_json",
        "request_user_form",
        "remap_user_form_targets",
        "RecallMemory",
        "ListSections",
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
      if (request.tool === "RecallMemory") {
        const memoryContextId = run.memoryConversationId ?? (await this.messaging.agentData.resolveMemoryConversation(request.botId, run.channelId)).id;
        return this.messaging.agentData.recallMemory(request.botId, request.arguments, memoryContextId);
      }
      if (request.tool === "SendFeedback" || request.tool === "create_bot_share_json") {
        if (!this.richMessages) throw new Error("Review service unavailable");
        return this.richMessages.reviewActions.stage(context, request.tool, request.arguments);
      }
      if (request.tool === "DraftExternalMessage") {
        if (!this.richMessages) throw new Error("Draft service unavailable");
        return this.richMessages.externalDrafts.create(context, request.arguments);
      }
      if (request.tool === "request_user_form") {
        if (!this.richMessages) throw new Error("User form service is unavailable");
        return this.richMessages.createUserForm(context, request.arguments);
      }
      if (request.tool === "ListSections") {
        const sections = await this.messaging.agentData.listSections();
        return sections.length ? sections.map((section) => `- ${section.name} (id: ${section.id})`).join("\n")
          : "If there are no custom sections, CreateAgent should omit section_id.";
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
        const pluginKey = input.plugin_id ?? input.pluginKey;
        if (typeof pluginKey !== "string") {
          throw new ApiError(400, "plugin_key_required", "pluginKey is required");
        }
        return this.plugins.catalogDetail(pluginKey);
      }
      if (request.tool === "GetMcpServerStatus") {
        const input =
          request.arguments && typeof request.arguments === "object"
            ? (request.arguments as Record<string, unknown>)
            : {};
        const resolved = await this.plugins.resolveToolArguments(request.tool, input);
        return this.plugins.connectionStatuses(typeof resolved.connectionId === "string" ? resolved.connectionId : undefined);
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
        const automationChild = childIdentity && (await this.prisma.run.findUnique({
          where: { id: childIdentity.parentRunId }, select: { origin: true },
        }))?.origin === "routine";
        return this.plugins.invoke({
          connectionId: input.connectionId,
          botId:
            childIdentity?.subagentType === "executor" ? childIdentity.parentBotId : request.botId,
          runId: request.runId,
          callId: request.callId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          mcpDetails: input.mcpDetails,
          allowReviewUI: run.origin !== "routine" && !automationChild,
        });
      }
      if (request.tool === "update_state") {
        const result = await this.durableState.execute(
          request.botId,
          request.callId,
          Schema.decodeUnknownSync(UpdateStateInput)(request.arguments),
          request.runId
        );
        return formatMemoryToolResult(result);
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
        return this.subagents.task(context, Schema.decodeUnknownSync(TaskInput)(request.arguments), signal);
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
        const reason = input.instruction ?? (input.reason && !["auth", "captcha", "payment", "other"].includes(input.reason)
          ? input.reason : "Please complete the manual step on the computer.");
        const result = await this.messaging.sendVisible(context, {
          type: "computer-handoff",
          content: reason,
          computerHandoff: { reason, ...(input.reason ? { category: ["auth", "captcha", "payment", "other"].includes(input.reason) ? input.reason : "other" } : {}),
            ...(input.domain ? { domain: input.domain } : {}), ...(input.idp_domain ? { idpDomain: input.idp_domain } : {}) },
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
        if ((request.arguments as Record<string, unknown>)?.type === "credential-request") throw new ApiError(400,"desktop_credential_request_required","Saved-login requests must run through the active desktop browser so approval is bound to its document");
        validateSendToUserInput(request.arguments);
        const input = Schema.decodeUnknownSync(AgentSendToUserInput)(request.arguments);
        if (input.type === "secret-request" && input.secret?.name) {
          validateProcessSecretName(input.secret.name);
          if (input.channel || childIdentity || !await this.prisma.channel.count({ where: { id: request.channelId, kind: "bot_dm", directKey: `bot:${request.botId}`, archivedAt: null } }))
            throw new ApiError(403, "secret_owner_dm_required", "Ask for this secret only in the owner's bot DM");
        }
        if (!input.channel) {
          result = await this.messaging.sendVisible(context, input);
        } else {
          const content = input.type === "text" ? input.content ?? "" : input.alt ?? "";
          const sources = input.type === "text" ? input.images ?? [] : input.type === "attachment" ? [{url:input.url!,alt:input.alt}] : [];
          try {
            const files = await Promise.all(sources.map(async source => {
              const asset = await this.messaging.assets.ingestSource(source);
              return {assetId:asset.assetId,name:asset.fileName,mimeType:asset.mimeType,bytes:Buffer.from(await Bun.file(this.messaging.assets.contentPath(asset.assetId)).arrayBuffer())};
            }));
            const delivery = await this.plugins.deliverConnectedChannel({
              botId: request.botId,
              runId: request.runId,
              callId: request.callId,
              address: input.channel,
              content,
              files,
              reviewedExternal,
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
            if(error instanceof ApiError&&error.code==="external_file_review_required")throw error;
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
    });
}
