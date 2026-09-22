/** Disposable loopback fixture. Injects real simulator notifications; never contacts APNs. */
const upstream = "http://127.0.0.1:20015";
const port = 20016;
const udid = process.env.SWIFT_PUSH_QA_SIMULATOR;
if (!udid || !/^[A-F0-9-]{36}$/i.test(udid)) throw new Error("Set SWIFT_PUSH_QA_SIMULATOR to the disposable QA simulator UUID");
let registration: any = null;
let receipts: any[] = [];
let observations: any[] = [];
let reads: Record<string, any> = {};
let cursor = 1, badgeCount = 0, unavailable = false;
let failRegistration = 0, registrationDelay = 0, failUnregister = 0;
const reply = (value: unknown, status = 200) => Response.json(value, { status });
async function inject(value: any) {
  if (!registration) throw new Error("The native app has not registered");
  const data = { schemaVersion: 1, notificationScope: registration.notificationScope, ...value };
  const background = value.kind === "badge-sync";
  const payload = { // simctl rejects content-available-only wakes on this iOS runtime. A badge
  // supplies the simulator wake; production APNs uses only content-available,
  // independently asserted by the transport and PostgreSQL integration tests.
  aps: background ? { "content-available": 1, badge: badgeCount } : { alert: { title: "OpenTeam Push QA", body: value.qaID }, badge: badgeCount, "content-available": 1, "mutable-content": 1, "thread-id": value.channelId }, data };
  const process = Bun.spawn(["xcrun", "simctl", "push", udid!, "dev.openteam.mobile.swift", "-"], { stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe" });
  const result = await process.exited;
  if (result) throw new Error(await new Response(process.stderr).text());
  return payload;
}
Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 40, async fetch(request) {
  const url = new URL(request.url), path = url.pathname;
  const text = request.method === "GET" ? "" : await request.text();
  const body = text ? JSON.parse(text) : {};
  if (path === "/__push/reset") {
    registration = null; receipts = []; observations = []; reads = {}; cursor++; badgeCount = 0; unavailable = false; failRegistration = 0; registrationDelay = 0; failUnregister = 0;
    await fetch(upstream + "/__qa/reset", { method: "POST", body: "{}" });
    return reply({ ok: true });
  }
  if (path === "/__push/state") return reply({ registration, receipts, observations, reads, badgeCount });
  if (path === "/__push/observation") { observations.push(body); return reply({ok: true}); }
  if (path === "/__push/control") {
    unavailable = body.unavailable ?? unavailable;
    failRegistration = body.failRegistration ?? failRegistration;
    registrationDelay = body.registrationDelay ?? registrationDelay;
    failUnregister = body.failUnregister ?? failUnregister;
    return reply({ok:true});
  }
  if (path === "/__push/deliver") {
    badgeCount++;
    await inject({ ...body, botId: "fixture-bot", sender: { name: "Our robot", icon: "chip", color: "#ff6600" } });
    return reply({ok:true});
  }
  if (path === "/__push/read") {
    for (const read of body.readStates ?? []) reads[read.channelId] = read;
    cursor++;
    badgeCount = body.badgeCount;
    if (body.notify !== false) await inject({kind:"badge-sync", readState: body.readStates?.at(-1), probe:body.probe});
    return reply({ok:true});
  }
  if (path === "/__push/probe") { await inject({kind:"badge-sync", probe:body.probe, readState:body.readState}); return reply({ok:true}); }
  if (path === "/api/v0/notification-devices" && request.method === "POST") {
    receipts.push({method:request.method, path, ...body});
    if (registrationDelay) await Bun.sleep(registrationDelay);
    if (failRegistration-- > 0) return reply({message:"QA registration unavailable"},503);
    registration = body;
    return reply({installationId:body.installationId,platform:"ios",enabled:true,lastSeenAt:new Date().toISOString()});
  }
  if (path.startsWith("/api/v0/notification-devices/") && request.method === "DELETE") {
    receipts.push({method:request.method,path});
    if (failUnregister-- > 0) return reply({message:"QA unregister unavailable"},503);
    registration = null;
    return reply({ok:true});
  }
  if (path === "/api/v0/notification-state") {
    if (unavailable) return reply({message:"QA offline"},503);
    return reply({cursor:String(cursor),badgeCount,readStates:Object.values(reads)});
  }
  const response = await fetch(upstream + path + url.search, {method:request.method, headers:request.headers, body: text || undefined});
  if (path === "/api/v0/client-bootstrap" && response.ok) {
    const value: any = await response.json();
    value.channels = value.channels.map((c: any) => ({...c, notificationState:{channelId:c.id,lastReadSequence:"0",lastReadNotificationSequence:"0",notificationCursor:"123", ...reads[c.id]}}));
    return reply(value);
  }
  if (path.endsWith("/read") && request.method === "POST") receipts.push({method:request.method,path,...body});
  return response;
} });
console.log(`Native push QA: http://127.0.0.1:${port}`);
