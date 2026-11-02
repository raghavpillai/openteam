import { BrowserNetworkClient } from "@openteam/plugin-sdk/browser-network/client";
import { createBrowserProxy } from "@openteam/plugin-sdk/browser-network/socks";
import { createQualityProbe } from "./browser-network-quality";
import { createEgressProbe } from "./browser-network-egress";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let shutdown: (() => void) | undefined,
  parentClosed = false;
lines.once("close", () => {
  parentClosed = true;
  shutdown?.();
});
const input = await new Promise<string>((resolve, reject) => {
  lines.once("line", resolve);
  lines.once("close", () => reject(new Error("Browser network parent disconnected")));
});
if (input.length > 8192) throw new Error("Invalid browser network configuration");
const config = JSON.parse(input) as { serverUrl: string; token: string; port: number };
const url = new URL(
  `${config.serverUrl.replace(/\/$/, "")}/api/v0/internal/browser-network/channel`
);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const client = new BrowserNetworkClient({
  role: "computer",
  url: url.href,
  headers: { authorization: `Bearer ${config.token}` },
});
const proxy = createBrowserProxy((host, port) => client.open(host, port));
const port = await proxy.listen(config.port);
client.start();
const egress = createEgressProbe(client);
const quality = createQualityProbe(client);
const checking = new Set<string>();
lines.on("line", (line) => {
  if (line.length > 256) return;
  try {
    const command = JSON.parse(line);
    if (
      !["egress", "quality"].includes(command.op) ||
      typeof command.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(command.id)
    )
      return;
    const id = command.id;
    if (checking.has(command.op)) {
      console.log(JSON.stringify({ id, error: true }));
      return;
    }
    checking.add(command.op);
    void (command.op === "quality" ? quality() : egress())
      .then((result) => console.log(JSON.stringify({ id, result })))
      .catch(() => console.log(JSON.stringify({ id, error: true })))
      .finally(() => {
        checking.delete(command.op);
      });
  } catch {
    /* Private bounded command channel. */
  }
});
console.log(JSON.stringify({ started: true, port }));
const status = setInterval(() => console.log(JSON.stringify(client.status())), 1000);
shutdown = () => {
  clearInterval(status);
  client.stop();
  void proxy.close().then(() => process.exit(0));
};
if (parentClosed) shutdown();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
