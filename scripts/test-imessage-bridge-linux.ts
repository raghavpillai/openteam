// Uses disposable containers on an explicitly selected daemon. Requires an
// existing computer image, and publishes no ports or application credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT;
const image = process.env.OPENTEAM_TEST_COMPUTER_IMAGE;
if (!context || !image)
  throw new Error("Set OPENTEAM_TEST_DOCKER_CONTEXT and OPENTEAM_TEST_COMPUTER_IMAGE");
const prefix = `openteam-bridge-chaos-${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), prefix));
const network = `${prefix}-net`;
const computer = `${prefix}-computer`;
const hosts = [`${prefix}-host-a`, `${prefix}-host-b`];
const subnet = 30 + Math.floor(Math.random() * 180);
const address = (offset: number) => `10.246.${subnet}.${offset}`;
const ipv6 = (offset: number) => `fd75:${subnet}::${offset}`;
const checks: string[] = [];
let networkCreated = false;
const containers: string[] = [];

async function docker(...args: string[]) {
  const proc = Bun.spawn(["docker", "--context", context!, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    assert.equal(code, 0, `${args.slice(0, 3).join(" ")}: ${stderr || stdout}`);
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}
const exec = (...args: string[]) => docker("exec", computer, ...args);
const helper = (host: string) => exec("python3", "/tmp/computer-network.py", `http://${host}:8787`);
const curl = ["curl", "--noproxy", "*", "-fsS", "--connect-timeout", "1", "--max-time", "2"];
const call = (host: string) =>
  exec(
    ...curl,
    `http://${host}:8799/mcp`,
    "-d",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "IMessageStatus", arguments: {} },
    })
  );
const control = (host: string, action: string) =>
  exec(...curl, `http://${host}:8787/${action}`, "-X", "POST");
async function check(name: string, work: () => Promise<void>) {
  await work();
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function blocked(...args: string[]) {
  assert.equal(
    await exec(
      "sh",
      "-c",
      'if "$@" >/dev/null 2>&1; then echo BYPASSED; else echo BLOCKED; fi',
      "sh",
      ...args
    ),
    "BLOCKED"
  );
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await exec("sh", "-c", "test -f /run/bridge-test-ready && echo ready || true")) === "ready"
    )
      return;
    await Bun.sleep(50);
  }
  throw new Error("Disposable computer did not initialize");
}
async function createComputer(offset: number) {
  // Use a disposable peer as the Docker host gateway, so the test never binds
  // a listener in the deployment host's namespace. The kernel rules are real.
  await docker(
    "create",
    "--name",
    computer,
    "--network",
    network,
    "--privileged",
    "--entrypoint",
    "/bin/sh",
    image!,
    "-ec",
    `rm -f /run/bridge-test-ready
echo '#1000 ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/bridge-test
ip route replace default via ${address(offset)} dev eth0
ip -6 route replace default via ${ipv6(offset)} dev eth0
python3 /tmp/computer-network.py http://${address(offset)}:8787
touch /run/bridge-test-ready
exec sleep 1800`
  );
  if (!containers.includes(computer)) containers.push(computer);
  for (const [source, target] of [
    [resolve("docker/openteam-computer-network.py"), "/tmp/computer-network.py"],
    [resolve("scripts/imessage-bridge-linux/fixture.py"), "/tmp/imessage-bridge-fixture.py"],
    [join(directory, "mcp-recovery.mjs"), "/tmp/mcp-recovery.mjs"],
  ])
    await docker("cp", source!, `${computer}:${target}`);
  await docker("start", computer);
  await ready();
}

