import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "apps/cli/dist/openbot.js");
const developmentCompose = join(repositoryRoot, "scripts/compose.sh");
const releaseCompose = join(repositoryRoot, "deploy/compose.yaml");
const projectName = `openbot-e2e-${process.pid}-${randomBytes(3).toString("hex")}`;
const temporaryRoot = mkdtempSync(join(tmpdir(), "openbot-cli-e2e-"));
const installationDirectory = join(temporaryRoot, "installation");
const releaseDirectory = join(temporaryRoot, "release");
const firstVersion = "0.0.0-e2e.1";
const secondVersion = "0.0.0-e2e.2";
const sourceImages = [
  "openbot-server:latest",
  "openbot-worker:latest",
  "openbot-migrate:latest",
  "openbot-computer:latest",
] as const;
const createdImageTags: string[] = [];
let developmentStopped = false;
let authToken: string | null = null;

const ownerUsername = "cli.e2e.owner";
const ownerPassword = "CLI E2E owner password";

const resultText = (value: ReturnType<typeof spawnSync>): string =>
  [value.stdout, value.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .trim();

const run = (
  command: string,
  args: readonly string[],
  options: { expectedStatus?: number; inherit?: boolean; input?: string } = {}
) => {
  const result = spawnSync(command, [...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    input: options.input,
    stdio:
      options.inherit === false
        ? "pipe"
        : options.input === undefined
          ? "inherit"
          : ["pipe", "inherit", "inherit"],
    shell: false,
  });
  const expectedStatus = options.expectedStatus ?? 0;
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}; expected ${expectedStatus}${
        resultText(result) ? `\n${resultText(result)}` : ""
      }`
    );
  }
  return result;
};

const docker = (args: readonly string[], expectedStatus = 0) =>
  run("docker", args, { expectedStatus, inherit: false });

const dockerProbe = (args: readonly string[]) =>
  spawnSync("docker", [...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
  });

const cli = (args: readonly string[], expectedStatus = 0) =>
  run("node", [cliPath, ...args], { expectedStatus });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const tclQuote = (value: string): string =>
  `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;

const cliInteractive = (args: readonly string[], input: string) => {
  if (process.platform === "darwin") {
    const answers = input.trimEnd().split("\n");
    const interactions = [
      ["Access mode", answers[0]],
      ["OpenBot username", answers[1]],
      ["OpenBot password:", answers[2]],
      ["Confirm OpenBot password:", answers[3]],
      ["Sign in to OpenAI Codex now?", answers[4]],
      ["Apply this configuration?", answers[5]],
    ] as const;
    const program = [
      "set timeout 300",
      `spawn node ${tclQuote(cliPath)} ${args.map(tclQuote).join(" ")}`,
      ...interactions.flatMap(([prompt, answer]) => [
        `expect ${tclQuote(prompt)}`,
        `send -- ${tclQuote(`${answer ?? ""}\r`)}`,
      ]),
      "expect eof",
      "set child_status [wait]",
      "exit [lindex $child_status 3]",
    ].join("\n");
    return run("expect", ["-c", program]);
  }
  const command = ["node", cliPath, ...args].map(shellQuote).join(" ");
  return run("script", ["-qefc", command, "/dev/null"], { input });
};

const authorizationHeaders = (): Record<string, string> => {
  if (!authToken) throw new Error("The CLI E2E owner has not signed in");
  return { authorization: `Bearer ${authToken}` };
};

const waitForHealth = async (timeoutMs = 180_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8787/api/v0/health", {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // A stopped or starting stack is expected while polling.
    }
    await Bun.sleep(1_000);
  }
  throw new Error("Timed out waiting for the development OpenBot stack to recover");
};

