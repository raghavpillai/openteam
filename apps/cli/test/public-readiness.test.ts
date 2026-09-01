import { afterEach, describe, expect, test } from "bun:test";
import { inspectPublicReadiness } from "../src/public-readiness";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("public readiness", () => {
  test("checks DNS and the public health endpoint without requiring TLS for HTTP", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/v0/health") {
          return Response.json({ status: "ready" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const result = await inspectPublicReadiness(`http://127.0.0.1:${server.port}`, 2_000);

    expect(result.dns.ok).toBe(true);
    expect(result.endpoint.ok).toBe(true);
    expect(result.tls).toBeUndefined();
  });

  test("reports a non-ready public health response", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ status: "starting" });
      },
    });
    servers.push(server);

    const result = await inspectPublicReadiness(`http://127.0.0.1:${server.port}`, 2_000);

    expect(result.dns.ok).toBe(true);
    expect(result.endpoint).toEqual({
      ok: false,
      detail: `http://127.0.0.1:${server.port} did not report ready`,
    });
  });
});
