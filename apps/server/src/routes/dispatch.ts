import type { Effect, Schema } from "effect";
import { json, parseBody } from "../http";
import { type RouteContext, run } from "./context";

export type RouteHandler = (context: RouteContext) => Promise<Response | undefined>;
type PathPattern = string | RegExp;

const route =
  (
    method: string,
    pattern: PathPattern,
    respond: (context: RouteContext, id: string, secondaryId: string) => Promise<Response>
  ): RouteHandler =>
  async (context) => {
    if (context.request.method !== method) return;
    const match =
      typeof pattern === "string"
        ? context.path === pattern
          ? []
          : null
        : context.path.match(pattern);
    if (!match) return;
    return respond(context, match[1] ?? "", match[2] ?? "");
  };

export const effectRoute = <A>(
  method: string,
  pattern: PathPattern,
  operation: (context: RouteContext, id: string, secondaryId: string) => Effect.Effect<A, Error>,
  status = 200
): RouteHandler =>
  route(method, pattern, async (context, id, secondaryId) =>
    json(await run(operation(context, id, secondaryId)), status)
  );

export const bodyRoute = <A, I, B>(
  method: string,
  pattern: PathPattern,
  schema: Schema.Schema<A, I>,
  operation: (
    context: RouteContext,
    id: string,
    input: A,
    secondaryId: string
  ) => Effect.Effect<B, Error>,
  status = 200
): RouteHandler =>
  route(method, pattern, async (context, id, secondaryId) =>
    json(
      await run(operation(context, id, await parseBody(context.request, schema), secondaryId)),
      status
    )
  );

export async function dispatchRoutes(context: RouteContext, routes: readonly RouteHandler[]) {
  for (const handler of routes) {
    const response = await handler(context);
    if (response) return response;
  }
}
