import { json } from "../http";
import type { RouteContext } from "./context";

/** Called only after owner authentication, or after internal control-token verification. */
export async function transcriptionRoutes({
  app,
  request,
  path,
}: RouteContext): Promise<Response | undefined> {
  if (path === "/api/server-settings/transcription") {
    if (request.method === "GET") return json(await app.transcription.store.view());
    if (request.method === "PUT")
      return json(await app.transcription.store.save(await request.json().catch(() => null)));
  }
  if (path === "/api/server-settings/transcription/models" && request.method === "POST") {
    return json(await app.transcription.models(await request.json().catch(() => null)));
  }
  if (path === "/api/server-settings/transcription/check" && request.method === "POST") {
    return json(await app.transcription.check());
  }
  if (path === "/api/transcriptions" && request.method === "POST") {
    return json(await app.transcription.transcribe(request));
  }
}
