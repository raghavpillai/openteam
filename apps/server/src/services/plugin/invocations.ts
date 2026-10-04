import { ApiError } from "@openteam/contracts";
import { connectionNamespace } from "@openteam/plugin-sdk";
import type { PrismaClient } from "@openteam/db";
import { appendEvent, toJson } from "../service-utils";
import type { PluginTransport } from "./transport";
import { canonicalJson, jsonObject, redact, toolSnapshot, validateJsonSchema } from "./values";

export class PluginInvocations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executeInvocation: PluginTransport["executeInvocation"]
  ) {}
  invoke = async (
    request: {
      connectionId: string;
      namespace?: string;
      botId: string;
      runId: string;
      callId: string;
      toolName: string;
      arguments: unknown;
    }
  ): Promise<unknown> => {
    const connection = await this.prisma.pluginConnection.findUnique({
      where: { id: request.connectionId },
      include: {
        installation: true,
      },
    });
    if (
      !connection ||
      connection.installation.status !== "installed"
    ) {
      throw new ApiError(404, "plugin_connection_unavailable", "Plugin connection is unavailable");
    }
    if (
      request.namespace &&
      request.namespace !== connectionNamespace(connection.id, connection.alias)
    )
      throw new ApiError(
        409,
        "plugin_identifier_stale",
        "This account was renamed. Re-run GetMcpServerStatus or GetDynamicTools before calling its tools again."
      );
    if (connection.status !== "ready") {
      throw new ApiError(409, "plugin_connection_not_ready", "Plugin connection is not ready");
    }
    const tool = toolSnapshot(connection.toolSnapshot).find(
      (candidate) => candidate.name === request.toolName
    );
    if (!tool) throw new ApiError(404, "plugin_tool_not_found", "Plugin tool not found");
    validateJsonSchema(tool.inputSchema, request.arguments);

    const prepared = await this.prisma.$transaction(async (tx) => {
      // Claim each call once, including concurrent retries from different workers.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plugin-call:${request.callId}`}))`;
      const previous = await tx.pluginInvocation.findUnique({
        where: { callId: request.callId },
      });
      if (
        previous &&
        (previous.connectionId !== request.connectionId ||
          previous.botId !== request.botId ||
          previous.runId !== request.runId ||
          previous.toolName !== request.toolName)
      ) {
        throw new ApiError(
          409,
          "plugin_call_conflict",
          "This call ID belongs to another bot, run, account, or tool"
        );
      }
      if (previous?.status === "completed")
        return { completed: true as const, result: previous.result };
      if (previous) {
        throw new ApiError(
          409,
          "plugin_call_replayed",
          `Plugin call is already ${previous.status}`
        );
      }
      await tx.pluginInvocation.create({
        data: {
          callId: request.callId,
          connectionId: request.connectionId,
          botId: request.botId,
          runId: request.runId,
          toolName: request.toolName,
          arguments: toJson(request.arguments),
        },
      });
      return { completed: false as const };
    });
    if (prepared.completed) return prepared.result;
    return this.executeInvocation(request.callId);
  };
}
