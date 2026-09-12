import { json } from "../http";
import { type RouteContext, run } from "./context";
import { dispatchRoutes, effectRoute } from "./dispatch";
import { routineBody } from "./input";

export async function routineRoutes(context: RouteContext): Promise<Response | undefined> {
  const { app, request, path } = context;

  const botRoutinesMatch = path.match(/^\/api\/bots\/([^/]+)\/routines$/);

  if (request.method === "POST" && botRoutinesMatch?.[1]) {
    const input = await routineBody(request);
    return json(await run(app.createRoutine(botRoutinesMatch[1], input.clientId, input)), 201);
  }
  const groupRoutinesMatch = path.match(/^\/api\/channels\/([^/]+)\/routines$/);

  if (request.method === "POST" && groupRoutinesMatch?.[1]) {
    const input = await routineBody(request);
    return json(
      await run(app.createGroupRoutine(groupRoutinesMatch[1], input.clientId, input)),
      201
    );
  }

  const routineActionMatch = path.match(/^\/api\/routines\/([^/]+)\/(pause|resume|test)$/);
  if (request.method === "POST" && routineActionMatch?.[1] && routineActionMatch[2]) {
    const input = await routineBody(request);
    if (routineActionMatch[2] === "test") {
      return json(await run(app.runRoutineNow(routineActionMatch[1], input.clientId)), 202);
    }
    const lifecycleAction = routineActionMatch[2] === "pause" ? "pause" : "resume";
    return json(
      await run(
        app.routineLifecycle(
          routineActionMatch[1],
          input.clientId,
          lifecycleAction,
          input.expectedRevision
        )
      )
    );
  }
  const routineMatch = path.match(/^\/api\/routines\/([^/]+)$/);

  if (request.method === "PATCH" && routineMatch?.[1]) {
    const input = await routineBody(request);
    return json(await run(app.updateRoutine(routineMatch[1], input.clientId, input)));
  }
  if (request.method === "DELETE" && routineMatch?.[1]) {
    const input = await routineBody(request);
    return json(
      await run(
        app.routineLifecycle(routineMatch[1], input.clientId, "delete", input.expectedRevision)
      )
    );
  }

  return dispatchRoutes(context, routes);
}

const routes = [
  effectRoute("GET", /^\/api\/bots\/([^/]+)\/routines$/, ({ app }, id) => app.listRoutines(id)),
  effectRoute("GET", /^\/api\/channels\/([^/]+)\/routines$/, ({ app }, id) =>
    app.listGroupRoutines(id)
  ),
  effectRoute("GET", /^\/api\/routines\/([^/]+)\/executions$/, ({ app, url }, id) =>
    app.routineExecutions(id, Number(url.searchParams.get("limit") ?? 20))
  ),
  effectRoute("GET", /^\/api\/routines\/([^/]+)$/, ({ app }, id) => app.routineDetail(id)),
];
