// RuntimeTools fixtures that keep the real tool dispatch and control-plane response handling.
import { RuntimeTools } from "../../src/runtime/tools";

export const runtimeTools = (screens: unknown = {}, origin = "http://unused.invalid", root = "/tmp") =>
  new RuntimeTools(screens as never, origin, "fixture", root, root) as any;

/** Runs `run` with `globalThis.fetch` replaced by `fetch`. */
export async function withFetch<T>(fetch: (url: any, init: any) => unknown, run: () => T): Promise<Awaited<T>> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** RuntimeTools whose tool-host requests are answered by `respond` (a body or a Response). */
export function controlPlane(respond: (name: string, args: any, id: string) => unknown = () => ({ sent: true }), turn: Record<string, unknown> = {}) {
  const tools = runtimeTools();
  const active: any = { runId: "fixture", botId: "fixture", screenBotId: "fixture", cwd: "/tmp", runtimeProfile: "agent", pluginNamespaces: [], sentMessageCount: 0, queue: { push() {} }, ...turn };
  const calls: Array<{ id: string; name: string; args: any }> = [];
  tools.callControlPlaneTool = (current: any, id: string, name: string, args: any) =>
    withFetch(async () => {
      calls.push({ id, name, args });
      const response = respond(name, args, id);
      return response instanceof Response ? response : Response.json(response);
    }, () => tools.callControlPlaneToolRequest(current, id, name, args));
  let next = 0;
  const call = (name: string, args: any, id = `call-${next++}`, signal?: AbortSignal) => tools.executeOpenTeamTool(active, id, name, args, signal);
  return { tools, active, calls, call };
}
