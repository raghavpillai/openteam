import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import {
  HOST_BRIDGE_PATHS,
  parseHostAwaitShellRequest,
  parseHostReadRequest,
  parseHostShellRequest,
  parseHostTransferRequest,
} from "@openteam/contracts/service-protocol";
import { listenForHostBridge } from "./bridge-listener";
import { HostFileTransfers } from "./file-transfer";
import type { HostCapabilities } from "./capabilities";
import type { HostJobPayload } from "./job-protocol";
import type { ComputerSettingsStore } from "../computer-settings";

const MAX_BODY_BYTES = 128 * 1024;

const json = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const authorized = (request: IncomingMessage, token: string): boolean => {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const startHostBridge = (options: {
  token: string;
  port: number;
  hostname?: string;
  terminalDir: string;
  computerSettings: ComputerSettingsStore;
  machineId?: string;
  machineLabel?: string;
  runJob: (payload: HostJobPayload, signal?: AbortSignal) => Promise<unknown>;
  capabilities?: HostCapabilities;
}): Promise<Server> => {
  const machineId = options.machineId ?? "this-computer";
  const defaultMachineLabel = options.machineLabel ?? hostname();
  const assertMachine = (supplied: unknown) => {
    if (supplied !== undefined && supplied !== machineId) {
      throw new Error(`Unknown local computer: ${String(supplied)}`);
    }
  };
  const transfers = new HostFileTransfers();
  const server = createServer(async (request, response) => {
    if (request.url === HOST_BRIDGE_PATHS.health && request.method === "GET") {
      return json(response, 200, { status: "ready" });
    }
    if (!authorized(request, options.token)) return json(response, 401, { error: "unauthorized" });

    const controller = new AbortController();
    const cancelOnDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", cancelOnDisconnect);

    try {
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.capabilities) {
        if (!options.capabilities) return json(response, 503, { error: "Desktop capabilities are unavailable; update the connected desktop app" });
        return json(response, 200, await options.capabilities.handle(await body(request), controller.signal));
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.transfer) {
        const input = parseHostTransferRequest(await body(request));
        assertMachine(input.machineId);
        return json(response, 200, await transfers.prepare(input));
      }
      if (request.url?.startsWith(`${HOST_BRIDGE_PATHS.transfer}/`)) {
        await transfers.transfer(request.url.slice(HOST_BRIDGE_PATHS.transfer.length + 1), request, response);
        return;
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.machines) {
        const settings = await options.computerSettings.read();
        return json(response, 200, {
          machines: [
            {
              machineId,
              label: settings.machineLabel ?? defaultMachineLabel,
            },
          ],
        });
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.read) {
        const input = parseHostReadRequest(await body(request));
        assertMachine(input.machineId);
        return json(
          response,
          200,
          await options.runJob({ kind: "read", input }, controller.signal)
        );
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.shell) {
        const input = parseHostShellRequest(await body(request));
        assertMachine(input.machineId);
        return json(
          response,
          200,
          await options.runJob(
            { kind: "shell", input, terminalDir: options.terminalDir },
            controller.signal
          )
        );
      }
      if (request.method === "POST" && request.url === HOST_BRIDGE_PATHS.awaitShell) {
        const input = parseHostAwaitShellRequest(await body(request));
        assertMachine(input.machineId);
        // A job handle observes an existing command without launching a process.
        return json(
          response,
          200,
          await options.runJob(
            { kind: "await-shell", input, terminalDir: options.terminalDir },
            controller.signal
          )
        );
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      if (!controller.signal.aborted) {
        return json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      response.off("close", cancelOnDisconnect);
    }
  });
  return listenForHostBridge(server, options.port, options.hostname);
};
