import { ApiError } from "@openbot/contracts";
import { Schema } from "effect";

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization,content-type,idempotency-key,last-event-id,x-file-name",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "content-length,etag,server-timing,set-auth-token",
  "cache-control": "no-store",
};

export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { ...corsHeaders, ...headers } });

export const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) {
    if (name === "access-control-expose-headers" && headers.has(name)) {
      const exposed = new Set(
        `${headers.get(name)},${value}`
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      );
      headers.set(name, [...exposed].join(","));
    } else {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

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
