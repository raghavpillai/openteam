import assert from "node:assert/strict";
import { resolve } from "node:path";

// Run with OPENTEAM_TEST_COMPUTER_IMAGE and OPENTEAM_TEST_DOCKER_CONTEXT.
// No host ports, accounts or host mounts are used.
const image = process.env.OPENTEAM_TEST_COMPUTER_IMAGE;
if (!image) throw new Error("Set OPENTEAM_TEST_COMPUTER_IMAGE to a built computer image");
const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT;
if (!context)
  throw new Error("Set OPENTEAM_TEST_DOCKER_CONTEXT to a disposable Linux Docker context");
const policySource =
  process.env.OPENTEAM_TEST_NETWORK_POLICY ??
  resolve(import.meta.dir, "../docker/openteam-computer-network.py");
const gatewayPort = Number(process.env.OPENTEAM_TEST_GATEWAY_PORT ?? 8790);
assert(Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort <= 65535);
const prefix = "openteam-bootstrap-" + crypto.randomUUID().slice(0, 8);
const computer = prefix + "-computer";
const peer = prefix + "-peer";
const token = "bootstrap-network-synthetic-test-only";
const dockerPrefix = ["docker", ...(context ? ["--context", context] : [])];
const commands: string[][] = [];
async function docker(args: string[], optional = false): Promise<string> {
  commands.push(args);
  const child = Bun.spawn([...dockerPrefix, ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code: number, stdout: string, stderr: string;
  try {
    [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (code && !optional) throw new Error("docker " + args[0] + " failed: " + stderr);
  return code ? "" : stdout.trim();
}
const peerCode = [
  "let requests=0;",
  "const handler=req=>{const p=new URL(req.url).pathname;if(p==='/reset')requests=0;else if(p!=='/count')requests++;return Response.json({requests})};",
  "Bun.serve({hostname:'0.0.0.0',port:8888,fetch:handler});",
  "Bun.serve({hostname:'::',port:8889,fetch:handler});",
].join("\n");
const viewerCode = "Bun.serve({hostname:'::',port:6207,fetch:()=>new Response('viewer')});";
async function probe(container: string, url: string) {
  const code =
    "try{const r=await fetch(process.env.PROBE_URL,{headers:{authorization:'Bearer '+process.env.PROBE_TOKEN},signal:AbortSignal.timeout(1800)});console.log(JSON.stringify({status:r.status,body:await r.text()}))}catch(e){console.log(JSON.stringify({error:e.name}))}";
  return JSON.parse(
    await docker([
      "exec",
      "--user",
      "1000:1000",
      "-e",
      "PROBE_URL=" + url,
      "-e",
      "PROBE_TOKEN=" + token,
      container,
      "bun",
      "-e",
      code,
    ])
  ) as { status?: number; body?: string; error?: string };
}
const results: Record<string, unknown> = {};
let networkCreated = false;
try {
  const suffix = crypto.randomUUID().slice(0, 4);
  await docker([
    "network",
    "create",
    "--ipv6",
    "--subnet",
    "fd42:6f70:" + suffix + "::/64",
    prefix,
  ]);
  networkCreated = true;
  await docker([
    "run",
    "-d",
    "--name",
    peer,
    "--network",
    prefix,
    "--cap-add",
    "NET_ADMIN",
    "--entrypoint",
    "bun",
    image,
    "-e",
    peerCode,
  ]);
  await docker([
    "create",
    "--name",
    computer,
    "--network",
    prefix,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--cap-add",
    "ALL",
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "apparmor=unconfined",
    "--security-opt",
    "label=disable",
    "--security-opt",
    "systempaths=unconfined",
    "--device",
    "/dev/net/tun:/dev/net/tun",
    "-e",
    "OPENTEAM_CONTROL_TOKEN=" + token,
    "-e",
    "OPENTEAM_COMPUTER_PORT=" + gatewayPort,
    "-e",
    "OPENTEAM_SERVER_URL=http://bootstrap-server:8787",
    image,
  ]);
  // Exercise the checked-out policy with a real production gateway/runtime.
  await docker([
    "cp",
    policySource,
    computer + ":/usr/lib/openteam/bin/openteam-computer-network.py",
  ]);
  await docker(["start", computer]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if ((await probe(computer, "http://127.0.0.1:" + gatewayPort + "/health")).status === 200) {
      ready = true;
      break;
    }
    await Bun.sleep(500);
  }
  assert(ready, "production gateway must be ready on loopback");
  const policyDigest = await Bun.file(policySource)
    .arrayBuffer()
    .then((bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  assert.equal(
    (
      await docker([
        "exec",
        computer,
        "sha256sum",
        "/usr/lib/openteam/bin/openteam-computer-network.py",
      ])
    ).split(/\s+/)[0],
    policyDigest,
    "the active policy must match checked-out source"
  );
  const info = (name: string) =>
    docker(["inspect", name]).then((s) => JSON.parse(s)[0].NetworkSettings.Networks[prefix]);
  const [c, p] = await Promise.all([info(computer), info(peer)]);
  assert(c.IPAddress && c.GlobalIPv6Address && p.IPAddress && p.GlobalIPv6Address);
  await docker(["exec", "--user", "0", peer, "ip", "addr", "add", "198.51.100.9/32", "dev", "lo"]);
  await docker([
    "exec",
    "--user",
    "0",
    peer,
    "ip",
    "-6",
    "addr",
    "add",
    "2001:db8:17::9/128",
    "dev",
    "lo",
  ]);
  await docker([
    "exec",
    "--user",
    "0",
    computer,
    "ip",
    "route",
    "add",
    "198.51.100.9/32",
    "via",
    p.IPAddress,
    "dev",
    "eth0",
  ]);
  await docker([
    "exec",
    "--user",
    "0",
    computer,
    "ip",
    "-6",
    "route",
    "add",
    "2001:db8:17::9/128",
    "via",
    p.GlobalIPv6Address,
    "dev",
    "eth0",
  ]);
  await docker(["exec", "-d", "--user", "1000:1000", computer, "bun", "-e", viewerCode]);
  await Bun.sleep(300);
  results.loopbackDirectory = await probe(
    computer,
    "http://127.0.0.1:" + gatewayPort + "/v1/agent-stores"
  );
  results.peerHealth = await probe(
    peer,
    "http://" + c.IPAddress + ":" + gatewayPort + "/health/authenticated"
  );
  results.peerDirectory = await probe(
    peer,
    "http://" + c.IPAddress + ":" + gatewayPort + "/v1/agent-stores"
  );
  results.viewerIPv4 = await probe(peer, "http://" + c.IPAddress + ":6207/");
  results.viewerIPv6 = await probe(peer, "http://[" + c.GlobalIPv6Address + "]:6207/");
  results.replyRoute = await docker(
    [
      "exec",
      computer,
      "ip",
      "route",
      "get",
      p.IPAddress,
      "ipproto",
      "tcp",
      "sport",
      String(gatewayPort),
      "dport",
      "45000",
    ],
    true
  );
  // Calibrate the owned TEST-NET sentinels through the existing trusted mark.
  // This proves reachability without removing either fail-closed guard.
  const calibrated =
    "import socket\nfor family,address,port in [(socket.AF_INET,'198.51.100.9',8888),(socket.AF_INET6,'2001:db8:17::9',8889)]:\n s=socket.socket(family,socket.SOCK_STREAM);s.settimeout(2);s.setsockopt(socket.SOL_SOCKET,socket.SO_MARK,0x4f54);s.connect((address,port));s.sendall(b'GET / HTTP/1.0\\r\\nHost: synthetic\\r\\n\\r\\n');assert b'200' in s.recv(512);s.close()\nprint('marked sentinels reachable')";
  results.sentinelCalibration = await docker([
    "exec",
    "--user",
    "0",
    computer,
    "python3",
    "-c",
    calibrated,
  ]);
  await probe(peer, "http://127.0.0.1:8888/reset");
  results.ordinaryIPv4 = await probe(computer, "http://198.51.100.9:8888/");
  results.ordinaryIPv6 = await probe(computer, "http://[2001:db8:17::9]:8889/");

  const sourcePortProbe =
    "import socket,json\nresults=[]\nfor family,address,port in [(socket.AF_INET,'198.51.100.9',8888),(socket.AF_INET6,'2001:db8:17::9',8889)]:\n s=socket.socket(family,socket.SOCK_STREAM);s.settimeout(2);s.bind(('0.0.0.0' if family==socket.AF_INET else '::',6208))\n try:\n  s.connect((address,port));results.append('connected')\n except OSError as e:results.append(e.__class__.__name__)\n finally:s.close()\nassert 'connected' not in results\nprint(json.dumps(results))";
  results.ordinaryFromViewerPort = JSON.parse(
    await docker(["exec", "--user", "1000:1000", computer, "python3", "-c", sourcePortProbe])
  );

  results.sentinelCount = JSON.parse(
    (await probe(peer, "http://127.0.0.1:8888/count")).body!
  ).requests;
  await docker([
    "exec",
    "--user",
    "0",
    computer,
    "python3",
    "-I",
    "-S",
    "/usr/lib/openteam/bin/openteam-computer-network.py",
    "http://bootstrap-server:8787",
  ]);
  const replyRuleCounts: number[] = [];
  for (const family of ["-4", "-6"]) {
    const rules = JSON.parse(await docker(["exec", computer, "ip", family, "-j", "rule", "show"]));
    replyRuleCounts.push(rules.filter((r: { priority: number }) => r.priority === 96).length);
    replyRuleCounts.push(rules.filter((r: { priority: number }) => r.priority === 97).length);
  }
  results.replyRuleCounts = replyRuleCounts;
  results.peerAfterReapply = await probe(
    peer,
    "http://" + c.IPAddress + ":" + gatewayPort + "/v1/agent-stores"
  );
  await docker(["exec", "--user", "0", computer, "ip", "link", "del", "openteam0"]);
  results.peerAfterTunRemoval = await probe(
    peer,
    "http://" + c.IPAddress + ":" + gatewayPort + "/v1/agent-stores"
  );
  results.viewerAfterTunRemoval = await probe(peer, "http://[" + c.GlobalIPv6Address + "]:6207/");
  console.log(JSON.stringify({ image, context, results, commands }, null, 2));
  for (const key of [
    "loopbackDirectory",
    "peerHealth",
    "peerDirectory",
    "viewerIPv4",
    "viewerIPv6",
    "peerAfterReapply",
    "peerAfterTunRemoval",
    "viewerAfterTunRemoval",
  ]) {
    assert.equal(
      (results[key] as { status?: number }).status,
      200,
      key + " must remain reachable before any exit lease"
    );
  }
  assert.notEqual(
    (results.ordinaryIPv4 as { status?: number }).status,
    200,
    "ordinary IPv4 stays blocked"
  );
  assert.notEqual(
    (results.ordinaryIPv6 as { status?: number }).status,
    200,
    "ordinary IPv6 stays blocked"
  );
  assert.deepEqual(
    results.replyRuleCounts,
    [1, 1, 1, 1],
    "one API/viewer rule per family after reapplying policy"
  );
  assert.equal(results.sentinelCount, 0, "no ordinary traffic may reach the calibrated sentinels");
  console.log(
    "PASS: bootstrap API/viewer replies, both families, TUN loss and fail-closed ordinary traffic"
  );
} finally {
  await docker(["rm", "--force", computer, peer], true);
  if (networkCreated) await docker(["network", "rm", prefix], true);
}
