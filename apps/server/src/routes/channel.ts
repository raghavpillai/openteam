import {
  ApiError,
  ComputerHandoffMutationInput,
  ReactToChannelMessageInput,
  RenameChannelInput,
  SecretSubmissionInput,
  SendMessageInput,
  SetChannelAvatarInput,
  SetChannelHiddenInput,
  SetChannelMembersInput,
  UpdateChannelProfileInput,
  WidgetDismissInput,
  WidgetResponseInput,
} from "@openteam/contracts";
import { corsHeaders, json, parseBody } from "../http";
import { messageContextExtents } from "../message-context-query";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";
import { historyCursor } from "./input";

export async function channelRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, url, path } = context;

  const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (request.method === "GET" && channelMatch?.[1]) {
    const snapshot = await run(app.clientSnapshot());
    const channel = snapshot.channels.find((candidate) => candidate.id === channelMatch[1]);
    if (!channel) throw new ApiError(404, "channel_not_found", "Channel not found");
    return json({
      channel,
      messages: snapshot.channelMessages.filter((message) => message.channelId === channel.id),
      rounds: snapshot.channelRounds.filter((round) => round.channelId === channel.id),
      runs: snapshot.runs.filter((candidate) => candidate.channelId === channel.id),
    });
  }

  const channelHistoryMatch = path.match(/^\/api\/channels\/([^/]+)\/history$/);
  if (request.method === "GET" && channelHistoryMatch?.[1]) {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    return json(
      await run(
        app.channelHistory(
          decodeURIComponent(channelHistoryMatch[1]),
          historyCursor(url.searchParams.get("before")),
          requestedLimit
        )
      )
    );
  }

  const channelMessageContextMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/context$/);
  if (request.method === "GET" && channelMessageContextMatch?.[1]) {
    const extents = messageContextExtents(url.searchParams);
    return json(
      await run(
        app.channelMessageContext(
          decodeURIComponent(channelMessageContextMatch[1]),
          extents.before,
          extents.after
        )
      )
    );
  }

  const channelAvatarMatch = path.match(/^\/api\/channels\/([^/]+)\/avatar$/);

  if (request.method === "GET" && channelAvatarMatch?.[1]) {
    const avatar = await run(app.channelAvatar(channelAvatarMatch[1]));
    return new Response(avatar.bytes, {
      headers: {
        ...corsHeaders,
        "content-type": avatar.contentType,
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }

  const widgetResponseMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/widget-response$/);
  if (request.method === "POST" && widgetResponseMatch?.[1]) {
    return json(
      await run(
        app.respondToWidget(
          decodeURIComponent(widgetResponseMatch[1]),
          await parseBody(request, WidgetResponseInput)
        )
      ),
      202
    );
  }
  const widgetDismissMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/widget-dismiss$/);
  if (request.method === "POST" && widgetDismissMatch?.[1]) {
    return json(
      await run(
        app.dismissWidget(
          decodeURIComponent(widgetDismissMatch[1]),
          await parseBody(request, WidgetDismissInput)
        )
      )
    );
  }
  const secretSubmissionMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/secret$/);
  const reviewMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/review-action(?:\/(recipe))?$/);
  if (reviewMatch?.[1] && request.method === "GET" && reviewMatch[2]) return json(await app.reviewRecipe(decodeURIComponent(reviewMatch[1])));
  if (reviewMatch?.[1] && request.method === "POST" && !reviewMatch[2]) return json(await run(app.mutateReviewAction(decodeURIComponent(reviewMatch[1]), await request.json())));
  const draftMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/external-draft$/);
  if (request.method === "POST" && draftMatch?.[1]) return json(await run(app.mutateExternalDraft(decodeURIComponent(draftMatch[1]), await request.json())));
  const formMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/user-form(?:\/(prefill))?$/);
  if (request.method === "POST" && formMatch?.[1]) {
    return formMatch[2] ? json(await run(app.userFormPrefill(decodeURIComponent(formMatch[1]))))
      : json(await run(app.submitUserForm(decodeURIComponent(formMatch[1]), await request.json())));
  }
  if (request.method === "POST" && secretSubmissionMatch?.[1]) {
    return json(
      await run(
        app.submitSecret(
          decodeURIComponent(secretSubmissionMatch[1]),
          await parseBody(request, SecretSubmissionInput)
        )
      ),
      202
    );
  }
  const computerHandoffMatch = path.match(/^\/api\/channel-messages\/([^/]+)\/computer-handoff$/);
  if (request.method === "POST" && computerHandoffMatch?.[1]) {
    return json(
      await run(
        app.mutateComputerHandoff(
          decodeURIComponent(computerHandoffMatch[1]),
          await parseBody(request, ComputerHandoffMutationInput)
        )
      ),
      202
    );
  }
  return dispatchRoutes(context, routes);
}

const routes = [
  effectRoute("DELETE", /^\/api\/channels\/([^/]+)$/, ({ app }, id) => app.deleteGroup(id)),
  effectRoute("GET", /^\/api\/channels\/([^/]+)\/client-state$/, ({ app }, id) =>
    app.channelClientState(decodeURIComponent(id))
  ),
  effectRoute(
    "GET",
    /^\/api\/channels\/([^/]+)\/message-deliveries\/([^/]+)$/,
    ({ app }, id, secondaryId) =>
      app.messageDeliveryStatus(decodeURIComponent(id), decodeURIComponent(secondaryId))
  ),
  bodyRoute(
    "POST",
    /^\/api\/channels\/([^/]+)\/messages$/,
    SendMessageInput,
    ({ app }, id, input) => app.sendChannelMessage(id, input),
    202
  ),
  bodyRoute("PATCH", /^\/api\/channels\/([^/]+)\/name$/, RenameChannelInput, ({ app }, id, input) =>
    app.renameChannel(id, input)
  ),
  bodyRoute(
    "PATCH",
    /^\/api\/channels\/([^/]+)\/profile$/,
    UpdateChannelProfileInput,
    ({ app }, id, input) => app.updateChannelProfile(id, input)
  ),
  bodyRoute(
    "PUT",
    /^\/api\/channels\/([^/]+)\/avatar$/,
    SetChannelAvatarInput,
    ({ app }, id, input) => app.setChannelAvatar(id, input)
  ),
  bodyRoute(
    "PUT",
    /^\/api\/channels\/([^/]+)\/members$/,
    SetChannelMembersInput,
    ({ app }, id, input) => app.setChannelMembers(id, input)
  ),
  bodyRoute(
    "PATCH",
    /^\/api\/channels\/([^/]+)\/hidden$/,
    SetChannelHiddenInput,
    ({ app }, id, input) => app.setChannelHidden(id, input)
  ),
  bodyRoute(
    "POST",
    /^\/api\/channel-messages\/([^/]+)\/reaction$/,
    ReactToChannelMessageInput,
    ({ app }, id, input) => app.reactToMessage(id, input),
    202
  ),
];