try {
  const build = await Bun.build({
    entrypoints: [resolve("scripts/imessage-bridge-linux/mcp-recovery.ts")],
    target: "node",
    outdir: directory,
    naming: "mcp-recovery.mjs",
  });
  assert.ok(build.success, String(build.logs));
  await docker(
    "network",
    "create",
    "--ipv6",
    "--subnet",
    `10.246.${subnet}.0/24`,
    "--subnet",
    `fd75:${subnet}::/64`,
    network
  );
  networkCreated = true;
  for (const [index, host] of hosts.entries()) {
    await docker(
      "create",
      "--name",
      host,
      "--network",
      network,
      "--ip",
      address(index + 2),
      "--ip6",
      ipv6(index + 2),
      "--entrypoint",
      "/usr/bin/python3",
      image!,
      "/tmp/imessage-bridge-fixture.py",
      "host"
    );
    containers.push(host);
    await docker(
      "cp",
      resolve("scripts/imessage-bridge-linux/fixture.py"),
      `${host}:/tmp/imessage-bridge-fixture.py`
    );
    await docker("start", host);
  }
  await createComputer(2);
  await check("bridge can be provisioned after the computer network starts", async () => {
    await assert.rejects(call(address(2)));
    await control(address(2), "start");
    assert.match(await call(address(2)), /readable/);
  });
  await check("ordinary user and sudo can reach the authenticated host endpoint", async () => {
    for (const command of [curl, ["sudo", ...curl]]) {
      assert.match(
        await exec(
          "setpriv",
          "--reuid",
          "1000",
          "--regid",
          "1000",
          "--init-groups",
          ...command,
          `http://${address(2)}:8799`
        ),
        /fixture-neighbor/
      );
    }
  });
  await check("IPv6 gateway gets the same narrow exception", async () => {
    const route = JSON.parse(
      await exec("ip", "-6", "-j", "route", "get", ipv6(2), "ipproto", "tcp", "dport", "8799")
    );
    assert.equal(route[0].dev, "eth0");
    assert.notEqual(route[0].prefsrc, "fdfe:6f70:656e::1");
    assert.match(await call(`[${ipv6(2)}]`), /readable/);
  });
  await check("other host ports keep following application routing", async () => {
    await blocked(...curl, `http://${address(2)}:8798`);
  });
  await check("the bridge port on another private destination stays blocked", async () => {
    await docker("exec", hosts[1]!, ...curl, "http://127.0.0.1:8787/start", "-X", "POST");
    await blocked(...curl, `http://${address(3)}:8799`);
    await blocked(...curl, `http://[${ipv6(3)}]:8799`);
  });
  await check("reapplying startup policy creates no duplicate bridge rules", async () => {
    for (let attempt = 0; attempt < 3; attempt++) await helper(address(2));
    for (const family of ["-4", "-6"]) {
      const rules = JSON.parse(await exec("ip", family, "-j", "rule", "show", "pref", "98"));
      assert.equal(rules.length, 1);
      assert.equal(rules[0].dport, 8799);
    }
    assert.match(await call(address(2)), /readable/);
  });
  await check("management address refresh preserves the bridge route", async () => {
    await exec(
      "python3",
      "/tmp/computer-network.py",
      "--management",
      `http://${address(2)}:8787`,
      JSON.stringify([address(3)])
    );
    assert.match(await call(address(2)), /readable/);
    await helper(address(2));
  });
  await check("a bridge service restart restores requests", async () => {
    await control(address(2), "stop");
    await assert.rejects(call(address(2)));
    await control(address(2), "start");
    assert.match(await call(address(2)), /readable/);
  });
  await check(
    "MCP lazy restart, concurrent calls, outage recovery, and explicit reconnect",
    async () => {
      assert.match(await exec("node", "/tmp/mcp-recovery.mjs", address(2)), /passed/);
    }
  );
  await check(
    "container restart restores bridge connectivity before applications start",
    async () => {
      await docker("restart", computer);
      await ready();
      assert.match(await call(address(2)), /readable/);
      assert.match(await exec("node", "/tmp/mcp-recovery.mjs", address(2)), /passed/);
    }
  );
  await check(
    "update recreation discovers a changed gateway and removes the old exception",
    async () => {
      await docker("rm", "-f", computer);
      await createComputer(3);
      assert.match(await call(address(3)), /readable/);
      await blocked(...curl, `http://${address(2)}:8799`);
      const rules = await exec("ip", "-4", "-j", "rule", "show", "pref", "98");
      assert.ok(!rules.includes(address(2)));
      assert.match(await exec("node", "/tmp/mcp-recovery.mjs", address(3)), /passed/);
    }
  );
  await check("bridge survives TUN removal while other direct traffic stays blocked", async () => {
    await exec("ip", "link", "del", "openteam0");
    assert.match(await call(address(3)), /readable/);
    await blocked(...curl, `http://${address(3)}:8798`);
    await blocked(...curl, `http://${address(2)}:8799`);
  });
  await check("startup repairs a removed bridge rule and virtual interface", async () => {
    await exec("ip", "-4", "rule", "del", "pref", "98");
    await helper(address(3));
    assert.match(await call(address(3)), /readable/);
  });
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  for (const container of containers.reverse()) {
    try {
      await docker("rm", "-f", container);
    } catch {
      /* Continue cleaning other resources. */
    }
  }
  if (networkCreated) await docker("network", "rm", network);
  await rm(directory, { recursive: true, force: true });
}
