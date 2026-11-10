// Run from the repository root with bun. Only disposable resources on the
// explicitly selected Linux Docker context are changed. No ports are published.
// This matrix checks explicit refresh and prepare(). The chaos harness checks
// the marked worker's live configuration watcher and application recovery.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT ?? "";
const image = process.env.OPENTEAM_TEST_COMPUTER_IMAGE ?? "";
if (!context || !image)
  throw new Error("Set OPENTEAM_TEST_DOCKER_CONTEXT and OPENTEAM_TEST_COMPUTER_IMAGE");

const prefix = `openteam-bridge-config-${randomUUID().slice(0, 8)}`;
const configDirectory = "/home/box/.config/openteam";
const configPath = `${configDirectory}/imessage-bridge.json`;
const resources: { kind: "container" | "network" | "volume"; name: string }[] = [];
const checks: string[] = [];
const failures: { name: string; error: string }[] = [];
const observations: Record<string, unknown>[] = [];
const curl = ["curl", "--noproxy", "*", "-fsS", "--connect-timeout", "1", "--max-time", "2"];
const fixturePorts = [8798, 8799, 18799, 18800];
type Endpoint = { address: string; port: number };
type Rule = { dst: string; table: string; ipproto: string; dport: number };
type Route = { dev: string; prefsrc?: string; src?: string; gateway?: string };

