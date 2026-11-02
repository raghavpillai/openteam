// Test harness only: drives the actual desktop enrollment and consent controllers in Node/Linux.
import { createServer } from "node:http";
import {
  DesktopBrowserNetwork,
  NetworkConsentStore,
} from "../../apps/desktop/src/main/browser-network";
import { DesktopMachineEnrollment } from "../../apps/desktop/src/main/host/machine-enrollment";

const id = process.env.TEST_MACHINE_ID!;
const network = new DesktopBrowserNetwork(id, new NetworkConsentStore("/tmp/network-consent.json"));
let token: string | null = null;
const enrollment = new DesktopMachineEnrollment({
  machineId: id,
  localUrl: "http://127.0.0.1:1",
  localToken: "unused-test-bridge",
  getToken: async () => token,
  getIdentity: async () => ({ label: process.env.TEST_LABEL ?? "Linux test device" }),
  retryMs: 100,
  onConnection: (connection) => {
    void network.configure(connection);
  },
});
createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    switch (request.url) {
      case "/start":
        token = input.token ?? token;
        enrollment.configure("http://server:8787");
        break;
      case "/stop":
        await enrollment.stop();
        break;
      case "/share":
        await network.setAllowed(input.enabled);
        break;
      case "/suspend":
        network.setSuspended(input.suspended);
        break;
      case "/target-stats": {
        const stats = await fetch("http://browser-target.test/stats").then((r) => r.json());
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(stats));
        return;
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ machineId: id, enrollment: enrollment.status(), network: network.status() })
    );
  } catch (error) {
    response.statusCode = 500;
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "fixture error" })
    );
  }
}).listen(8888, "0.0.0.0");
