/** Disposable loopback fixture. Injects real simulator notifications; never contacts APNs. */
const upstream = process.env.SWIFT_PUSH_QA_UPSTREAM ?? "http://127.0.0.1:20015";
const port = Number(process.env.SWIFT_PUSH_QA_PORT ?? 20016);
const udid = process.env.SWIFT_PUSH_QA_SIMULATOR;
if (!udid || !/^[A-F0-9-]{36}$/i.test(udid)) throw new Error("Set SWIFT_PUSH_QA_SIMULATOR to the disposable QA simulator UUID");
let registration: any = null;
let receipts: any[] = [];
let alerts: any[] = [];
let observations: any[] = [];
let reads: Record<string, any> = {};
let cursor = 1, badgeCount = 0, unavailable = false;
let failRegistration = 0, registrationDelay = 0, failUnregister = 0;
let readFailures = 0, readDelayMs = 0, lostReadResponses = 0, offline = false;
let snapshotDelayMs = 0;
let fixtureEpoch = 0;
let presence: any[] = [], smartEnabled = true;
const routing = () => ({ smartEnabled, serverTime: Date.now(), iosActiveUntil: 0, macActiveUntil: 0 });
const reply = (value: unknown, status = 200) => Response.json(value, { status });
async function notifyClients() {
  // Production notification creation and read acknowledgement both publish an
  // event. Wake the same polling path as the server, independently of APNs.
  const response = await fetch(upstream + "/__qa/control", { method: "POST", body: "{}" });
  if (!response.ok) throw new Error("QA notification event failed");
}
function unreadAlertCount() {
  const unread = new Set<string>();
  for (const alert of alerts) {
    const marker = reads[alert.channelId];
    const acknowledged = marker && (alert.kind === "reaction"
      ? BigInt(alert.notificationSequence) <= BigInt(marker.lastReadNotificationSequence)
      : BigInt(alert.messageSequence) <= BigInt(marker.lastReadSequence));
    if (!acknowledged) unread.add(`${alert.channelId}:${alert.kind}:${alert.notificationSequence}`);
  }
  return unread.size;
}
async function inject(value: any) {
  if (!registration) throw new Error("The native app has not registered");
  const data = { schemaVersion: 1, notificationScope: registration.notificationScope, ...value };
  const background = value.kind === "badge-sync";
  // Some simulator runtimes reject silent pushes even with a badge. Report that
  // capability separately from a cleanup failure; never replace it with an alert.
  const payload = {
  aps: background ? { "content-available": 1, badge: badgeCount } : { alert: { title: "OpenTeam Push QA", body: value.qaID }, badge: value.badgeOverride ?? badgeCount, "content-available": 1, "mutable-content": 1, "thread-id": value.channelId }, data };
  const process = Bun.spawn(["xcrun", "simctl", "push", udid!, "dev.openteam.mobile.swift", "-"], { stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe" });
  const result = await process.exited;
  if (result) {
    const failure = await new Response(process.stderr).text();
    if (background && failure.includes("No content that needs to alert")) return false;
    throw new Error(failure);
  }
  return true;
}
Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 40, async fetch(request) {
  const url = new URL(request.url), path = url.pathname;
  const text = request.method === "GET" ? "" : await request.text();
  const body = text ? JSON.parse(text) : {};
  const epoch = fixtureEpoch;
  if (path === "/__push/reset") {
    fixtureEpoch++;
    presence = []; smartEnabled = true;
    registration = null; receipts = []; alerts = []; observations = []; reads = {}; cursor++; badgeCount = 0; unavailable = false; failRegistration = 0; registrationDelay = 0; failUnregister = 0;
    readFailures = 0; readDelayMs = 0; lostReadResponses = 0; offline = false;
    snapshotDelayMs = 0;
    await fetch(upstream + "/__qa/reset", { method: "POST", body: "{}" });
    return reply({ ok: true });
  }
  if (path === "/__push/state") return reply({ registration, receipts, observations, reads, badgeCount, presence, smartEnabled });
  if (path === "/api/v0/notification-presence" && request.method === "POST") {
    presence.push(body); return reply(routing());
  }
  if (path === "/api/v0/notification-preferences") {
    if (request.method === "PATCH") smartEnabled = body.smartEnabled;
    return reply(routing());
  }
  if (path === "/__push/observation") { observations.push(body); return reply({ok: true}); }
  if (path === "/__push/control") {
    unavailable = body.unavailable ?? unavailable;
    failRegistration = body.failRegistration ?? failRegistration;
    registrationDelay = body.registrationDelay ?? registrationDelay;
    failUnregister = body.failUnregister ?? failUnregister;
    readFailures = body.readFailures ?? readFailures;
    readDelayMs = body.readDelayMs ?? readDelayMs;
    lostReadResponses = body.lostReadResponses ?? lostReadResponses;
    offline = body.offline ?? offline;
    snapshotDelayMs = body.snapshotDelayMs ?? snapshotDelayMs;
    return reply({ok:true});
  }
  if (path === "/__push/deliver") {
    alerts.push(body);
    badgeCount = unreadAlertCount();
    await notifyClients();
    await inject({ ...body, botId: "fixture-bot", sender: { name: "Our robot", icon: "chip", color: "#ff6600" } });
    return reply({ok:true});
  }
  if (path === "/__push/read") {
    for (const read of body.readStates ?? []) reads[read.channelId] = read;
    cursor++;
    badgeCount = body.badgeCount;
    await notifyClients();
    const supported = body.notify === false || await inject({kind:"badge-sync", readState: body.readStates?.at(-1), probe:body.probe});
    return reply({ok:true,simulatorUnsupported:!supported});
  }
  if (path === "/__push/probe") {
    const supported = await inject({kind:"badge-sync", probe:body.probe, readState:body.readState});
    return reply({ok:true,simulatorUnsupported:!supported});
  }
  if (offline && path.startsWith("/api/")) return reply({message:"QA network outage"},503);
  if (path === "/api/v0/notification-devices" && request.method === "POST") {
    receipts.push({method:request.method, path, ...body});
    if (registrationDelay) await Bun.sleep(registrationDelay);
    if (epoch !== fixtureEpoch) return reply({message:"QA session reset"},503);
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
    const snapshot = {cursor:String(cursor),badgeCount,readStates:Object.values(reads),notificationRouting:routing()};
    if (snapshotDelayMs) await Bun.sleep(snapshotDelayMs);
    return reply(snapshot);
  }
  const isRead = path.endsWith("/read") && request.method === "POST";
  if (isRead) {
    receipts.push({method:request.method,path,...body});
    if (readFailures > 0) {
      readFailures--;
      return reply({message:"QA read unavailable"},503);
    }
    if (readDelayMs) await Bun.sleep(readDelayMs);
    if (epoch !== fixtureEpoch) return reply({message:"QA session reset"},503);
  }
  const response = await fetch(upstream + path + url.search, {method:request.method, headers:request.headers, body: text || undefined});
  if (epoch !== fixtureEpoch) return reply({message:"QA session reset"},503);
  if (path === "/api/v0/client-bootstrap" && response.ok) {
    const value: any = await response.json();
    value.channels = value.channels.map((c: any) => {
      const notificationCursor = alerts.filter(alert => alert.channelId === c.id)
        .reduce((latest, alert) => BigInt(alert.notificationSequence) > latest ? BigInt(alert.notificationSequence) : latest, 123n);
      return {...c, notificationState:{channelId:c.id,lastReadSequence:"0",lastReadNotificationSequence:"0",notificationCursor:String(notificationCursor), ...reads[c.id]}};
    });
    return reply(value);
  }
  if (path.endsWith("/read") && request.method === "POST" && response.ok) {
    const value: any = await response.json();
    const channelId = path.split("/")[4];
    const previous = reads[channelId];
    reads[channelId] = {
      channelId,
      lastReadSequence: String(BigInt(body.throughSequence ?? "0") > BigInt(previous?.lastReadSequence ?? "0")
        ? body.throughSequence : previous?.lastReadSequence ?? "0"),
      lastReadNotificationSequence: String(BigInt(body.throughNotificationSequence ?? "0") > BigInt(previous?.lastReadNotificationSequence ?? "0")
        ? body.throughNotificationSequence : previous?.lastReadNotificationSequence ?? "0"),
    };
    cursor++;
    badgeCount = unreadAlertCount();
    await notifyClients();
    if (lostReadResponses > 0) {
      lostReadResponses--;
      return reply({message:"QA acknowledgement lost after committing read"},503);
    }
    return reply({ ...value, ...reads[channelId] });
  }
  return response;
} });
console.log(`Native push QA: http://127.0.0.1:${port}`);
