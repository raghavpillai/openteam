import {
  CreateBotInput,
  CreateGroupInput,
  DuplicateBotInput,
  ScreenActionInput,
  ScreenPauseInput,
  ScreenTakeoverInput,
} from "@openteam/contracts";
import { corsHeaders, json } from "../http";
import { type RouteContext, run } from "./context";
import { bodyRoute, dispatchRoutes, effectRoute } from "./dispatch";

export async function botRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, path } = context;

  if (request.method === "GET" && path === "/api/channels") {
    const snapshot = await run(app.clientSnapshot());
    return json({
      channels: snapshot.channels,
      messages: snapshot.channelMessages,
      rounds: snapshot.channelRounds,
    });
  }

  const screenFrameMatch = path.match(/^\/api\/bots\/([^/]+)\/screen\/frame$/);
  if (request.method === "GET" && screenFrameMatch?.[1]) {
    const frame = await run(app.screenFrame(screenFrameMatch[1]));
    return new Response(frame.bytes, {
      headers: {
        ...corsHeaders,
        "content-type": frame.contentType,
        "cache-control": "no-store, max-age=0",
      },
    });
  }

  const avatarMatch = path.match(/^\/api\/bots\/([^/]+)\/avatar$/);
  if (request.method === "GET" && avatarMatch?.[1]) {
    const avatar = await run(app.botAvatar(avatarMatch[1]));
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

  return dispatchRoutes(context, routes);
}

const routes = [
  bodyRoute("POST", "/api/bots", CreateBotInput, ({ app }, id, input) => app.createBot(input), 201),
  bodyRoute(
    "POST",
    /^\/api\/bots\/([^/]+)\/duplicate$/,
    DuplicateBotInput,
    ({ app }, id, input) => app.duplicateBot(id, input),
    201
  ),
  bodyRoute(
    "POST",
    "/api/channels",
    CreateGroupInput,
    ({ app }, id, input) => app.createGroup(input),
    201
  ),
  effectRoute("GET", "/api/groups", ({ app, url }, id) =>
    app.listGroups(url.searchParams.get("includeHidden") === "1")
  ),
  effectRoute("GET", /^\/api\/bots\/([^/]+)\/screen$/, ({ app }, id) => app.screenStatus(id)),
  bodyRoute(
    "POST",
    /^\/api\/bots\/([^/]+)\/screen\/actions$/,
    ScreenActionInput,
    ({ app }, id, input) => app.screenAction(id, input)
  ),
  bodyRoute(
    "POST",
    /^\/api\/bots\/([^/]+)\/screen\/takeover$/,
    ScreenTakeoverInput,
    ({ app }, id, input) => app.screenTakeover(id, input.active)
  ),
  bodyRoute(
    "POST",
    /^\/api\/bots\/([^/]+)\/screen\/pause$/,
    ScreenPauseInput,
    ({ app }, id, input) => app.screenPause(id, input.paused)
  ),
  effectRoute("GET", /^\/api\/bots\/([^/]+)\/transcript$/, ({ app }, id) => app.botTranscript(id)),
  effectRoute(
    "POST",
    /^\/api\/bots\/([^/]+)\/retry$/,
    ({ app }, id) => app.retryBotProvisioning(id),
    202
  ),
];
