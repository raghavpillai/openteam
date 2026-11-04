// Disposable containers only. No host network, host filesystem mounts, app
// credentials, published ports, or changes to the active Docker context.
import { mkdtemp, rm, writeFile, cp } from "node:fs/promises";
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
  await run(
    docker(
      "build",
      "--target",
      "network-tools",
      "-f",
      "docker/computer.Dockerfile",
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
