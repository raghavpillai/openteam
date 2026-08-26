import { ApiError } from "@openbot/contracts";
import { Schema } from "effect";

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,idempotency-key,last-event-id",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "content-length,server-timing",
  "cache-control": "no-store",
};

export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { ...corsHeaders, ...headers } });

export const errorResponse = (error: unknown): Response => {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  console.error(error);
  return json({ error: { code: "internal_error", message } }, 500);
};

export const parseBody = async <A, I>(request: Request, schema: Schema.Schema<A, I>) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch (error) {
    throw new ApiError(400, "invalid_request", "Request body failed validation", String(error));
  }
};
