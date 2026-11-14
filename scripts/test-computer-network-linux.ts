// Disposable containers only. No host network, host filesystem mounts, app
// credentials, published ports, or changes to the active Docker context.
import { mkdtemp, rm, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT;
if (!context)
  throw new Error("Set OPENTEAM_TEST_DOCKER_CONTEXT to a disposable Linux Docker context");
const prefix = `openteam-egress-${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), prefix));
const containers: string[] = [];
const network = `${prefix}-net`;
let networkCreated = false;
const docker = (...args: string[]) => ["docker", "--context", context, ...args];
async function run(args: string[], input?: string, required = true): Promise<string> {
  const proc = Bun.spawn(args, {
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 300_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (required && code) throw new Error(`${args.slice(0, 5).join(" ")}: ${err || out}`);
  return out.trim();
}
const exec = (...args: string[]) => run(docker("exec", `${prefix}-computer`, ...args));
const expectBlocked = async (...args: string[]) => {
  const output = await exec(
    "sh",
    "-c",
    'if "$@" >/dev/null 2>&1; then echo BYPASSED; else echo BLOCKED; fi',
    "sh",
    ...args
  );
  assert.equal(output, "BLOCKED");
};
const checks: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
try {
  const build = await Bun.build({
    entrypoints: [resolve("scripts/computer-network-linux/fixture.ts")],
    target: "node",
    outdir: directory,
    naming: "fixture.mjs",
  });
  if (!build.success) throw new Error(String(build.logs));
  for (const file of ["openteam-network-mark.c", "openteam-computer-network.py"])
    await cp(resolve("docker", file), join(directory, file));
  console.log("Building pinned TUN implementation");
  // Export only the pinned binary. Exporting the entire Go build image makes
  // repeated local runs spend their deadline unpacking the compiler toolchain.
  const toolsDockerfile = join(directory, "network-tools.Dockerfile");
  await writeFile(toolsDockerfile, (await readFile(resolve("docker/computer.Dockerfile"), "utf8")) + `
FROM scratch AS network-test-tools
COPY --from=network-tools /tun2socks /tun2socks
CMD ["/tun2socks"]
`);
  await run(
    docker(
      "build",
      "--target",
      "network-test-tools",
      "-f",
      toolsDockerfile,
      "-t",
      `${prefix}-tools`,
      "."
    )
  );
  containers.push(`${prefix}-tools`);
  await run(docker("create", "--name", `${prefix}-tools`, `${prefix}-tools`));
  await run(docker("cp", `${prefix}-tools:/tun2socks`, join(directory, "tun2socks")));
  await writeFile(
    join(directory, "Dockerfile"),
    `
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update && apt-get install -y --no-install-recommends nodejs python3 iproute2 nftables curl gcc libc6-dev sudo ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . /fixture/
RUN mkdir -p /usr/lib/openteam/bin && cp /fixture/openteam-computer-network.py /usr/lib/openteam/bin/
RUN gcc -shared -fPIC -Wall -Wextra -Werror /fixture/openteam-network-mark.c -o /fixture/network-mark.so && useradd -m -u 1000 box && echo 'box ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/box
CMD ["sleep", "600"]
`
  );
  console.log("Building disposable enforcement fixture");
  await run(docker("build", "-t", `${prefix}-fixture`, directory));
  const subnet = 30 + Math.floor(Math.random() * 180);
  await run(
    docker(
      "network",
      "create",
      "--ipv6",
      "--subnet",
      `10.247.${subnet}.0/24`,
      "--subnet",
      `fd74:${subnet}::/64`,
      network
    )
  );
  networkCreated = true;
  const targetIp = `10.247.${subnet}.2`,
    targetV6 = `fd74:${subnet}::2`;
  containers.push(`${prefix}-target`, `${prefix}-computer`);
  await run(
    docker(
      "run",
      "-d",
      "--name",
      `${prefix}-target`,
      "--network",
      network,
      "--ip",
      targetIp,
      "--ip6",
      targetV6,
      `${prefix}-fixture`,
      "node",
      "/fixture/fixture.mjs",
      "target"
    )
  );
  await run(
    docker(
      "run",
      "-d",
      "--name",
      `${prefix}-computer`,
      "--network",
      network,
      "--privileged",
      "-e",
      `TARGET_IP=${targetIp}`,
      `${prefix}-fixture`
    )
  );
  await check("fresh computer boots before management DNS/server exists", async () => {
    await exec("python3", "/fixture/openteam-computer-network.py", "http://future-server:8787");
    assert.equal(await exec("cat", "/run/openteam-management.json"), "[]");
    for (const device of ["all", "default", "eth0", "openteam0"])
      assert.equal(await exec("cat", `/proc/sys/net/ipv4/conf/${device}/rp_filter`), "0", `bootstrap relay replies survive on ${device}`);
  });
  await run(
    docker(
      "exec",
      "-d",
      "-e",
      "LD_PRELOAD=/fixture/network-mark.so",
      `${prefix}-computer`,
      "node",
      "/fixture/fixture.mjs",
      "discovery"
    )
  );
  await check(
    "missing server leaves management discovery waiting without weakening routing",
    async () => {
      await Bun.sleep(300);
      assert.equal(
        await exec("sh", "-c", "test -f /run/discovery-started && echo started || echo waiting"),
        "waiting"
      );
    }
  );
  const futureName = `${prefix}-future`;
  containers.push(futureName);
  const launchFuture = (ip: string) =>
    run(
      docker(
        "run",
        "-d",
        "--name",
        futureName,
        "--network",
        network,
        "--network-alias",
        "future-server",
        "--ip",
        ip,
        `${prefix}-fixture`,
        "node",
        "/fixture/fixture.mjs",
        "target"
      )
    );
  const discovered = async (ip: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.parse(await exec("cat", "/run/openteam-management.json")).includes(ip)) return;
      await Bun.sleep(100);
    }
    throw new Error("Management discovery did not publish the current server address");
  };
  await check("management becomes reachable after its server starts", async () => {
    await launchFuture(`10.247.${subnet}.10`);
    await discovered(`10.247.${subnet}.10`);
    assert.equal(
      await exec("curl", "-fsS", "--max-time", "3", "http://future-server:8787"),
      "management-reachable"
    );
  });
  await check("management DNS and routes refresh after server address changes", async () => {
    await run(docker("rm", "-f", futureName));
    await launchFuture(`10.247.${subnet}.11`);
    await discovered(`10.247.${subnet}.11`);
    assert.ok(
      !JSON.parse(await exec("cat", "/run/openteam-management.json")).includes(
        `10.247.${subnet}.10`
      )
    );
    assert.equal(
      await exec("curl", "-fsS", "--max-time", "3", "http://future-server:8787"),
      "management-reachable"
    );
  });
  await exec(
    "python3",
    "-c",
    `import os,signal
for p in os.listdir('/proc'):
 if not p.isdigit(): continue
 try: args=open('/proc/'+p+'/cmdline','rb').read().split(bytes([0]))
 except OSError: continue
 if len(args)>2 and args[1]==b'/fixture/fixture.mjs' and args[2]==b'discovery': os.kill(int(p),signal.SIGTERM)`
  );
  await Bun.sleep(200);
  await exec("python3", "/fixture/openteam-computer-network.py", `http://${targetIp}:8787`);
  const curl = ["curl", "--noproxy", "*", "-fsS", "--connect-timeout", "2", "--max-time", "4"];
  await check("startup blocks direct egress before any relay exists", () =>
    expectBlocked(...curl, `http://${targetIp}:8080`)
  );
  await check("management remains reachable while blocked", async () => {
    assert.equal(await exec(...curl, `http://${targetIp}:8787`), "management-reachable");
  });
  await run(
    docker(
      "exec",
      "-d",
      "-e",
      "LD_PRELOAD=/fixture/network-mark.so",
      `${prefix}-computer`,
      "node",
      "/fixture/fixture.mjs",
      "relay"
    )
  );
  await run(
    docker(
      "exec",
      "-d",
      `${prefix}-computer`,
      "/fixture/tun2socks",
      "--device",
      "tun://openteam0",
      "--proxy",
      "socks5://127.0.0.1:18791",
      "--loglevel",
      "error"
    )
  );
  await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: true, ipv6: true }));
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await exec("sh", "-c", "test -f /run/relay-count && echo yes || true")) === "yes") break;
    await run(
      docker("exec", `${prefix}-computer`, ...curl, `http://${targetIp}:8080`),
      undefined,
      false
    );
    await Bun.sleep(100);
  }
  await check("root applications use the relay", async () => {
    const before = Number(await exec("cat", "/run/relay-count"));
    assert.equal(await exec(...curl, `http://${targetIp}:8080`), "target-via-selected-route");
    assert.ok(Number(await exec("cat", "/run/relay-count")) > before);
  });
  await check("real upstream TCP reset crosses the TUN, retains its diagnostic, and permits a fresh read", async () => {
    const failure = await exec("python3", "-c", `import socket,errno
s=socket.create_connection(('${targetIp}',8080),timeout=4)
try:
 s.sendall(b'POST /reset HTTP/1.1\\r\\nHost: fixture\\r\\nContent-Length: 0\\r\\n\\r\\n')
 assert s.recv(1)==b''
 print('end-of-stream')
except ConnectionResetError as error:
 assert error.errno==errno.ECONNRESET
 print('connection-reset-by-peer')
finally: s.close()`);
    // tun2socks may translate an established upstream reset into EOF. The relay must
    // retain the original code regardless of the application's visible close form.
    assert.ok(["connection-reset-by-peer", "end-of-stream"].includes(failure));
    const events = (await exec("cat", "/run/relay-events.jsonl")).split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "computer_network.proxy_socket_error" &&
      event.side === "upstream" && event.code === "ECONNRESET" && event.address === targetIp && event.port === 8080));
    assert.equal(await exec(...curl, `http://${targetIp}:8080`), "target-via-selected-route");
  });
  await check("local proxy capacity reproduces connection-reset-by-peer through the TUN and recovers", async () => {
    const failure = await exec("python3", "-c", `import socket,select,errno
sockets=[]
try:
 for _ in range(85):
  s=socket.create_connection(('${targetIp}',8080),timeout=4);sockets.append(s)
  try: s.sendall(b'GET / HTTP/1.1\\r\\nHost: fixture\\r\\n')
  except ConnectionResetError: pass
 ready,_,_=select.select(sockets,[],[],4)
 resets=0
 for s in ready:
  try: s.recv(1)
  except ConnectionResetError as error:
   assert error.errno==errno.ECONNRESET;resets+=1
 assert resets>0,'expected virtual TCP reset after local capacity rejection'
 print('connection-reset-by-peer')
finally:
 for s in sockets: s.close()`);
    assert.equal(failure, "connection-reset-by-peer");
    const events = (await exec("cat", "/run/relay-events.jsonl")).split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "computer_network.proxy_capacity" && event.limit === 80));
    assert.equal(await exec(...curl, `http://${targetIp}:8080`), "target-via-selected-route");
  });
  await check("ordinary desktop user and sudo descendants use the same route", async () => {
    for (const command of [curl, ["sudo", ...curl]])
      assert.equal(
        await exec(
          "setpriv",
          "--reuid",
          "1000",
          "--regid",
          "1000",
          "--init-groups",
          ...command,
          `http://${targetIp}:8080`
        ),
        "target-via-selected-route"
      );
  });
  await check("ordinary DNS works without a proxy setting", async () => {
    assert.equal(
      await exec(...curl, "http://egress-fixture.test:8080"),
      "target-via-selected-route"
    );
  });
  await check("hardcoded UDP and TCP DNS resolvers are redirected", async () => {
    const script = `import socket,struct
q=struct.pack('!6H',123,256,1,0,0,0)+b'\\x06egress\\x07fixture\\x04test\\0'+struct.pack('!2H',1,1)
for tcp in [False,True]:
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM);s.settimeout(3);s.connect(('8.8.8.8',53));s.sendall(struct.pack('!H',len(q))+q if tcp else q);r=s.recv(4096);assert (r[2:4] if tcp else r[:2])==q[:2];s.close()
print('dns-ok')`;
    assert.equal(await exec("python3", "-c", script), "dns-ok");
  });
  await check("IPv6 TCP uses the relay", async () => {
    const before = Number(await exec("cat", "/run/relay-count"));
    assert.equal(await exec(...curl, `http://[${targetV6}]:8080`), "target-via-selected-route");
    assert.ok(Number(await exec("cat", "/run/relay-count")) > before);
  });
  await check("healthy IPv4 connections survive IPv6 capability changes", async () => {
    assert.equal(await exec("python3", "-c", `import http.client,subprocess,json
connection=http.client.HTTPConnection('${targetIp}',8080,timeout=3)
connection.request('GET','/');assert connection.getresponse().read()==b'target-via-selected-route'
socket=connection.sock;assert socket is not None
subprocess.run(['python3','/fixture/openteam-computer-network.py','--families',json.dumps({'ipv4':True,'ipv6':False})],check=True)
connection.request('GET','/');assert connection.getresponse().read()==b'target-via-selected-route'
assert connection.sock is socket
connection.close()
subprocess.run(['python3','/fixture/openteam-computer-network.py','--families',json.dumps({'ipv4':True,'ipv6':True})],check=True)
print('same-healthy-connection')`), "same-healthy-connection");
  });
  await check("reproduces optimistic TUN success followed by reset on an IPv6-incapable exit", async () => {
    await exec("touch", "/run/reject-ipv6");
    assert.equal(await exec("python3", "-c", `import socket
s=socket.socket(socket.AF_INET6,socket.SOCK_STREAM);s.settimeout(3)
s.connect(('${targetV6}',8080))
try:
 s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n');data=s.recv(100)
 assert not data,data
except (ConnectionResetError,BrokenPipeError): pass
finally:s.close()
print('virtual-success-upstream-failed')`), "virtual-success-upstream-failed");
  });
  await check("IPv4-only exit rejects IPv6 before a virtual TCP handshake, including cached literals", async () => {
    await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: true, ipv6: false }));
    const before = Number(await exec("cat", "/run/relay-count"));
    assert.equal(await exec("python3", "-c", `import socket,time,errno
s=socket.socket(socket.AF_INET6,socket.SOCK_STREAM);s.settimeout(2);start=time.monotonic()
try:
 s.connect(('${targetV6}',8080));raise SystemExit('unexpected virtual success')
except OSError as e:
 assert e.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH),e
 assert time.monotonic()-start<0.5
 print('fast-unreachable')
finally:s.close()`), "fast-unreachable");
    assert.equal(Number(await exec("cat", "/run/relay-count")), before, "unsupported family never entered the proxy");
    assert.equal(await exec(...curl, `http://${targetIp}:8080`), "target-via-selected-route");
    await expectBlocked(...curl, "--interface", "eth0", `http://[${targetV6}]:8080`);
    const table = await exec("ip", "-6", "route", "show", "table", "18791");
    assert.match(table, /unreachable default/);
    assert.doesNotMatch(table, /default dev openteam0/);
  });
  await check("restored IPv6 works without a browser or tunnel restart", async () => {
    await exec("rm", "/run/reject-ipv6");
    await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: true, ipv6: true }));
    assert.equal(await exec(...curl, `http://[${targetV6}]:8080`), "target-via-selected-route");
  });
  await check("IPv6-only capabilities block IPv4 without leaking to the underlay", async () => {
    await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: false, ipv6: true }));
    await expectBlocked(...curl, `http://${targetIp}:8080`);
    assert.equal(await exec(...curl, `http://[${targetV6}]:8080`), "target-via-selected-route");
    assert.equal(await exec(...curl, `http://${targetIp}:8787`), "management-reachable");
    await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: true, ipv6: true }));
  });
  if (process.argv.includes("--internet")) {
    await run(docker("exec", "-d", "-e", "LD_PRELOAD=/fixture/network-mark.so", `${prefix}-computer`, "node", "/fixture/fixture.mjs", "capabilities"));
    const health = async () => JSON.parse(await exec("cat", "/run/family-health.json"));
    const waitHealth = async (state: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const value = await health(); if (value.ipv4.state === state && value.ipv6.state === "unavailable") return value; } catch {}
        await Bun.sleep(200);
      }
      throw new Error(`Production capability monitor did not reach ${state}`);
    };
    await check("production monitor verifies IPv4 TLS through the real TUN and blocks unsupported IPv6", async () => {
      const value = await waitHealth("working");
      assert.equal(value.sourceId, "local-fixture");
      assert.match(await exec("ip", "-6", "route", "show", "table", "18791"), /unreachable default/);
      assert.doesNotMatch(await exec("ip", "-6", "route", "show", "table", "18791"), /default dev openteam0/);
    });
    await check("production monitor closes failed paths and restores them after recovery", async () => {
      await exec("touch", "/run/reject-ipv4");
      await waitHealth("unavailable");
      await expectBlocked(...curl, `http://${targetIp}:8080`);
      await exec("rm", "/run/reject-ipv4");
      await waitHealth("working");
      assert.equal(await exec(...curl, `http://${targetIp}:8080`), "target-via-selected-route");
    });
    await exec("python3", "-c", `import os,signal
for p in os.listdir('/proc'):
 if not p.isdigit(): continue
 try: args=open('/proc/'+p+'/cmdline','rb').read().split(bytes([0]))
 except OSError: continue
 if len(args)>2 and args[1]==b'/fixture/fixture.mjs' and args[2]==b'capabilities': os.kill(int(p),signal.SIGTERM)`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await exec("sh", "-c", "test -f /run/family-monitor-stopped && echo yes || true") === "yes") break;
      if (attempt === 49) throw new Error("Capability monitor did not shut down");
      await Bun.sleep(100);
    }
    await exec("python3", "/fixture/openteam-computer-network.py", "--families", JSON.stringify({ ipv4: true, ipv6: true }));
  }
  await check("explicitly binding the physical interface cannot bypass", () =>
    expectBlocked(...curl, "--interface", "eth0", `http://${targetIp}:8080`)
  );
  await check("unsupported public UDP is rejected", async () => {
    assert.equal(
      await exec(
        "python3",
        "-c",
        `import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1)
try:
 s.connect(('8.8.8.8',443));s.send(b'blocked');s.recv(100);raise SystemExit('unexpected response')
except OSError: print('udp-blocked')`
      ),
      "udp-blocked"
    );
  });
  await exec("sh", "-c", "kill $(pidof tun2socks)");
  await check("TUN process death blocks rather than using Docker egress", () =>
    expectBlocked(...curl, `http://${targetIp}:8080`)
  );
  await exec("ip", "link", "del", "openteam0");
  await check("interface removal cannot fall through to the main route", () =>
    expectBlocked(...curl, `http://${targetIp}:8080`)
  );
  await check("management survives interface failure", async () => {
    assert.equal(await exec(...curl, `http://${targetIp}:8787`), "management-reachable");
  });
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  if (process.env.OPENTEAM_KEEP_NETWORK_TEST) {
    console.log(`Kept test resources ${prefix}`);
  } else {
    for (const container of containers.reverse())
      await run(docker("rm", "-f", container), undefined, false);
    if (networkCreated) await run(docker("network", "rm", network), undefined, false);
    for (const suffix of ["fixture", "tools"])
      await run(docker("image", "rm", `${prefix}-${suffix}`), undefined, false);
    await rm(directory, { recursive: true, force: true });
  }
}
