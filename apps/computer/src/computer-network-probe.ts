import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import type { NetworkRoute } from "@openteam/plugin-sdk/browser-network/protocol";
import { createEgressProbe } from "./browser-network-egress";
import { createQualityProbe } from "./browser-network-quality";

/** This child deliberately has no transport mark. Its ordinary sockets/DNS
 * must traverse the kernel policy, just like a dock app or sudo curl. */
export async function runOrdinaryProbe(kind: "egress" | "quality", route: NetworkRoute) {
  const client = {
    route,
    available: () => true,
    open: (host: string, port: number) =>
      new Promise<Duplex>((resolve, reject) => {
        const socket = createConnection({ host, port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
        socket.setTimeout(6000, () => socket.destroy(new Error("Computer probe timeout")));
      }),
  };
  return kind === "egress" ? createEgressProbe(client)() : createQualityProbe(client)();
}

export function probeComputerNetwork(
  kind: "egress" | "quality",
  route: NetworkRoute,
  signal: AbortSignal
) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1]!, "--computer-network-probe"], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const abort = () => child.kill();
    const timer = setTimeout(abort, kind === "quality" ? 21_000 : 8500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8192) child.kill();
    });
    child.stderr!.resume();
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        if (code !== 0 || signal.aborted) throw new Error("Computer network unavailable");
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Computer network unavailable"));
      }
    });
    child.stdin!.end(JSON.stringify({ kind, route }) + "\n");
  });
}