async function dockerInput(args: string[], input?: string) {
  const proc = Bun.spawn(["docker", "--context", context, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Do not echo stdin or command payloads, even though this harness uses only
    // synthetic configuration and the fixed public fixture token.
    assert.equal(code, 0, `${args.slice(0, 3).join(" ")}: ${err || out}`);
    return out.trim();
  } finally {
    clearTimeout(timeout);
  }
}
const docker = (...args: string[]) => dockerInput(args);
const exec = (container: string, ...args: string[]) => docker("exec", container, ...args);
const json = async <T = unknown>(container: string, ...args: string[]): Promise<T> =>
  JSON.parse(await exec(container, ...args));
const route = (container: string, endpoint: Endpoint) =>
  json<Route[]>(
    container,
    "ip",
    endpoint.address.includes(":") ? "-6" : "-4",
    "-j",
    "route",
    "get",
    endpoint.address,
    "ipproto",
    "tcp",
    "dport",
    String(endpoint.port)
  );
const prepare = (container: string) =>
  exec(container, "python3", "/tmp/computer-network.py", "http://127.0.0.1:8787");
const refresh = (container: string) =>
  exec(container, "python3", "/tmp/computer-network.py", "--host-bridge", "http://127.0.0.1:8787");
const interruptedRefresh = (container: string) =>
  exec(
    container,
    "python3",
    "-c",
    `import importlib.util,subprocess
spec=importlib.util.spec_from_file_location('network','/tmp/computer-network.py')
network=importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)
original=network.run
def fail_publication(*args,**kwargs):
    if args[0]=='nft':
        raise subprocess.CalledProcessError(1,['nft'],stderr='injected publication failure')
    return original(*args,**kwargs)
network.run=fail_publication
try:
    network.update_host_bridge('http://127.0.0.1:8787')
    raise AssertionError('expected injected publication failure')
except subprocess.CalledProcessError:
    pass
network.run=original
network.update_host_bridge('http://127.0.0.1:8787')`
  );
const url = ({ address, port }: Endpoint) =>
  `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
const savedConfig = (endpoint: Endpoint) =>
  JSON.stringify({ endpoint: url(endpoint), token: "fixture-token" });

async function writeConfig(container: string, contents: string, mode = 0o600) {
  assert.ok(contents.length <= 20_000, "Only bounded synthetic fixture payloads are allowed");
  await dockerInput(
    [
      "exec",
      "-i",
      container,
      "python3",
      "-c",
      `import os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(dir=path.parent)
with os.fdopen(fd, 'w') as file:
    os.fchmod(file.fileno(), int(sys.argv[2]))
    os.fchown(file.fileno(), 1000, 1000)
    file.write(sys.stdin.read(20001))
os.replace(temporary, path)`,
      configPath,
      String(mode),
    ],
    contents
  );
}
const configure = (container: string, endpoint: Endpoint) =>
  writeConfig(container, savedConfig(endpoint));
const clearConfig = (container: string) => exec(container, "rm", "-f", configPath);

async function reachable(container: string, endpoint: Endpoint) {
  const value = JSON.parse(
    await exec(
      container,
      ...curl,
      `${url(endpoint)}/mcp`,
      "-H",
      "Authorization: Bearer fixture-token",
      "-d",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "IMessageStatus", arguments: {} },
      })
    )
  );
  assert.equal(value.error, undefined);
  assert.notEqual(value.result?.isError, true);
  assert.equal(JSON.parse(value.result.content[0].text).readable, true);
}

async function blocked(container: string, endpoint: Endpoint) {
  // A listener is proven reachable before policy in connected cases. Also
  // verify application routing, so a stopped listener cannot prove isolation.
  const routes = await route(container, endpoint);
  assert.equal(routes[0]?.dev, "openteam0", `${url(endpoint)} must use application routing`);
  const result = await exec(
    container,
    "sh",
    "-c",
    '"$@" >/dev/null 2>&1; result=$?; case "$result" in 7|28|52|56) echo BLOCKED;; 0) echo BYPASSED;; *) echo "UNEXPECTED:$result";; esac',
    "sh",
    ...curl,
    url(endpoint)
  );
  assert.equal(result, "BLOCKED", `${url(endpoint)}: ${result}`);
}

async function physicalRoute(container: string, endpoint: Endpoint, device: string) {
  const routes = await route(container, endpoint);
  const selected = routes[0];
  assert.ok(selected);
  assert.equal(selected.dev, device, `${url(endpoint)} must select ${device}`);
  const source = selected.prefsrc ?? selected.src;
  assert.ok(source, `No physical source selected for ${url(endpoint)}`);
  assert.ok(!["198.18.0.1", "fdfe:6f70:656e::1"].includes(source));
  observations.push({ container, endpoint: url(endpoint), device, source });
}

async function cleanup(start: number) {
  const errors: string[] = [];
  for (const { kind, name } of resources.splice(start).reverse()) {
    try {
      if (kind === "container") await docker("rm", "-f", name);
      else await docker(kind, "rm", name);
    } catch (error) {
      errors.push(String(error));
    }
  }
  assert.deepEqual(errors, [], "Disposable resource cleanup failed");
}

async function check(name: string, work: () => Promise<void>) {
  const start = resources.length;
  try {
    await work();
    checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: String(error) });
    console.error(`FAIL ${name}: ${error}`);
  } finally {
    try {
      await cleanup(start);
    } catch (error) {
      failures.push({ name: `${name}: cleanup`, error: String(error) });
    }
  }
}

// Docker rejects pool overlap without changing existing networks. Networks and
// listeners are peers in disposable namespaces, never in the daemon host.
const subnet = 20 + Math.floor(Math.random() * 200);
type Network = { name: string; v4: (offset: number) => string; v6?: (offset: number) => string };
let networkIndex = 0;
async function network(dual = false): Promise<Network> {
  const index = networkIndex++;
  const name = `${prefix}-net-${index}`;
  const v4 = (offset: number) => `10.${240 + index}.${subnet}.${offset}`;
  const v6 = (offset: number) => `fd76:${subnet}:${index}::${offset}`;
  await docker(
    "network",
    "create",
    "--driver",
    "bridge",
    "--subnet",
    `${v4(0)}/24`,
    ...(dual ? ["--ipv6", "--subnet", `${v6(0)}/64`] : []),
    name
  );
  resources.push({ kind: "network", name });
  return { name, v4, ...(dual ? { v6 } : {}) };
}

async function fixtureReady(name: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await exec(
      name,
      "sh",
      "-c",
      "test -f /tmp/bridge-config-ready && echo ready || true"
    );
    if (ready === "ready") {
      // The marker can survive a fixture restart. A real response is required.
      try {
        await reachable(name, { address: "127.0.0.1", port: 18799 });
        return;
      } catch {
        // Only retry local fixture startup here, never a policy assertion.
      }
    }
    await Bun.sleep(100);
  }
  throw new Error(`${name}: synthetic RPC fixture failed to start`);
}

async function container(
  name: string,
  net?: Network,
  options: { offset?: number; host?: boolean; disableIPv6?: boolean; volume?: string } = {}
) {
  const { offset = 10, host = false, disableIPv6 = false, volume } = options;
  await docker(
    "create",
    "--name",
    name,
    "--network",
    net?.name ?? "none",
    ...(net ? ["--ip", net.v4(offset), ...(net.v6 ? ["--ip6", net.v6(offset)] : [])] : []),
    ...(host
      ? [
          "--env",
          `FIXTURE_PORTS=${fixturePorts.join(",")}`,
          "--env",
          `FIXTURE_IPV6=${net?.v6 ? "1" : "0"}`,
        ]
      : ["--privileged"]),
    ...(disableIPv6
      ? [
          "--sysctl",
          "net.ipv6.conf.all.disable_ipv6=1",
          "--sysctl",
          "net.ipv6.conf.default.disable_ipv6=1",
        ]
      : []),
    ...(volume ? ["--mount", `type=volume,source=${volume},target=${configDirectory}`] : []),
    "--entrypoint",
    host ? "/usr/bin/python3" : "/bin/sleep",
    image,
    ...(host ? ["/tmp/bridge-config-fixture.py"] : ["1800"])
  );
  resources.push({ kind: "container", name });
  await docker(
    "cp",
    resolve(
      host
        ? "scripts/imessage-bridge-linux/config-fixture.py"
        : "docker/openteam-computer-network.py"
    ),
    `${name}:${host ? "/tmp/bridge-config-fixture.py" : "/tmp/computer-network.py"}`
  );
  await docker("start", name);
  if (host) await fixtureReady(name);
  else if (!volume) await clearConfig(name);
  return name;
}

async function gateway(container: string, net: Network, offset: number, metric = 0) {
  const addresses: [string, string][] = [["-4", net.v4(offset)]];
  if (net.v6) addresses.push(["-6", net.v6(offset)]);
  for (const [family, address] of addresses) {
    if (metric === 0)
      await exec(container, "ip", family, "route", "flush", "table", "main", "default");
    await exec(
      container,
      "ip",
      family,
      "route",
      "replace",
      "default",
      "via",
      address,
      "metric",
      String(metric)
    );
  }
}

async function bridgePolicy(container: string, expected: Endpoint[], ipv6 = true) {
  for (const [family, suffix, type] of [
    ["-4", "v4", "ipv4_addr"],
    ["-6", "v6", "ipv6_addr"],
  ] as const) {
    const pairs = expected.filter(({ address }) => address.includes(":") === (family === "-6"));
    // Disabled IPv6 has no routing API mutation requirement. Its nft set must
    // still exist and stay empty, and the TUN must have no IPv6 address.
    if (family === "-4" || ipv6) {
      const rules = await json<Rule[]>(container, "ip", family, "-j", "rule", "show", "pref", "98");
      assert.deepEqual(
        rules.map((rule) => ({ address: rule.dst.split("/")[0], port: Number(rule.dport) })),
        pairs
      );
      for (const rule of rules) {
        assert.equal(rule.table, "main");
        assert.equal(rule.ipproto, "tcp");
        const prefix = rule.dst.split("/")[1];
        assert.ok(prefix === undefined || prefix === (family === "-4" ? "32" : "128"));
      }
    }
    type Element = { concat: [string, number] };
    const nft = await json<{
      nftables: {
        set?: {
          type: string[];
          elem?: (Element | { elem: { val: Element } })[];
        };
      }[];
    }>(container, "nft", "-j", "list", "set", "inet", "openteam_network", `host_bridge_${suffix}`);
    const set = nft.nftables.find((item) => item.set)?.set;
    assert.ok(set);
    assert.deepEqual(set.type, [type, "inet_service"]);
    assert.deepEqual(
      (set.elem ?? []).map((item) => {
        const [address, port] = ("elem" in item ? item.elem.val : item).concat;
        return { address, port: Number(port) };
      }),
      pairs
    );
  }
  const management = await json<Rule[]>(container, "ip", "-4", "-j", "rule", "show", "pref", "99");
  assert.equal(management.length, 1);
  assert.equal(management[0]?.dst.split("/")[0], "127.0.0.1");
  assert.equal(management[0]?.dport, 8787);
  if (!ipv6) {
    const links = await json<{ addr_info: { family: string }[] }[]>(
      container,
      "ip",
      "-j",
      "address",
      "show",
      "dev",
      "openteam0"
    );
    assert.ok(links[0]);
    assert.equal(
      links[0].addr_info.some((address) => address.family === "inet6"),
      false
    );
  }
}

try {
  // Prevent implicit image pulls. Building and selecting the image belong to
  // the parent running the integration suite.
  await docker("image", "inspect", image);
  await check("missing and invalid private configuration reserve no endpoint", async () => {
    const net = await network();
    await container(`${prefix}-host-invalid`, net, { host: true, offset: 2 });
    const computer = await container(`${prefix}-invalid`, net);
    const endpoint = { address: net.v4(2), port: 8799 };
    await gateway(computer, net, 2);
    await reachable(computer, endpoint);
    await prepare(computer);
    await bridgePolicy(computer, []);
    await blocked(computer, endpoint);
    const invalid = [
      "[".repeat(1100) + "0" + "]".repeat(1100),
      "{",
      "null",
      "[]",
      JSON.stringify({ endpoint: url(endpoint) }),
      JSON.stringify({ endpoint: url(endpoint), token: " " }),
      JSON.stringify({ endpoint: "http://fixture.invalid:8799", token: "fixture-token" }),
      JSON.stringify({ endpoint: `ftp://${endpoint.address}:8799`, token: "fixture-token" }),
      JSON.stringify({ endpoint: `http://${endpoint.address}:0`, token: "fixture-token" }),
    ];
    for (const contents of invalid) {
      // Begin each invalid replacement with a real reservation, proving revoke.
      await configure(computer, endpoint);
      await refresh(computer);
      await bridgePolicy(computer, [endpoint]);
      await writeConfig(computer, contents);
      await refresh(computer);
      await bridgePolicy(computer, []);
    }
    await writeConfig(computer, savedConfig(endpoint), 0o644);
    await refresh(computer);
    await bridgePolicy(computer, []);
    await configure(computer, endpoint);
    await exec(computer, "mv", configPath, `${configPath}.target`);
    await exec(computer, "ln", "-s", `${configPath}.target`, configPath);
    await refresh(computer);
    await bridgePolicy(computer, []);
    await clearConfig(computer);
    await exec(computer, "mkdir", configPath);
    await refresh(computer);
    await bridgePolicy(computer, []);
    await exec(computer, "rmdir", configPath);
    await configure(computer, endpoint);
    await refresh(computer);
    await reachable(computer, endpoint);
    await clearConfig(computer);
    await refresh(computer);
    await bridgePolicy(computer, []);
    await blocked(computer, endpoint);
  });

  await check("nondefault interface and custom port allow only the configured pair", async () => {
    const primary = await network();
    const secondary = await network();
    for (const offset of [2, 3]) {
      await container(`${prefix}-primary-${offset}`, primary, { host: true, offset });
      await container(`${prefix}-secondary-${offset}`, secondary, { host: true, offset });
    }
    const computer = await container(`${prefix}-multi`, primary);
    await docker("network", "connect", "--ip", secondary.v4(10), secondary.name, computer);
    await gateway(computer, primary, 2);
    await gateway(computer, primary, 3, 200);
    const endpoint = { address: secondary.v4(2), port: 18799 };
    const rejected = [
      { address: primary.v4(2), port: 8799 },
      { address: primary.v4(3), port: 8799 },
      { address: secondary.v4(2), port: 8799 },
      { address: secondary.v4(3), port: 18799 },
      { ...endpoint, port: 18800 },
    ];
    for (const target of [endpoint, ...rejected]) await reachable(computer, target);
    await prepare(computer);
    await bridgePolicy(computer, []);
    for (const target of [endpoint, ...rejected]) await blocked(computer, target);
    await configure(computer, endpoint);
    await refresh(computer);
    await refresh(computer);
    await prepare(computer);
    await prepare(computer);
    await bridgePolicy(computer, [endpoint]);
    await physicalRoute(computer, endpoint, "eth1");
    await reachable(computer, endpoint);
    for (const target of rejected) await blocked(computer, target);
    const changed = { ...endpoint, port: 18800 };
    await configure(computer, changed);
    await interruptedRefresh(computer);
    await refresh(computer);
    await bridgePolicy(computer, [changed]);
    await physicalRoute(computer, changed, "eth1");
    await reachable(computer, changed);
    await blocked(computer, endpoint);
    await docker("stop", `${prefix}-secondary-2`);
    await refresh(computer);
    await bridgePolicy(computer, [changed]);
    await physicalRoute(computer, changed, "eth1");
    await docker("start", `${prefix}-secondary-2`);
    await fixtureReady(`${prefix}-secondary-2`);
    await reachable(computer, changed);
  });

  await check("directly connected configured endpoint works with no default route", async () => {
    const net = await network();
    await container(`${prefix}-host-nodefault`, net, { host: true, offset: 2 });
    const computer = await container(`${prefix}-nodefault`, net);
    const endpoint = { address: net.v4(2), port: 18799 };
    await exec(computer, "ip", "-4", "route", "flush", "table", "main", "default");
    await reachable(computer, endpoint);
    await configure(computer, endpoint);
    await prepare(computer);
    await bridgePolicy(computer, [endpoint]);
    await physicalRoute(computer, endpoint, "eth0");
    await reachable(computer, endpoint);
    await blocked(computer, { ...endpoint, port: 8799 });
    await exec(computer, "ip", "-4", "route", "replace", "default", "dev", "eth0");
    const defaults = await json<Route[]>(
      computer,
      "ip",
      "-4",
      "-j",
      "route",
      "show",
      "table",
      "main",
      "default"
    );
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0]?.gateway, undefined);
    await refresh(computer);
    await bridgePolicy(computer, [endpoint]);
    await reachable(computer, endpoint);
  });

  await check("dual stack reserves only the single saved IPv4 or IPv6 pair", async () => {
    const net = await network(true);
    await container(`${prefix}-host-dual`, net, { host: true, offset: 2 });
    const computer = await container(`${prefix}-dual`, net);
    await gateway(computer, net, 2);
    const v4 = { address: net.v4(2), port: 18799 };
    assert.ok(net.v6);
    const v6 = { address: net.v6(2), port: 18800 };
    for (const endpoint of [v4, v6]) await reachable(computer, endpoint);
    await configure(computer, v4);
    await prepare(computer);
    await bridgePolicy(computer, [v4]);
    await physicalRoute(computer, v4, "eth0");
    await reachable(computer, v4);
    await blocked(computer, v6);
    await configure(computer, v6);
    await refresh(computer);
    await refresh(computer);
    await bridgePolicy(computer, [v6]);
    await physicalRoute(computer, v6, "eth0");
    await reachable(computer, v6);
    await blocked(computer, v4);
    await blocked(computer, { ...v6, port: 8799 });
    await blocked(computer, { ...v4, port: 8799 });
  });

  await check("IPv4 initialization and management refresh with kernel IPv6 disabled", async () => {
    const net = await network();
    await container(`${prefix}-host-disabled6`, net, { host: true, offset: 2 });
    const computer = await container(`${prefix}-disabled6`, net, { disableIPv6: true });
    const endpoint = { address: net.v4(2), port: 18799 };
    await gateway(computer, net, 2);
    for (const name of ["all", "default"])
      assert.equal(
        await exec(computer, "cat", `/proc/sys/net/ipv6/conf/${name}/disable_ipv6`),
        "1"
      );
    await reachable(computer, endpoint);
    await configure(computer, endpoint);
    await prepare(computer);
    await prepare(computer);
    await refresh(computer);
    await exec(
      computer,
      "python3",
      "/tmp/computer-network.py",
      "--management",
      "http://127.0.0.1:8787",
      JSON.stringify(["127.0.0.1", "::1"])
    );
    await bridgePolicy(computer, [endpoint], false);
    await physicalRoute(computer, endpoint, "eth0");
    await reachable(computer, endpoint);
    await blocked(computer, { ...endpoint, port: 8799 });
    await configure(computer, { address: "2001:db8::1", port: 18799 });
    await refresh(computer);
    await bridgePolicy(computer, [], false);
    await blocked(computer, endpoint);
  });

  await check("persisted endpoint survives recreation and default-route replacement", async () => {
    const net = await network();
    await container(`${prefix}-persist-host-a`, net, { host: true, offset: 2 });
    await container(`${prefix}-persist-host-b`, net, { host: true, offset: 3 });
    const volume = `${prefix}-config`;
    await docker("volume", "create", volume);
    resources.push({ kind: "volume", name: volume });
    const computer = await container(`${prefix}-persist`, net, { volume });
    const endpoint = { address: net.v4(2), port: 8799 };
    const replacement = { address: net.v4(3), port: 8799 };
    await gateway(computer, net, 2);
    await reachable(computer, endpoint);
    await reachable(computer, replacement);
    await configure(computer, endpoint);
    await prepare(computer);
    await gateway(computer, net, 3);
    await prepare(computer);
    await bridgePolicy(computer, [endpoint]);
    await reachable(computer, endpoint);
    await blocked(computer, replacement);
    await docker("rm", "-f", computer);
    resources.splice(
      resources.findIndex((item) => item.kind === "container" && item.name === computer),
      1
    );
    await container(computer, net, { volume });
    await gateway(computer, net, 3);
    // No configuration rewrite is performed in the recreated container.
    await prepare(computer);
    await refresh(computer);
    await bridgePolicy(computer, [endpoint]);
    await physicalRoute(computer, endpoint, "eth0");
    await reachable(computer, endpoint);
    await blocked(computer, replacement);
    assert.equal(
      await exec(
        computer,
        "python3",
        "-c",
        "import json,sys; print(json.load(open(sys.argv[1]))['endpoint'])",
        configPath
      ),
      url(endpoint)
    );
    // An actual endpoint migration requires explicit reprovisioning. Changing
    // Docker's default route alone must never rewrite the saved endpoint.
    await configure(computer, replacement);
    await refresh(computer);
    await bridgePolicy(computer, [replacement]);
    await reachable(computer, replacement);
    await blocked(computer, endpoint);
  });

  await check(
    "network none has no reserved endpoint and ordinary traffic uses the TUN",
    async () => {
      const computer = await container(`${prefix}-none`);
      await prepare(computer);
      await prepare(computer);
      await refresh(computer);
      await bridgePolicy(computer, []);
      for (const [family, address] of [
        ["-4", "192.0.2.1"],
        ["-6", "2001:db8::1"],
      ] as const) {
        assert.deepEqual(
          await json(computer, "ip", family, "-j", "route", "show", "table", "main", "default"),
          []
        );
        await blocked(computer, { address, port: 8799 });
        await blocked(computer, { address, port: 443 });
      }
    }
  );
} finally {
  await cleanup(0);
}
console.log(
  JSON.stringify({ passed: failures.length === 0, checks, failures, observations }, null, 2)
);
if (failures.length) process.exitCode = 1;
