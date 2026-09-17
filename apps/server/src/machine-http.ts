import { ApiError } from "@openteam/contracts";
import type { MachineService } from "./services/machine-service";

/** Device credentials authorize only this machine's channel, never general API access. */
export async function machineChannelResponse(
  machines: MachineService, request: Request, path: string,
  review: (value: unknown) => Promise<unknown>,
  savedLogin?: (value: unknown) => Promise<unknown>,
) {
  const machine = await machines.authenticate(request);
  const prefix = "/api/machines/channel";
  const connectionId = request.headers.get("x-openteam-connection-id") ?? "";
  const readJson = async () => {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader) for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 32_768) throw new ApiError(413, "machine_request_large", "Computer request is too large");
        chunks.push(next.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
      return value as Record<string, unknown>;
    } catch (error) {
      void reader?.cancel().catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "machine_request_invalid", "Invalid computer request");
    } finally { reader?.releaseLock(); }
  };
  if (path === `${prefix}/connect` && request.method === "POST") return Response.json(machines.relay.connect(machine.machineId));
  if (path === `${prefix}/disconnect` && request.method === "POST") {
    machines.relay.disconnect(machine.machineId, connectionId);
    return new Response(null, { status: 204 });
  }
  if (path === `${prefix}/poll` && request.method === "POST") {
    const input = await readJson();
    if (!Array.isArray(input.active) || input.active.length > 32 || input.active.some(id => typeof id !== "string" || id.length > 100)) throw new ApiError(400, "machine_poll_invalid", "Invalid active requests");
    await machines.heartbeat(machine.machineId, input);
    return Response.json(await machines.relay.poll(machine.machineId, connectionId, input.active as string[], request.signal));
  }
  if (path === `${prefix}/review` && request.method === "POST") return Response.json(await review(await readJson()));
  if (path === `${prefix}/saved-login` && request.method === "POST" && savedLogin) {
    if (!machines.relay.connected(machine.machineId)) throw new ApiError(409, "machine_offline", "Connect this computer before using saved logins");
    return Response.json(await savedLogin(await readJson()), { headers: { "cache-control": "no-store" } });
  }
  const operation = path.match(/^\/api\/machines\/channel\/requests\/([\da-f-]{36})\/(body|response|failure)$/i);
  if (operation?.[2] === "body" && request.method === "GET") return machines.relay.body(machine.machineId, connectionId, operation[1]!);
  if (operation?.[2] === "response" && request.method === "POST") return machines.relay.respond(machine.machineId, connectionId, operation[1]!, request);
  if (operation?.[2] === "failure" && request.method === "POST") {
    machines.relay.fail(machine.machineId, connectionId, operation[1]!);
    return new Response(null, { status: 204 });
  }
  throw new ApiError(404, "not_found", "Computer route not found");
}
