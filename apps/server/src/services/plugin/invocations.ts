import { ApiError } from "@openteam/contracts";
import { effectiveToolPolicy } from "@openteam/plugin-sdk";
import type { PrismaClient } from "@openteam/db";
import { appendEvent, toJson } from "../service-utils";
import type { PluginTransport } from "./transport";
import { canonicalJson, jsonObject, redact, toolSnapshot, validateJsonSchema } from "./values";

export class PluginInvocations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executeInvocation: PluginTransport["executeInvocation"]
  ) {}
  invoke = async (request: {
    connectionId: string;
    botId: string;
    runId: string;
    callId: string;
    toolName: string;
    arguments: unknown;
    mcpDetails?: unknown;
    allowReviewUI?: boolean;
  }, reviewedByUser = false): Promise<unknown> => {
    const connection = await this.prisma.pluginConnection.findUnique({
      where: { id: request.connectionId },
      include: {
        installation: { include: { enablements: { where: { botId: request.botId } } } },
        grants: { where: { botId: request.botId } },
        policies: { where: { OR: [{ botId: request.botId }, { botId: null }] } },
      },
    });
    if (!connection || (connection.installation.status !== "installed" || connection.installation.mode === "disabled")) {
      throw new ApiError(404, "plugin_connection_unavailable", "Plugin connection is unavailable");
    }
    if (connection.status !== "ready") {
      throw new ApiError(409, "plugin_connection_not_ready", "Plugin connection is not ready");
    }
    if (!connection.installation.enablements[0]?.enabled || !connection.grants[0]?.enabled) {
      throw new ApiError(403, "plugin_grant_required", "This bot is not granted this connection");
    }
    const tool = toolSnapshot(connection.toolSnapshot).find(
      (candidate) => candidate.name === request.toolName
    );
    if (!tool) throw new ApiError(404, "plugin_tool_not_found", "Plugin tool not found");
    const policy = effectiveToolPolicy(connection.policies, request.toolName, request.botId, tool.defaultDecision);
    const configuredDecision = policy.enabled ? policy.decision : "deny";
    const decision = reviewedByUser && configuredDecision === "prompt" ? "allow" : configuredDecision;
    validateJsonSchema(tool.inputSchema, request.arguments);

    const previous = await this.prisma.pluginInvocation.findUnique({
      where: { callId: request.callId },
    });
    if (previous?.status === "completed") return previous.result;
    if (previous) {
      throw new ApiError(409, "plugin_call_replayed", `Plugin call is already ${previous.status}`);
    }
    if (decision === "prompt" && request.allowReviewUI === false) {
      throw new ApiError(409, "automation_parent_review_required", "This connector action needs parent review. Report the verified account, action and arguments to your parent. An automation should hand this off with WakeParent; a delegated worker should include it in its final report.");
    }
    if (decision === "prompt") {
      const pendingApprovals = await this.prisma.approval.findMany({
        where: { runId: request.runId, requestMethod: "plugin/tool", status: "pending" },
        select: { details: true },
      });
      const duplicate = pendingApprovals.some(({ details: value }) => {
        const details = jsonObject(value);
        return (
          details.connectionId === request.connectionId &&
          details.toolName === request.toolName &&
          canonicalJson(details.arguments) === canonicalJson(redact(request.arguments))
        );
      });
      if (duplicate) {
        throw new ApiError(
          409,
          "plugin_approval_required",
          "This exact plugin tool call is already waiting for one-time approval."
        );
      }
      if (pendingApprovals.length > 0) {
        throw new ApiError(
          409,
          "plugin_approval_pending",
          "Resolve the pending approval before starting another plugin side effect."
        );
      }
    }
    if (decision !== "allow") {
      await this.prisma.$transaction(async (tx) => {
        await tx.pluginInvocation.create({
          data: {
            callId: request.callId,
            connectionId: request.connectionId,
            botId: request.botId,
            runId: request.runId,
            toolName: request.toolName,
            decision,
            status: decision === "prompt" ? "running" : "denied",
            arguments: toJson(request.arguments),
            completedAt: decision === "prompt" ? null : new Date(),
            error: decision === "prompt" ? "Approval required" : "Denied by policy",
          },
        });
        await tx.pluginActivity.create({
          data: {
            installationId: connection.installationId,
            connectionId: request.connectionId,
            botId: request.botId,
            kind: decision === "prompt" ? "tool.approval_required" : "tool.denied",
            summary: `${request.toolName} was ${decision === "prompt" ? "held for approval" : "denied"}`,
          },
        });
        if (decision === "prompt") {
          const approval = await tx.approval.create({
            data: {
              runId: request.runId,
              upstreamRequestId: `plugin:${request.callId}`,
              requestMethod: "plugin/tool",
              kind: "permissions",
              details: toJson({
                pluginInvocationId: request.callId,
                connectionId: request.connectionId,
                connectionName: connection.name,
                pluginKey: connection.installation.pluginKey,
                botId: request.botId,
                toolName: request.toolName,
                arguments: redact(request.arguments),
                mcpDetails: redact(request.mcpDetails ?? null),
                supportsAlwaysAllow: true,
                effect:
                  "Allow once runs this exact call without changing policy. Always allow also saves an allow policy for this bot, connection, and tool.",
              }),
            },
          });
          await appendEvent(tx, "plugin.approval.requested", approval.id, {
            approvalId: approval.id, runId: request.runId, botId: request.botId,
            connectionId: request.connectionId, toolName: request.toolName,
          });
        }
      });
      throw new ApiError(
        decision === "prompt" ? 409 : 403,
        decision === "prompt" ? "plugin_approval_required" : "plugin_tool_denied",
        decision === "prompt"
          ? "This plugin tool is waiting for one-time approval."
          : "This plugin tool is denied by policy."
      );
    }

    await this.prisma.pluginInvocation.create({
      data: {
        callId: request.callId,
        connectionId: request.connectionId,
        botId: request.botId,
        runId: request.runId,
        toolName: request.toolName,
        decision,
        arguments: toJson(request.arguments),
      },
    });
    return this.executeInvocation(request.callId);
  };

  resolveInvocation = async (
    callId: string,
    decision: "accept" | "decline" | "cancel"
  ): Promise<unknown> => {
    const invocation = await this.prisma.pluginInvocation.findUnique({ where: { callId } });
    if (!invocation)
      throw new ApiError(404, "plugin_invocation_not_found", "Plugin call not found");
    if (invocation.status !== "running") {
      return { status: invocation.status, result: invocation.result };
    }
    if (decision !== "accept") {
      await this.prisma.pluginInvocation.update({
        where: { callId },
        data: {
          status: "denied",
          error: decision === "decline" ? "Declined by user" : "Cancelled",
          completedAt: new Date(),
        },
      });
      return { status: "denied" };
    }
    return this.executeInvocation(callId);
  };
}
