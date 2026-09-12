import { EVENT_POLL_MAX_WAIT_MS, eventPoll, eventStream } from "../event-stream";
import { corsHeaders, json } from "../http";
import type { RouteContext } from "./context";
import { boundedQueryInteger, eventCursor } from "./input";

export async function eventRoutes({
  app,
  request,
  url,
  path,
  authMode,
  authenticatedSessionId,
}: RouteContext): Promise<Response | undefined> {
  if (request.method === "GET" && path === "/api/events") {
    const cursor = eventCursor(
      url.searchParams.get("after") ?? request.headers.get("last-event-id")
    );
    const body = eventStream(app, cursor, request.signal);
    return new Response(body, {
      headers: {
        ...corsHeaders,
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  if (request.method === "GET" && path === "/api/events/poll") {
    const cursor = eventCursor(
      url.searchParams.get("after") ?? request.headers.get("last-event-id")
    );
    const waitMs = boundedQueryInteger(
      url.searchParams.get("waitMs"),
      EVENT_POLL_MAX_WAIT_MS,
      EVENT_POLL_MAX_WAIT_MS,
      "waitMs"
    );
    return json(await eventPoll(app, cursor, request.signal, waitMs));
  }
}
