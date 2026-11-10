// Explicitly opt into a disposable Docker daemon/context, e.g. a dedicated Colima profile.
// Never publishes ports, mounts the checkout, uses application credentials, or changes Docker's active context.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT;
if (!context) throw Error("Set OPENTEAM_TEST_DOCKER_CONTEXT to a disposable Linux Docker context.");
const out = resolve(process.env.OPENTEAM_TEST_OUTPUT_DIR ?? "output/browser-network-linux");
await mkdir(out, { recursive: true });
await writeFile(join(out, "result.json"), JSON.stringify({ passed: false, state: "running" }));
const temp = await mkdtemp(join(tmpdir(), "openteam-network-linux-"));
const prefix = `openteam-network-test-${process.pid}`;
const controlNet = `${prefix}-control`,
  targetNet = `${prefix}-target`;
const containers: string[] = [],
  networks: string[] = [],
  volumes: string[] = [];
const workspaceVolume = `${prefix}-workspace`,
  dataVolume = `${prefix}-data`;
const components = [
  "postgres",
  "server",
  "computer",
  "device-a",
  "device-b",
  "target",
  "cert-tools",
  "netem",
] as const;
type Component = (typeof components)[number];
const names = Object.fromEntries(components.map((name) => [name, `${prefix}-${name}`])) as Record<
  Component,
  string
