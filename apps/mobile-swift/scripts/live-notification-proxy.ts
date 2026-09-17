/** Passes every product request unchanged to real-server-qa.ts's production API.
 * Only simulator delivery/observations are local; reads, badges, authentication,
 * device registration and the event stream come from the live database/server.
 */
const udid = process.env.SWIFT_PUSH_QA_SIMULATOR;
if (!udid || !/^[A-F0-9-]{36}$/i.test(udid)) throw new Error("Set SWIFT_PUSH_QA_SIMULATOR");
let registration: any;
const observations: any[] = [], deliveries: any[] = [];
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 20023, idleTimeout: 255, async fetch(request) {
  const url = new URL(request.url);
  if (request.headers.has("origin")) return new Response(null, { status: 403 });
  if (url.pathname === "/__push/reset" && request.method === "POST") {
    registration = undefined; observations.length = 0; deliveries.length = 0;
    return Response.json({ ok: true });
  }
  if (url.pathname === "/__push/state") return Response.json({ registration, observations, deliveries });
  if (url.pathname === "/__push/observation") {
    observations.push(await request.json()); return Response.json({ ok: true });
  }
  if (url.pathname === "/__push/deliver") {
    if (!registration) return Response.json({ error: "Register first" }, { status: 409 });
    const value: any = await request.json();
    const payload = {
      aps: { alert: { title: "OpenTeam live QA", body: value.qaID }, "content-available": 1, "thread-id": value.channelId },
      data: { schemaVersion: 1, notificationScope: registration.notificationScope, kind: "message", ...value },
    };
    const child = Bun.spawn(["xcrun", "simctl", "push", udid, "dev.openteam.mobile.swift", "-"], {
      stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe",
    });
    if (await child.exited) throw new Error(await new Response(child.stderr).text());
    deliveries.push(payload); return Response.json({ ok: true });
  }
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const response = await fetch("http://127.0.0.1:20020" + url.pathname + url.search, { method: request.method, headers: request.headers, body });
  if (url.pathname === "/api/v0/notification-devices" && request.method === "POST" && response.ok) {
    registration = { ...JSON.parse(new TextDecoder().decode(body)), status: response.status };
  }
  return response;
}});
console.log(`Live notification proxy on http://127.0.0.1:${proxy.port}`);
