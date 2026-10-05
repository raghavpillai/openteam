import { validateApnsConfiguration, type ApnsSettingsStore } from "@openteam/db/apns-settings";

/** Internal installation API: responses contain metadata only, never the key. */
export async function internalNotificationsRoute(
  request: Request,
  settings: ApnsSettingsStore,
  authorized: (request: Request) => boolean
): Promise<Response> {
  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status });
  if (!authorized(request)) return error(401, "unauthorized", "Unauthorized");
  if (request.method === "GET") return Response.json(await settings.status());
  if (request.method !== "PATCH") return error(405, "method_not_allowed", "Method not allowed");
  let config;
  try {
    config = validateApnsConfiguration(await request.json());
  } catch {
    return error(
      400,
      "apns_settings_invalid",
      "Provide a valid APNs key ID, team ID, app bundle ID and P-256 .p8 signing key."
    );
  }
  try {
    return Response.json(await settings.save(config));
  } catch {
    // Database and crypto errors may contain secrets. Never reflect their text.
    return error(
      503,
      "apns_settings_save_failed",
      "Could not save APNs settings. Check the installation control token and database connection."
    );
  }
}
