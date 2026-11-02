import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Node egress checks use routed TLS, fence stale results, bound responses and cache success/failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openteam-egress-test-"));
  try {
    const cert = join(directory, "cert.pem"),
      key = join(directory, "key.pem");
    const openssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=ipwho.is",
        "-addext",
        "subjectAltName=DNS:ipwho.is",
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    expect(await openssl.exited).toBe(0);
    const entry = join(directory, "runner.ts"),
      output = join(directory, "runner.mjs");
    await writeFile(
      entry,
      `
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createEgressProbe, parseEgress } from ${JSON.stringify(resolve("apps/computer/src/browser-network-egress.ts"))};
let checks = 0, calls = 0, requests = 0, sni = "", behavior = "ok", held;
const server = createServer({ cert: readFileSync(${JSON.stringify(cert)}), key: readFileSync(${JSON.stringify(key)}) }, (req, res) => {
  requests++;
  assert.equal(req.url, "/?fields=success,ip,city,country");
  assert.equal(req.headers.host, "ipwho.is");
  const finish = () => {
    if (behavior === "redirect") { res.writeHead(302, {location:"https://must-not-follow.invalid"}); res.end(); return; }
    if (behavior === "failure") { res.writeHead(429, {"content-type":"application/json"}); res.end('{}'); return; }
    res.writeHead(200, {"content-type": behavior === "html" ? "text/html" : "application/json"});
    res.end(behavior === "huge" ? "x".repeat(8193) : behavior === "invalid" ? '{"success":true,"ip":"invalid"}' : JSON.stringify({success:true,ip:"203.0.113.10",city:"Example City",country:"Example Country"}));
  };
  if (behavior === "hold") held = finish; else finish();
});
server.on("secureConnection", socket => { sni = socket.servername; });
await new Promise(r => server.listen(0,"127.0.0.1",r));
const port = server.address().port;
const route = { epoch:"first", mode:"device", machineId:"air", available:true };
const client = { route, available: () => true, open: async (host, portValue) => {
  calls++; assert.equal(host,"ipwho.is"); assert.equal(portValue,443);
  return createConnection({host:"127.0.0.1",port});
}};
try {
  const probe = createEgressProbe(client);
  const [a,b] = await Promise.all([probe(),probe()]);
  assert.deepEqual(a,b); assert.equal(calls,1); assert.equal(requests,1); assert.equal(sni,"ipwho.is");
  assert.equal(a.ip,"203.0.113.10"); assert.equal(a.location,"Example City, Example Country"); assert.equal(a.sourceId,"air"); checks += 8;
  await probe(); assert.equal(calls,1); checks++;
  route.epoch = "second"; route.mode = "server"; route.machineId = null;
  assert.equal((await probe()).sourceId,"server"); assert.equal(calls,2); checks += 2;
  const off = createEgressProbe({...client, available:()=>false});
  await assert.rejects(off,/Could not check/); assert.equal(calls,2); checks += 2;
  for (const mode of ["redirect","failure","html","huge","invalid"]) {
    behavior = mode; route.epoch = mode;
    const bad = createEgressProbe(client); const before = calls;
    await assert.rejects(bad,/Could not check/); await assert.rejects(bad,/Could not check/);
    assert.equal(calls,before+1); checks += 3;
  }
  behavior = "hold"; route.epoch = "before-change";
  const stale = createEgressProbe(client)();
  while(!held) await new Promise(r=>setTimeout(r,5));
  route.epoch = "after-change"; held();
  await assert.rejects(stale,/Could not check/); checks++;
  behavior="ok";
  assert.throws(()=>parseEgress('{"success":false,"ip":"203.0.113.10"}')); checks++;
  assert.equal(parseEgress('{"success":true,"ip":"2001:db8::1","city":"Bad\\\\nCity","country":"Example"}').location.includes("\\n"),false); checks++;
  let late; let destroyed = false;
  const hanging = createEgressProbe({...client, open:()=>new Promise(r=>{late=r;})});
  await assert.rejects(hanging,/Could not check/); checks++;
  late({destroy(){destroyed=true;}}); await new Promise(r=>setTimeout(r,20));
  assert.equal(destroyed,true); checks++;
  console.log(JSON.stringify({checks}));
} finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
`
    );
    const build = Bun.spawn(
      [process.execPath, "build", entry, "--target", "node", "--outfile", output],
      { stdout: "ignore", stderr: "inherit" }
    );
    expect(await build.exited).toBe(0);
    const runner = Bun.spawn(["node", output], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