const developmentDatabaseCount = (sql: string): number => {
  const result = run(
    "bash",
    [
      developmentCompose,
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--username",
      "openbot",
      "--dbname",
      "openbot",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ],
    { inherit: false }
  );
  const count = Number.parseInt(resultText(result), 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Could not read a development database count: ${resultText(result)}`);
  }
  return count;
};

const assertNoActiveWork = async (): Promise<void> => {
  // Query the local database instead of weakening or bypassing required HTTP authentication.
  const activeRuns = developmentDatabaseCount(
    `SELECT count(*) FROM "Run" WHERE status IN ('running', 'queued')`
  );
  const pendingApprovals = developmentDatabaseCount(
    `SELECT count(*) FROM "Approval" WHERE status = 'pending'`
  );
  if (activeRuns || pendingApprovals) {
    throw new Error(
      `Refusing to stop the development stack: ${activeRuns} active runs and ${pendingApprovals} pending approvals`
    );
  }
};

const localReleaseCompose = (): string =>
  readFileSync(releaseCompose, "utf8").replace(
    /^(\s{4}image:\s.+)$/gm,
    "$1\n    pull_policy: never"
  );

const releaseAsset = localReleaseCompose();
const releaseChecksum = createHash("sha256").update(releaseAsset).digest("hex");

for (const version of [firstVersion, secondVersion]) {
  const versionDirectory = join(releaseDirectory, `v${version}`);
  mkdirSync(versionDirectory, { recursive: true });
  writeFileSync(join(versionDirectory, "openbot-compose.yaml"), releaseAsset);
  writeFileSync(join(versionDirectory, "SHA256SUMS"), `${releaseChecksum}  openbot-compose.yaml\n`);
}

const availablePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a release fixture port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });

const releasePort = await availablePort();
const fixtureServerSource = `
  import { join, normalize } from "node:path";
  const root = ${JSON.stringify(releaseDirectory)};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: ${releasePort},
    async fetch(request) {
      const pathname = normalize(new URL(request.url).pathname)
        .replace(/^(?:\\.\\.[/\\\\])+/, "")
        .replace(/^[/\\\\]+/, "");
      const file = Bun.file(join(root, pathname));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  console.log("ready");
`;
const releaseServer = Bun.spawn(["bun", "-e", fixtureServerSource], {
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "inherit",
});
const releaseReader = releaseServer.stdout.getReader();
const releaseReady = await releaseReader.read();
releaseReader.releaseLock();
if (!releaseReady.value || !new TextDecoder().decode(releaseReady.value).includes("ready")) {
  throw new Error("Release fixture server did not start");
}

const releaseUrls = (version: string) => {
  const base = `http://127.0.0.1:${releasePort}/v${version}`;
  return ["--compose-url", `${base}/openbot-compose.yaml`, "--checksum-url", `${base}/SHA256SUMS`];
};

const tagImages = (): void => {
  for (const source of sourceImages) {
    docker(["image", "inspect", source]);
    const repository = source.slice(0, source.lastIndexOf(":"));
    for (const version of [firstVersion, secondVersion]) {
      const target = `${repository}:${version}`;
      const existing = dockerProbe(["image", "inspect", target]);
      if (existing.status !== 0) {
        docker(["image", "tag", source, target]);
        createdImageTags.push(target);
      }
    }
  }
};

const createPersistenceMarker = async (): Promise<string> => {
  const response = await fetch("http://127.0.0.1:8787/api/v0/bots", {
    method: "POST",
    headers: { "content-type": "application/json", ...authorizationHeaders() },
    body: JSON.stringify({ clientRequestId: randomUUID(), name: "CLI E2E persistence marker" }),
  });
  const body = (await response.json()) as { id?: unknown; error?: unknown };
  if (!response.ok || typeof body.id !== "string") {
    throw new Error(
      `Could not create persistence marker (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return body.id;
};

const assertPersistenceMarker = async (id: string): Promise<void> => {
  const response = await fetch("http://127.0.0.1:8787/api/v0/client-snapshot", {
    headers: authorizationHeaders(),
  });
  const snapshot = (await response.json()) as { bots?: Array<{ id?: string }> };
  if (!response.ok || !(snapshot.bots ?? []).some((bot) => bot.id === id)) {
    throw new Error("The persistence marker did not survive the lifecycle operation");
  }
};

const signInOwner = async (): Promise<void> => {
  const response = await fetch("http://127.0.0.1:8787/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ownerUsername, password: ownerPassword, rememberMe: true }),
  });
  const responseBody = await response.text();
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) {
    throw new Error(`Could not sign in the CLI E2E owner (${response.status}): ${responseBody}`);
  }
  authToken = token;
};

const cleanupProject = (): void => {
  const containers = resultText(
    docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (containers.length) docker(["container", "rm", "--force", ...containers]);
  const volumes = resultText(
    docker([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (volumes.length) docker(["volume", "rm", ...volumes]);
  const networks = resultText(
    docker([
      "network",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (networks.length) docker(["network", "rm", ...networks]);
};

const main = async (): Promise<void> => {
  writeFileSync(join(temporaryRoot, "test-started"), new Date().toISOString());
  await assertNoActiveWork();
  run("bun", ["--filter", "@openbot/cli", "build"]);
  tagImages();

  console.log("\n[E2E] Stopping the idle development stack to release loopback ports…");
  run("bash", [developmentCompose, "stop"]);
  developmentStopped = true;

  console.log("\n[E2E] Installing a checksum-verified release with isolated Docker volumes…");
  cliInteractive(
    [
      "install",
      "--dir",
      installationDirectory,
      "--project-name",
      projectName,
      "--image-prefix",
      "openbot",
      "--version",
      firstVersion,
      "--allow-prerelease",
      "--allow-unsigned",
      ...releaseUrls(firstVersion),
    ],
    ["5", ownerUsername, ownerPassword, ownerPassword, "no", "yes", ""].join("\n")
  );
  await signInOwner();
  cli(["doctor", "--dir", installationDirectory]);
  cli(["status", "--dir", installationDirectory]);

  const markerId = await createPersistenceMarker();

  console.log("\n[E2E] Verifying stop and start…");
  cli(["stop", "--dir", installationDirectory]);
  cli(["status", "--dir", installationDirectory], 2);
  cli(["start", "--dir", installationDirectory]);
  await assertPersistenceMarker(markerId);

  console.log("\n[E2E] Updating to a second checksum-verified version…");
  cli([
    "update",
    "--dir",
    installationDirectory,
    "--version",
    secondVersion,
    "--allow-prerelease",
    "--allow-unsigned",
    ...releaseUrls(secondVersion),
  ]);
  cli(["status", "--dir", installationDirectory]);
  const manifest = JSON.parse(
    readFileSync(join(installationDirectory, "installation.json"), "utf8")
  ) as { version?: unknown; projectName?: unknown };
  if (manifest.version !== secondVersion || manifest.projectName !== projectName) {
    throw new Error(`Update manifest is incorrect: ${JSON.stringify(manifest)}`);
  }

  console.log("\n[E2E] Verifying safe uninstall, recovery, and persisted data…");
  cli(["uninstall", "--dir", installationDirectory, "--yes"]);
  docker(["volume", "inspect", `${projectName}_openbot_postgres`]);
  cli(["start", "--dir", installationDirectory]);
  await assertPersistenceMarker(markerId);

  console.log("\n[E2E] Verifying explicit purge…");
  cli(["uninstall", "--dir", installationDirectory, "--purge", "--yes"]);
  if (existsSync(installationDirectory)) throw new Error("Purge left the installation directory");
  docker(["volume", "inspect", `${projectName}_openbot_postgres`], 1);

  console.log("\nCLI end-to-end release lifecycle passed.");
};

try {
  await main();
} finally {
  releaseServer.kill();
  await releaseServer.exited;
  try {
    if (existsSync(join(installationDirectory, "installation.json"))) {
      cli(["uninstall", "--dir", installationDirectory, "--purge", "--yes"]);
    }
  } catch (error) {
    console.error("CLI cleanup fallback failed", error);
  }
  try {
    cleanupProject();
  } catch (error) {
    console.error("Docker cleanup fallback failed", error);
  }
  for (const tag of createdImageTags) docker(["image", "rm", tag]);
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (developmentStopped) {
    console.log("\n[E2E] Restoring the development OpenBot stack…");
    run("bash", [developmentCompose, "up", "--detach"]);
    await waitForHealth();
    console.log("[E2E] Development stack restored and healthy.");
  }
}