>;
const images = {
  computer: "openteam-network-computer:test",
  server: "openteam-network-server:test",
  migrate: "openteam-network-migrate:test",
};
const config = {
  a: crypto.randomUUID(),
  b: crypto.randomUUID(),
  bots: [crypto.randomUUID(), crypto.randomUUID()],
  control: crypto.randomUUID(),
  password: crypto.randomUUID(),
};
const docker = (...args: string[]) => ["docker", "--context", context, ...args];
async function command(
  args: string[],
  options: { input?: string; log?: string; timeout?: number; stream?: boolean } = {}
) {
  const child = Bun.spawn(args, {
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 240000);
  const stdoutText = async () => {
    let output = "";
    const reader = child.stdout.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = new TextDecoder().decode(chunk.value);
      output += text;
      if (options.stream) process.stdout.write(text);
    }
    return output;
  };
  const [stdout, stderr, code] = await Promise.all([
    stdoutText(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (options.log) await writeFile(join(out, options.log), stdout + stderr);
  if (code !== 0)
    throw Error(
      `Command failed (${code}): ${args.slice(0, 5).join(" ")}\n${(stdout + stderr).slice(-5000)}`
    );
  return stdout;
}
async function run(name: Component, args: string[]) {
  containers.push(names[name]);
  await command(
    docker(
      "create",
      "--name",
      names[name],
      "--network",
      controlNet,
      "--network-alias",
      name,
      ...args
    )
  );
}
const env = [
  "-e",
  `OPENTEAM_CONTROL_TOKEN=${config.control}`,
  "-e",
  "OPENTEAM_AUTH_SECRET=isolated-network-test-auth-secret-123456789",
  "-e",
  "OPENTEAM_AUTH_URL=http://server:8787",
  "-e",
  "OPENTEAM_AUTH_MODE=required",
  "-e",
  "DATABASE_URL=postgresql://test:test@postgres:5432/network_test",
  "-e",
  "OPENTEAM_COMPUTER_URL=http://computer:8790",
  "-e",
  "OPENTEAM_ASSET_ROOT=/home/box/agent-data/.openteam-assets",
];
const phases = [
  "initial",
  "ranking",
  "server-restart",
  "computer-restart",
  "blackhole",
  "recovered",
  ...(process.argv.includes("--chaos")
    ? [
        "chaos-loss",
        "chaos-clear",
        "chaos-identity",
        "chaos-link-down",
        "chaos-link-recovered",
        "chaos-relay",
        "chaos-relay-recovered",
        "chaos-all-offline",
        "chaos-all-recovered",
      ]
    : []),
  "finish",
];
try {
  console.log(`Testing in explicit Docker context ${context}; resources ${prefix}`);
  await writeFile(
    join(out, "environment.txt"),
    await command(
      docker("info", "--format", "{{.OperatingSystem}} {{.Architecture}} Docker {{.ServerVersion}}")
    )
  );
  if (!process.argv.includes("--skip-build")) {
    for (const [name, file, target] of [
      ["computer", "docker/computer.Dockerfile", null],
      ["server", "docker/app.Dockerfile", "server"],
      ["migrate", "docker/app.Dockerfile", "migrate"],
    ] as const) {
      console.log(`Building production ${name} image`);
      await command(
        docker(
          "build",
          "-f",
          file,
          ...(target ? ["--target", target] : []),
          "-t",
          images[name],
          "."
        ),
        { log: `${name}-build.log`, timeout: 1200000 }
      );
    }
  }
  await command(
    docker(
      "build",
      "-f",
      "scripts/browser-network-linux/cert-tools.Dockerfile",
      "-t",
      "openteam-network-cert-tools:test",
      "."
    ),
    { log: "cert-tools-build.log" }
  );
  containers.push(names["cert-tools"]);
  await command(
    docker(
      "create",
      "--name",
      names["cert-tools"],
      "--network",
      "none",
      "openteam-network-cert-tools:test",
      "sleep",
      "600"
    )
  );
  await command(docker("cp", `${names["cert-tools"]}:/usr/bin/certutil`, join(temp, "certutil")));
  for (const name of ["device", "target", "check"]) {
    const result = await Bun.build({
      entrypoints: [resolve(`scripts/browser-network-linux/${name}.ts`)],
      target: name === "check" ? "bun" : "node",
      external: name === "check" ? ["playwright-core"] : [],
      outdir: temp,
      naming: `${name}.${name === "check" ? "js" : "mjs"}`,
      // The fixture uses the SDK's declared WebSocket transport dependency.
      plugins: [
        {
          name: "sdk-test-dependencies",
          setup(build) {
            build.onResolve({ filter: /^ws$/ }, () => ({
              path: resolve("packages/plugin-sdk/node_modules/ws/index.js"),
            }));
          },
        },
      ],
    });
    assert.ok(result.success, String(result.logs));
  }
  await writeFile(join(temp, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temp, "key.pem"),
    "-out",
    join(temp, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=browser-target.test",
    "-addext",
    "subjectAltName=DNS:browser-target.test,DNS:ipwho.is,DNS:speed.cloudflare.com",
  ]);
  for (const [name, subnet] of [
    [controlNet, "172.29.77.0/24"],
    [targetNet, "11.77.0.0/24"],
  ] as const) {
    await command(
      docker(
        "network",
        "create",
        "--internal",
        "--subnet",
        subnet,
        "--label",
        "com.openteam.test=browser-network",
        name
      )
    );
    networks.push(name);
  }
  for (const volume of [workspaceVolume, dataVolume]) {
    await command(docker("volume", "create", volume));
    volumes.push(volume);
  }
  await command(
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${workspaceVolume}:/workspace`,
      "-v",
      `${dataVolume}:/data`,
      "--entrypoint",
      "sh",
      images.computer,
      "-c",
      "chown 1000:1000 /workspace /data && chmod 0770 /workspace /data"
    )
  );
  await run("postgres", [
    "-e",
    "POSTGRES_DB=network_test",
    "-e",
    "POSTGRES_USER=test",
    "-e",
    "POSTGRES_PASSWORD=test",
    "postgres:17-alpine",
  ]);
  await command(docker("start", names.postgres));
  for (let attempt = 0; ; attempt++) {
    try {
      await command(
        // The entrypoint briefly starts a Unix-socket-only bootstrap database.
        // Wait for the final TCP listener used by the actual application.
        docker(
          "exec",
          names.postgres,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "test",
          "-d",
          "network_test"
        )
      );
      break;
    } catch {
      if (attempt === 40) throw Error("PostgreSQL did not start");
      await Bun.sleep(250);
    }
  }
  await command(docker("run", "--rm", "--network", controlNet, ...env, images.migrate), {
    log: "schema.log",
  });
  await command(
    docker(
      "run",
      "--rm",
      "-i",
      "--network",
      controlNet,
      ...env,
      images.server,
      "bun",
      "main.js",
      "owner-credentials"
    ),
    {
      input: JSON.stringify({
        operation: "setup",
        username: "network_test",
        password: config.password,
      }),
      log: "owner-setup.log",
    }
  );
  await writeFile(
    join(temp, "node-with-test-ca"),
    '#!/bin/sh\nexport NODE_EXTRA_CA_CERTS=/tmp/cert.pem\nexec /usr/bin/node "$@"\n',
    { mode: 0o755 }
  );
  await run("computer", [
    "-e",
    "OPENTEAM_NODE_BINARY=/tmp/node-with-test-ca",
    "--shm-size=512m",
    // Match main's computer namespace/bootstrap requirements in this disposable VM.
    "--cap-add=ALL",
    "--security-opt=seccomp=unconfined",
    "--security-opt=apparmor=unconfined",
    "--security-opt=label=disable",
    "--security-opt=systempaths=unconfined",
    "--device=/dev/net/tun:/dev/net/tun",
    "--cgroupns=private",
    "--memory=3g",
    "--memory-swap=3g",
    "-v",
    `${workspaceVolume}:/workspace`,
    "-v",
    `${dataVolume}:/home/box/sand-data`,
    "-e",
    `OPENTEAM_CONTROL_TOKEN=${config.control}`,
    "-e",
    "OPENTEAM_SERVER_URL=http://server:8787",
    images.computer,
  ]);
  await command(
    docker("cp", join(temp, "config.json"), `${names.computer}:/tmp/network-test-config.json`)
  );
  await command(
    docker(
      "cp",
      join(temp, "check.js"),
      `${names.computer}:/app/apps/computer/dist/network-linux-check.js`
    )
  );
  for (const file of ["certutil", "cert.pem", "node-with-test-ca"])
    await command(docker("cp", join(temp, file), `${names.computer}:/tmp/${file}`));
  await run("server", [
    "-v",
    `${workspaceVolume}:/workspace`,
    "-v",
    `${dataVolume}:/home/box/agent-data`,
    ...env,
    images.server,
  ]);
  for (const [name, id, ip] of [
    ["device-a", config.a, "11.77.0.11"],
    ["device-b", config.b, "11.77.0.12"],
  ] as const) {
    await run(name, [
      "--dns",
      "11.77.0.80",
      "-e",
      `TEST_MACHINE_ID=${id}`,
      "-e",
      `TEST_LABEL=${name}`,
      "--entrypoint",
      "node",
      images.computer,
      "/tmp/device.mjs",
    ]);
    await command(docker("network", "connect", "--ip", ip, targetNet, names[name]));
    await command(docker("cp", join(temp, "device.mjs"), `${names[name]}:/tmp/device.mjs`));
  }
  containers.push(names.target);
  await command(
    docker(
      "create",
      "--name",
      names.target,
      "--network",
      targetNet,
      "--ip",
      "11.77.0.80",
      "--entrypoint",
      "node",
      images.computer,
      "/tmp/target.mjs"
    )
  );
  for (const file of ["target.mjs", "cert.pem", "key.pem"])
    await command(docker("cp", join(temp, file), `${names.target}:/tmp/${file}`));
  await command(docker("start", names.target, names.computer));
  for (let attempt = 0; ; attempt++) {
    try {
      await command(docker("exec", names.computer, "curl", "-sf", "http://127.0.0.1:8790/health"));
      break;
    } catch {
      if (attempt === 100) throw Error("Computer did not start");
      await Bun.sleep(100);
    }
  }
  await command(
    docker(
      "exec",
      names.computer,
      "sh",
      "-c",
      "mkdir -p /home/box/.pki/nssdb && /tmp/certutil -N --empty-password -d sql:/home/box/.pki/nssdb && /tmp/certutil -A -d sql:/home/box/.pki/nssdb -n isolated-network-test -t 'C,,' -i /tmp/cert.pem && chown -R 1000:1000 /home/box/.pki"
    )
  );
  await command(docker("start", names.server, names["device-a"], names["device-b"]));
  await writeFile(
    join(out, "image-identities.json"),
    await command(
      docker(
        "image",
        "inspect",
        ...Object.values(images),
        "--format",
        "{{json .RepoTags}} {{.Id}} {{.Architecture}}"
      )
    )
  );
  for (const phase of phases) {
    if (phase === "server-restart") await command(docker("restart", "--time", "3", names.server));
    if (phase === "computer-restart")
      await command(docker("restart", "--time", "3", names.computer));
    const blackholeAt = ["blackhole", "chaos-link-down"].includes(phase) ? Date.now() : 0;
    if (phase === "blackhole") await command(docker("pause", names["device-b"]));
    if (phase === "recovered") await command(docker("unpause", names["device-b"]));
    if (phase === "chaos-loss") {
      // Only this disposable provider's network namespace is modified.
      containers.push(names.netem);
      await command(
        docker(
          "create",
          "--name",
          names.netem,
          "--network",
          `container:${names["device-b"]}`,
          "--cap-add=NET_ADMIN",
          "--entrypoint",
          "sleep",
          "openteam-network-cert-tools:test",
          "600"
        )
      );
      await command(docker("start", names.netem));
      await command(
        docker(
          "exec",
          names.netem,
          "tc",
          "qdisc",
          "add",
          "dev",
          "eth0",
          "root",
          "netem",
          "delay",
          "80ms",
          "20ms",
          "loss",
          "2%",
          "seed",
          "42"
        )
      );
      await command(docker("exec", names.netem, "tc", "-s", "qdisc", "show", "dev", "eth0"), {
        log: "netem-config.log",
      });
    }
    if (phase === "chaos-clear") {
      const stats = await command(
        docker("exec", names.netem, "tc", "-s", "qdisc", "show", "dev", "eth0"),
        { log: "netem-result.log" }
      );
      assert.match(
        stats,
        /dropped [1-9]\d*/,
        "The packet-loss scenario must actually drop packets"
      );
      await command(docker("exec", names.netem, "tc", "qdisc", "del", "dev", "eth0", "root"));
    }
    if (phase === "chaos-relay") {
      // Expire the display-settings cache too: existing screen controls must
      // remain usable when the coordinator cannot serve a configuration refresh.
      await Bun.sleep(31_000);
      await command(docker("pause", names.server));
    }
    if (phase === "chaos-link-down" || phase === "chaos-link-recovered")
      await command(
        docker(
          "exec",
          names.netem,
          "ip",
          "link",
          "set",
          "eth0",
          phase === "chaos-link-down" ? "down" : "up"
        )
      );
    if (phase === "chaos-relay-recovered") await command(docker("unpause", names.server));
    if (phase === "chaos-all-offline")
      await command(docker("pause", names["device-a"], names["device-b"]));
    if (phase === "chaos-all-recovered")
      await command(docker("unpause", names["device-a"], names["device-b"]));
    console.log(`Running ${phase} checks`);
    await command(
      docker(
        "exec",
        "-e",
        `TEST_BLACKHOLE_STARTED_AT=${blackholeAt}`,
        names.computer,
        "bun",
        "/app/apps/computer/dist/network-linux-check.js",
        phase
      ),
      { log: `${phase}.log`, timeout: 360000, stream: true }
    );
  }
  await command(
    docker(
      "cp",
      `${names.computer}:/tmp/network-linux-browser.png`,
      join(out, "managed-linux-browser.png")
    )
  );
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(
      {
        passed: true,
        context,
        date: new Date().toISOString(),
        phases,
      },
      null,
      2
    )
  );
} finally {
  for (const [name, container] of Object.entries(names)) {
    if (!containers.includes(container)) continue;
    try {
      await command(docker("logs", "--tail", "200", container), { log: `${name}.log` });
    } catch {}
  }
  if (process.argv.includes("--keep"))
    console.log(`Retained test resources for debugging: ${prefix}`);
  else {
    for (const container of containers.reverse())
      await command(docker("rm", "-fv", container)).catch(() => {});
    for (const network of networks.reverse())
      await command(docker("network", "rm", network)).catch(() => {});
    for (const volume of volumes.reverse())
      await command(docker("volume", "rm", volume)).catch(() => {});
  }
  await rm(temp, { recursive: true, force: true });
}
