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
const curl = [
  "curl",
  "--noproxy",
  "*",
  "-fsS",
  "--connect-timeout",
  "1",
  "--max-time",
  "2",
  "-H",
  "Authorization: Bearer fixture-token",
];
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
async function configureBridge(host: string) {
  await exec(
    "python3",
    "-c",
    `import json,os,pathlib,sys
p=pathlib.Path('/home/box/.config/openteam/imessage-bridge.json')
p.parent.mkdir(parents=True,exist_ok=True)
temporary=p.with_suffix('.tmp')
temporary.write_text(json.dumps({'endpoint':sys.argv[1],'token':'fixture-token'}))
temporary.chmod(0o600)
os.chown(temporary,1000,1000)
temporary.replace(p)`,
    `http://${host}:8799/mcp`
  );
  const expected = host.replace(/^\[|\]$/g, "");
  for (let attempt = 0; attempt < 100; attempt++) {
    const family = expected.includes(":") ? "-6" : "-4";
    const rules = JSON.parse(await exec("ip", family, "-j", "rule", "show", "pref", "98"));
    if (rules.some((rule: { dst?: string }) => rule.dst?.split("/")[0] === expected)) {
      try {
        assertReadable(await call(host));
        return;
      } catch {
        // The source-selection rule is installed before the nft transaction.
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("Bridge configuration was not reconciled");
}
function assertReadable(response: string) {
  const value = JSON.parse(response);
  assert.equal(value.error, undefined);
  assert.notEqual(value.result?.isError, true);
  assert.equal(JSON.parse(value.result.content[0].text).readable, true);
}
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
async function createComputer(offset: number, retained = false) {
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
if [ -f /tmp/retained-bridge.json ]; then
  install -D -m 600 -o 1000 -g 1000 /tmp/retained-bridge.json /home/box/.config/openteam/imessage-bridge.json
fi
python3 /tmp/computer-network.py http://${address(2)}:8787
node /tmp/bridge-watch.mjs &
touch /run/bridge-test-ready
exec sleep 1800`
  );
  if (!containers.includes(computer)) containers.push(computer);
  for (const [source, target] of [
    [resolve("docker/openteam-computer-network.py"), "/tmp/computer-network.py"],
    [resolve("scripts/imessage-bridge-linux/fixture.py"), "/tmp/imessage-bridge-fixture.py"],
    [join(directory, "mcp-recovery.mjs"), "/tmp/mcp-recovery.mjs"],
    [join(directory, "watch-configuration.mjs"), "/tmp/bridge-watch.mjs"],
  ])
    await docker("cp", source!, `${computer}:${target}`);
  if (retained)
    await docker(
      "cp",
      join(directory, "retained-bridge.json"),
      `${computer}:/tmp/retained-bridge.json`
    );
  await docker("start", computer);
  await ready();
}

try {
  const build = await Bun.build({
    entrypoints: [
      resolve("scripts/imessage-bridge-linux/mcp-recovery.ts"),
      resolve("scripts/imessage-bridge-linux/watch-configuration.ts"),
    ],
    target: "node",
    outdir: directory,
    naming: "[name].mjs",
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
    await control(address(2), "start");
    await assert.rejects(call(address(2)));
    await configureBridge(address(2));
    assertReadable(await call(address(2)));
  });
  await check("bridge authentication still rejects an invalid token", async () => {
    await blocked(
      "curl",
      "--noproxy",
      "*",
      "-fsS",
      "--max-time",
      "2",
      "-H",
      "Authorization: Bearer invalid-fixture-token",
      "-d",
      "{}",
      `http://${address(2)}:8799/mcp`
    );
    assertReadable(await call(address(2)));
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
    await configureBridge(`[${ipv6(2)}]`);
    const route = JSON.parse(
      await exec("ip", "-6", "-j", "route", "get", ipv6(2), "ipproto", "tcp", "dport", "8799")
    );
    assert.equal(route[0].dev, "eth0");
    assert.notEqual(route[0].prefsrc, "fdfe:6f70:656e::1");
    assertReadable(await call(`[${ipv6(2)}]`));
    await configureBridge(address(2));
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
      assert.equal(rules.length, family === "-4" ? 1 : 0);
      if (rules.length) assert.equal(rules[0].dport, 8799);
    }
    assertReadable(await call(address(2)));
  });
  await check("management address refresh preserves the bridge route", async () => {
    await exec(
      "python3",
      "/tmp/computer-network.py",
      "--management",
      `http://${address(2)}:8787`,
      JSON.stringify([address(3)])
    );
    assertReadable(await call(address(2)));
    await helper(address(2));
  });
  await check("a bridge service restart restores requests", async () => {
    await control(address(2), "stop");
    await assert.rejects(call(address(2)));
    await control(address(2), "start");
    assertReadable(await call(address(2)));
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
      assertReadable(await call(address(2)));
      assert.match(await exec("node", "/tmp/mcp-recovery.mjs", address(2)), /passed/);
    }
  );
  await check(
    "recreation retains the configured endpoint when the default gateway changes",
    async () => {
      await docker(
        "cp",
        `${computer}:/home/box/.config/openteam/imessage-bridge.json`,
        join(directory, "retained-bridge.json")
      );
      await docker("rm", "-f", computer);
      await createComputer(3, true);
      assertReadable(await call(address(2)));
      await blocked(...curl, `http://${address(3)}:8799`);
      const rules = await exec("ip", "-4", "-j", "rule", "show", "pref", "98");
      assert.ok(!rules.includes(address(3)));
      assert.match(await exec("node", "/tmp/mcp-recovery.mjs", address(2)), /passed/);
    }
  );
  await check(
    "reprovisioning replaces the endpoint and revokes the previous reservation",
    async () => {
      await configureBridge(address(3));
      assertReadable(await call(address(3)));
      await blocked(...curl, `http://${address(2)}:8799`);
    }
  );
  await check("bridge survives TUN removal while other direct traffic stays blocked", async () => {
    await exec("ip", "link", "del", "openteam0");
    assertReadable(await call(address(3)));
    await blocked(...curl, `http://${address(3)}:8798`);
    await blocked(...curl, `http://${address(2)}:8799`);
  });
  await check("startup repairs a removed bridge rule and virtual interface", async () => {
    await exec("ip", "-4", "rule", "del", "pref", "98");
    await helper(address(3));
    assertReadable(await call(address(3)));
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
