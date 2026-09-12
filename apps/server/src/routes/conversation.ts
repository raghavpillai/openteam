import {
  ApiError,
  ResolveApprovalInput,
  SendMessageInput,
  UpdateBotInput,
} from "@openteam/contracts";
import { json } from "../http";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";

export async function conversationRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, path } = context;

  const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (request.method === "GET" && conversationMatch?.[1]) {
    const snapshot = await run(app.clientSnapshot());
    const bot = snapshot.bots.find(
      (candidate) => candidate.conversationId === conversationMatch[1]
    );
    if (!bot) throw new ApiError(404, "conversation_not_found", "Conversation not found");
    const runs = snapshot.runs.filter((run) => run.conversationId === conversationMatch[1]);
    const runIds = new Set(runs.map((run) => run.id));
    const channel = snapshot.channels.find((candidate) => candidate.directKey === `bot:${bot.id}`);
    const subagents = snapshot.subagents.filter(
      (subagent) => subagent.parentChannelId === channel?.id
    );
    const approvalRunIds = new Set([
      ...runIds,
      ...subagents.flatMap((subagent) => (subagent.currentRunId ? [subagent.currentRunId] : [])),
    ]);
    return json({
      bot,
      messages: channel
        ? snapshot.channelMessages.filter((message) => message.channelId === channel.id)
        : [],
      runs,
      runItems: snapshot.runItems.filter((item) => runIds.has(item.runId)),
      approvals: snapshot.approvals.filter((approval) => approvalRunIds.has(approval.runId)),
      subagents,
    });
  }

  return dispatchRoutes(context, routes);
}

const routes = [
  bodyRoute("PATCH", /^\/api\/bots\/([^/]+)$/, UpdateBotInput, ({ app }, id, input) =>
    app.updateBot(id, input)
  ),
  effectRoute("DELETE", /^\/api\/bots\/([^/]+)$/, ({ app }, id) => app.archiveBot(id)),
  effectRoute("POST", /^\/api\/bots\/([^/]+)\/archive$/, ({ app }, id) => app.archiveBot(id)),
  bodyRoute(
    "POST",
    /^\/api\/conversations\/([^/]+)\/messages$/,
    SendMessageInput,
    ({ app }, id, input) => app.sendMessage(id, input),
    202
  ),
  effectRoute("POST", /^\/api\/runs\/([^/]+)\/cancel$/, ({ app }, id) => app.cancelRun(id)),
  bodyRoute(
    "POST",
    /^\/api\/approvals\/([^/]+)\/(?:resolve|decision)$/,
    ResolveApprovalInput,
    ({ app }, id, input) => app.resolveApproval(id, input.decision)
  ),
];
