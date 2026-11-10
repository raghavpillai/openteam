import { VoiceSessionCreateInput, VoiceSettingsInput } from "@openteam/contracts";
import { json, parseBody } from "../http";
import type { RouteContext } from "./context";

export const isVoiceStreamPath = (method: string, path: string): boolean =>
  method === "GET" && /^\/api\/voice\/sessions\/[^/]+\/stream$/.test(path);

export async function voiceRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, path, authenticatedSessionId } = context;
  if (path === "/api/voice/sessions" && request.method === "POST") {
    const input = await parseBody(request, VoiceSessionCreateInput);
    const response = await app.voice.create(input, authenticatedSessionId, request.headers.get("origin"));
    return json(response, 201);
  }
  const sessionMatch = path.match(/^\/api\/voice\/sessions\/([^/]+)$/);
  if (sessionMatch?.[1] && request.method === "GET") return json(await app.voice.get(decodeURIComponent(sessionMatch[1]), authenticatedSessionId));
  if (sessionMatch?.[1] && request.method === "DELETE") return json(await app.voice.end(decodeURIComponent(sessionMatch[1]), authenticatedSessionId));
  const ticketMatch = path.match(/^\/api\/voice\/sessions\/([^/]+)\/tickets$/);
  if (ticketMatch?.[1] && request.method === "POST") return json(await app.voice.issueReconnectTicket(decodeURIComponent(ticketMatch[1]), authenticatedSessionId, request.headers.get("origin")));
  const streamMatch = path.match(/^\/api\/voice\/sessions\/([^/]+)\/stream$/);
  if (streamMatch?.[1] && request.method === "GET" && context.server) return app.voice.upgrade(request, context.server, decodeURIComponent(streamMatch[1]));
  if (path === "/api/server-settings/voice" && request.method === "GET") return json(await app.voice.settings.view());
  if (path === "/api/server-settings/voice" && request.method === "PUT")
    return json(await app.voice.settings.save(await parseBody(request, VoiceSettingsInput)));
  return undefined;
}
