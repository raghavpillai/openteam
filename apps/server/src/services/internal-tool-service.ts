import { readAgentActivity, readTranscript } from "@openteam/messaging";
import { normalizeMainToolArguments } from "@openteam/contracts/reference-main-parsers";
import { subagentUsesParentConnectors } from "@openteam/contracts/task-configuration";
import {
  AgentSendToUserInput,
  validateProcessSecretName,
  AUTOMATION_PARENT_ONLY_TOOLS,
  AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED,
  WakeParentInput,
  ApiError,
  CheckSubagentInput,
  CreateAgentInput,
  CreateChannelInput,
  type DynamicToolCallRequest,
  MessageSubagentInput,
  ReactToMessageInput,
  RequestBoxHelpInput,
  SendToAgentInput,
  StopSubagentInput,
  TaskInput,
  TodoWriteInput,
  UpdateAgentInput,
  UpdateChannelInput,
  isStateTool,
} from "@openteam/contracts";
import type { PrismaClient } from "@openteam/db";
import { type AgentMessaging, validateSendToUserInput, wakeAutomationParent, automationContextRunId } from "@openteam/messaging";
import { Schema } from "effect";
import type { DurableStateService } from "../update-state";
import { formatMemoryToolResult } from "../memory-tool-result";
import type { AdministrationService } from "./administration-service";
import type { PluginService } from "./plugin-service";
import { serviceEffect } from "./service-utils";
import { botSubagentId, type SubagentService } from "./subagent/service";
import type { TodoService } from "./todo-service";
import type { RichMessageService } from "./rich-message-service";
import { processEnvironment } from "./process-secrets";
import { withConnectorDraftCardReminder } from "./connector-draft-reminder";

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

  execute = (request: DynamicToolCallRequest, transfer: {upload?:import("@openteam/plugin-sdk/file-spool").StagedFile;stream?:boolean} = {}) =>
    serviceEffect(async (signal) => {
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
        !["running"].includes(run.status)
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
      if (request.tool === "RefreshToolCatalog") return {namespaces:await this.plugins.dynamicNamespaces(childIdentity?.parentBotId ?? request.botId)};
      if (request.tool === "ReadProcessSecrets") return { environment: await processEnvironment(this.prisma, request.botId) };
      if (run.origin === "routine" && AUTOMATION_PARENT_ONLY_TOOLS.has(request.tool)) {
        throw new ApiError(403, "automation_tool_forbidden", AUTOMATION_RUN_VISIBLE_TRANSCRIPT_BLOCKED);
      }
      request={...request,arguments:normalizeMainToolArguments(request.tool,request.arguments)};
      if (request.tool === "WakeParent") {
        if (childIdentity) throw new ApiError(403, "wake_parent_unavailable", "Only the automation itself can wake its parent");
        const woken = await wakeAutomationParent(this.messaging, context, Schema.decodeUnknownSync(WakeParentInput)(request.arguments));
        // The handoff ends the automation, so the subagents it started stop with it.
        const children = await this.prisma.subagent.findMany({
          where: { parentBotId: request.botId, parentRunId: { in: woken.automation_run_ids }, status: { in: ["provisioning", "queued", "running"] } },
          select: { id: true },
        });
        await Promise.allSettled(children.map((child) => this.subagents.stop(request.botId, request.callId, { subagent_id: botSubagentId(child.id) })));
        return woken;
      }
      if (run.origin === "routine" && request.tool !== "AcknowledgeCardOutcomes" &&
        (await this.prisma.automationResult.findUnique({ where: { runId: automationContextRunId(run.id, inboxPayload) }, select: { wakeRunId: true } }))?.wakeRunId) {
        throw new ApiError(409, "automation_turn_ended", "This automation already handed control to its parent");
      }
      if (request.tool === "PrepareConnectorTransfer" || request.tool === "ExecuteConnectorTransfer") {
        const args = request.arguments as Record<string, unknown>;
        if (childIdentity && !subagentUsesParentConnectors(childIdentity.subagentType))
          throw new ApiError(403, "parent_transfer_required", "This file transfer must be performed by the parent bot");
        return request.tool === "PrepareConnectorTransfer" ? this.plugins.fileTransfers.prepare(context, args) : this.plugins.fileTransfers.execute(context, args, signal, transfer);
      }
      // Auto-review approval cards: private supervisor operations, never in a model catalog.
      if (request.tool === "RequestApproval" || request.tool === "AwaitApproval" || request.tool === "CancelApproval") {
        if (!this.richMessages) throw new Error("Approval service unavailable");
        const approvals = this.richMessages.approvals;
        return request.tool === "RequestApproval"
          ? approvals.request(context, request.arguments)
          : request.tool === "AwaitApproval"
            ? approvals.wait(context, request.arguments, signal)
            : approvals.cancel(context, request.arguments);
      }
      if (request.tool === "AcknowledgeCardOutcomes") {
        await this.messaging.acknowledgeCardOutcomes(request.botId, (request.arguments as { receipts: Array<{ messageId: string; outcomeId: string }> }).receipts);
        return { acknowledged: true };
      }
      if (request.tool === "RecordUserFormRemap" && !childIdentity && this.richMessages) {
        return this.richMessages.recordFormRemap(request.botId, request.arguments as import("@openteam/contracts").UserFormReceipt);
      }
      const parentOnlyTools = new Set([
        "DraftExternalMessage", "CreateBotShareJson",
        "RequestUserForm",
        "RemapUserFormTargets",
        "RecallMemory",
        "ReadTranscript",
        "ReadAgentActivity",
        "ListSections",
        "Task",
        "CheckSubagent",
        "MessageSubagent",
        "StopSubagent",
        "CreateAgent",
        "UpdateAgent",
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
      if (request.tool === "ReadTranscript") return readTranscript(this.prisma, context, request.arguments);
      if (request.tool === "ReadAgentActivity") return readAgentActivity(this.prisma, { botId: childIdentity?.parentBotId ?? request.botId }, request.arguments);
      if (request.tool === "RecallMemory") {
        return this.messaging.agentData.recallMemory(request.botId, request.arguments, run.channelId);
      }
      if (request.tool === "CreateBotShareJson") {
        if (!this.richMessages) throw new Error("Review service unavailable");
        return this.richMessages.sharedTemplates.publish(context, request.arguments);
      }
      if (request.tool === "DraftExternalMessage") {
        if (!this.richMessages) throw new Error("Draft service unavailable");
        return this.richMessages.externalDrafts.create(context, request.arguments);
      }
      if (request.tool === "RequestUserForm") {
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
        const resolved = await this.plugins.resolveToolArguments(request.tool, input).catch((error) => {
          // An unknown server_id is answered by the listing formatter, as in the reference.
          if (error instanceof ApiError && error.code === "connection_not_found") return null;
          throw error;
        });
        if (!resolved) return { connections: [] };
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
          origin: run.origin,
        }, signal);
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
        return withConnectorDraftCardReminder(this.prisma, { connectionId: input.connectionId, toolName: input.toolName }, !childIdentity && run.origin !== "routine", await this.plugins.invoke({
          connectionId: input.connectionId,
          namespace: typeof input.namespace === "string" ? input.namespace : undefined,
          botId:
            subagentUsesParentConnectors(childIdentity?.subagentType) ? childIdentity!.parentBotId : request.botId,
          runId: request.runId,
          callId: request.callId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
        }));
      }
      if (isStateTool(request.tool)) {
        const result = await this.durableState.executeTool(
          request.botId,
          request.callId,
          request.tool,
          request.arguments,
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
        return this.subagents.task(context, Schema.decodeUnknownSync(TaskInput)(request.arguments));
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
            // Nothing left the box for these, so refuse now with the reason.
            if (error instanceof ApiError && error.code === "connected_channel_address_invalid")
              throw new ApiError(400, error.code, `"${input.channel}" is not a valid channel address, so nothing was sent. An address is shaped platform:chat.`);
            if (error instanceof ApiError && ["connected_channel_unavailable", "connected_channel_ambiguous", "connected_channel_delivery_unsupported"].includes(error.code))
              throw new ApiError(error.status, error.code, `${error.message}. Nothing was sent.`);
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
                reason: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
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
