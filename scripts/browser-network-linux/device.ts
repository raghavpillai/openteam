// Test harness only: drives the actual desktop enrollment and consent controllers in Node/Linux.
import { createServer } from "node:http";
import {
  DesktopBrowserNetwork,
  NetworkConsentStore,
} from "../../apps/desktop/src/main/browser-network";
import {
  DesktopMachineEnrollment,
  type DesktopEnrollmentConnection,
} from "../../apps/desktop/src/main/host/machine-enrollment";

// Fault only the identity request; enrollment and all other server traffic stay live.
let identityFailures = 0,
  identityRequests = 0,
  identityFaults = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).pathname.endsWith("/browser-network-identity")) {
    identityRequests++;
    if (identityFailures > 0) {
      identityFailures--;
      identityFaults++;
      return new Response(null, { status: 503 });
    }
  }
  return nativeFetch(input, init);
}) as typeof fetch;

const id = process.env.TEST_MACHINE_ID!;
const network = new DesktopBrowserNetwork(id, new NetworkConsentStore("/tmp/network-consent.json"));
let token: string | null = null;
let connection: DesktopEnrollmentConnection | null = null;
const enrollment = new DesktopMachineEnrollment({
  machineId: id,
  localUrl: "http://127.0.0.1:1",
  localToken: "unused-test-bridge",
  getToken: async () => token,
  getIdentity: async () => ({ label: process.env.TEST_LABEL ?? "Linux test device" }),
  retryMs: 100,
  onConnection: (next) => {
    connection = next;
    void network.configure(next);
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
      case "/identity-outage":
        if (!connection) throw Error("Fixture device is not enrolled");
        identityFailures = 1;
        await network.configure(connection);
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
      JSON.stringify({
        machineId: id,
        enrollment: enrollment.status(),
        network: network.status(),
        identityRequests,
        identityFaults,
      })
    );
  } catch (error) {
    response.statusCode = 500;
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "fixture error" })
    );
  }
}).listen(8888, "0.0.0.0");
