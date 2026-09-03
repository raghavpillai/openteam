import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "apps/cli/dist/openteam.js");
const developmentCompose = join(repositoryRoot, "scripts/compose.sh");
const releaseCompose = join(repositoryRoot, "deploy/compose.yaml");
const testRunId = `${process.pid}-${randomBytes(3).toString("hex")}`;
const projectName = `openteam-e2e-${testRunId}`;
const temporaryRoot = mkdtempSync(join(tmpdir(), "openteam-cli-e2e-"));
const installationDirectory = join(temporaryRoot, "installation");
const releaseDirectory = join(temporaryRoot, "release");
const firstVersion = `0.0.0-e2e.${testRunId}.1`;
const secondVersion = `0.0.0-e2e.${testRunId}.2`;
const sourceImages = [
  "openteam-server:latest",
  "openteam-worker:latest",
  "openteam-migrate:latest",
  "openteam-computer:latest",
] as const;
const createdImageTags: string[] = [];
let developmentStopped = false;
let authToken: string | null = null;

const ownerUsername = "cli.e2e.owner";
const ownerPassword = "CLI E2E owner password";
const canaryProviderId = "openteam-e2e";
const canaryProviderName = "OpenTeam E2E provider";
const canaryModelId = "openteam-e2e-model";
const canaryResponseText = "OPENTEAM_PROVIDER_CANARY_OK";
const canarySecret = `openteam-e2e-${randomBytes(24).toString("hex")}`;

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

const cliCapture = (args: readonly string[], expectedStatus = 0) =>
  run("node", [cliPath, ...args], { expectedStatus, inherit: false });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const tclQuote = (value: string): string =>
  `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;

const cliInteractive = (args: readonly string[], input: string) => {
  if (process.platform === "darwin") {
    const answers = input.trimEnd().split("\n");
    const accessIndex = Number.parseInt(answers[0] ?? "", 10);
    const accessInput =
      Number.isInteger(accessIndex) && accessIndex >= 1 && accessIndex <= 5
        ? `${"\u001b[B".repeat(accessIndex - 1)}\r`
        : `${answers[0] ?? ""}\r`;
    const interactions = [
      ["Access mode", accessInput],
      ["OpenTeam username", `${answers[1] ?? ""}\r`],
      ["OpenTeam password:", `${answers[2] ?? ""}\r`],
      ["Confirm OpenTeam password:", `${answers[3] ?? ""}\r`],
      ["Inference provider", `${answers[4] ?? ""}\r`],
      ["Custom provider id", `${answers[5] ?? ""}\r`],
      ["Custom provider name", `${answers[6] ?? ""}\r`],
      ["Custom provider base URL", `${answers[7] ?? ""}\r`],
      ["Compatible API", `${answers[8] ?? ""}\r`],
      ["Inference model", `${answers[9] ?? ""}\r`],
      ["Does this model support reasoning?", `${answers[10] ?? ""}\r`],
      [`Configure ${canaryProviderId} authentication now?`, `${answers[11] ?? ""}\r`],
      [`${canaryProviderId} API key or password:`, `${answers[12] ?? ""}\r`],
      ["Apply this configuration?", `${answers[13] ?? ""}\r`],
    ] as const;
    const program = [
      "set timeout 300",
      "set env(TERM) xterm-256color",
      "unset -nocomplain env(NO_COLOR)",
      "proc expect_prompt {prompt} {",
      "  expect {",
      "    -exact $prompt {}",
      '    timeout { puts stderr "Timed out waiting for: $prompt"; exit 124 }',
      '    eof { puts stderr "CLI exited before prompt: $prompt"; exit 125 }',
      "  }",
      "}",
      `spawn node ${tclQuote(cliPath)} ${args.map(tclQuote).join(" ")}`,
      ...interactions.flatMap(([prompt, answer]) => [
        `expect_prompt ${tclQuote(prompt)}`,
        `send -- ${tclQuote(answer)}`,
      ]),
      "expect {",
      "  eof {}",
      '  timeout { puts stderr "Timed out waiting for CLI exit"; exit 124 }',
      "}",
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
  throw new Error("Timed out waiting for the development OpenTeam stack to recover");
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
      "openteam",
      "--dbname",
      "openteam",
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
  writeFileSync(join(versionDirectory, "openteam-compose.yaml"), releaseAsset);
  writeFileSync(
    join(versionDirectory, "SHA256SUMS"),
    `${releaseChecksum}  openteam-compose.yaml\n`
  );
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

const canBindPort = (port: number): Promise<boolean> =>
  new Promise((resolveResult) => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolveResult(true));
    });
  });

const waitForDevelopmentPortsToRelease = async (): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await canBindPort(8787)) && (await canBindPort(6200))) return;
    await Bun.sleep(500);
  }
  throw new Error("Timed out waiting for development ports 8787 and 6200 to be released");
};

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

const canaryPort = await availablePort();
let canaryRequestCount = 0;
let canaryVisibleDeliveryCount = 0;
let canaryMemoryInferenceCount = 0;
const canaryFailures: string[] = [];
const canaryServer = Bun.serve({
  hostname: "0.0.0.0",
  port: canaryPort,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${canarySecret}`) {
      canaryFailures.push("The inference request did not contain the configured provider secret");
      return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      body.model !== canaryModelId ||
      body.stream !== true ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      canaryFailures.push("The inference request was not a valid streamed chat completion");
      return Response.json({ error: { message: "invalid request" } }, { status: 400 });
    }
    canaryRequestCount += 1;
    const id = `chatcmpl-openteam-e2e-${canaryRequestCount}`;
    const created = Math.floor(Date.now() / 1_000);
    const messages = body.messages as Array<Record<string, unknown>>;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasSendToUser = JSON.stringify(tools).includes('"SendToUser"');
    const followsToolResult = messages.at(-1)?.role === "tool";
    let choices: Array<Record<string, unknown>>;
    if (hasSendToUser && !followsToolResult) {
      canaryVisibleDeliveryCount += 1;
      choices = [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-openteam-e2e-${canaryVisibleDeliveryCount}`,
                type: "function",
                function: {
                  name: "SendToUser",
                  arguments: JSON.stringify({ type: "text", content: canaryResponseText }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ];
    } else if (hasSendToUser) {
      choices = [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }];
    } else {
      canaryMemoryInferenceCount += 1;
      const input = JSON.stringify(messages);
      const content = input.includes("SAND_MEMORY_EPISODE")
        ? '{"narrative":null}'
        : input.includes("SAND_MEMORY_SYNTHESIS_VERIFICATION")
          ? '{"approved":false}'
          : input.includes("SAND_MEMORY_SYNTHESIS")
            ? '{"changes":[]}'
            : '{"facts":[]}';
      choices = [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }];
    }
    const chunks = [
      {
        id,
        object: "chat.completion.chunk",
        created,
        model: canaryModelId,
        choices,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const stream = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  },
});

const canaryBaseUrl = `http://host.docker.internal:${canaryPort}/v1`;

const releaseUrls = (version: string) => {
  const base = `http://127.0.0.1:${releasePort}/v${version}`;
  return ["--compose-url", `${base}/openteam-compose.yaml`, "--checksum-url", `${base}/SHA256SUMS`];
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

type CanaryBot = { id: string; conversationId: string };

type ConversationSnapshot = {
  messages?: Array<{ content?: unknown; sourceRunId?: unknown }>;
  runs?: Array<{ id?: unknown; status?: unknown; error?: unknown }>;
};

const conversationSnapshot = async (conversationId: string): Promise<ConversationSnapshot> => {
  const response = await fetch(
    `http://127.0.0.1:8787/api/v0/conversations/${encodeURIComponent(conversationId)}`,
    { headers: authorizationHeaders() }
  );
  const body = (await response.json()) as ConversationSnapshot & { error?: unknown };
  if (!response.ok) {
    throw new Error(
      `Could not read the E2E conversation (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return body;
};

const createCanaryBot = async (): Promise<CanaryBot> => {
  const response = await fetch("http://127.0.0.1:8787/api/v0/bots", {
    method: "POST",
    headers: { "content-type": "application/json", ...authorizationHeaders() },
    body: JSON.stringify({
      clientRequestId: randomUUID(),
      name: "CLI E2E provider canary",
      instructions: "Reply directly and do not call tools.",
    }),
  });
  const body = (await response.json()) as {
    id?: unknown;
    conversationId?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.id !== "string" || typeof body.conversationId !== "string") {
    throw new Error(
      `Could not create the E2E canary bot (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return { id: body.id, conversationId: body.conversationId };
};

const completeCanaryTurn = async (conversationId: string): Promise<void> => {
  const before = await conversationSnapshot(conversationId);
  const previousRunIds = new Set(
    (before.runs ?? []).map((run) => run.id).filter((id): id is string => typeof id === "string")
  );
  const requestCountBefore = canaryRequestCount;
  const response = await fetch(
    `http://127.0.0.1:8787/api/v0/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authorizationHeaders() },
      body: JSON.stringify({
        content: "Reply with the provider canary response.",
        attachments: [],
        clientId: randomUUID(),
        timeZone: "UTC",
      }),
    }
  );
  const accepted = await response.text();
  if (!response.ok) {
    throw new Error(`The E2E canary message was rejected (${response.status}): ${accepted}`);
  }

  const deadline = Date.now() + 150_000;
  let latest: ConversationSnapshot = {};
  while (Date.now() < deadline) {
    latest = await conversationSnapshot(conversationId);
    const newRuns = (latest.runs ?? []).filter(
      (run) => typeof run.id === "string" && !previousRunIds.has(run.id)
    );
    const failed = newRuns.find(
      (run) =>
        typeof run.status === "string" &&
        ["failed", "cancelled", "interrupted"].includes(run.status)
    );
    if (failed) {
      throw new Error(`The E2E provider turn failed: ${JSON.stringify(failed)}`);
    }
    const completedRunIds = new Set(
      newRuns
        .filter((run) => run.status === "completed")
        .map((run) => run.id)
        .filter((id): id is string => typeof id === "string")
    );
    const completedMessage = (latest.messages ?? []).find(
      (message) =>
        typeof message.sourceRunId === "string" &&
        completedRunIds.has(message.sourceRunId) &&
        typeof message.content === "string" &&
        message.content.includes(canaryResponseText)
    );
    if (completedMessage) {
      if (canaryFailures.length) throw new Error(canaryFailures.join("; "));
      if (canaryRequestCount <= requestCountBefore) {
        throw new Error("The completed E2E turn did not reach the configured provider");
      }
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for the E2E provider turn: ${JSON.stringify(latest.runs)}`);
};

const waitForMemoryInference = async (minimumCount: number): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (canaryMemoryInferenceCount >= minimumCount) return;
    await Bun.sleep(250);
  }
  throw new Error(
    `Expected at least ${minimumCount} memory inference calls; received ${canaryMemoryInferenceCount}`
  );
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

const environmentValue = (contents: string, key: string): string | undefined => {
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
};

const runningServiceContainer = (service: string): string => {
  const containers = resultText(
    docker([
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (containers.length !== 1 || !containers[0]) {
    throw new Error(`Expected one running ${service} container; found ${containers.length}`);
  }
  return containers[0];
};

const assertProviderConfiguration = (thinking: string): void => {
  const environmentPath = join(installationDirectory, ".env");
  const environment = readFileSync(environmentPath, "utf8");
  const runtimeKeys = ["OPENTEAM_PI_PROVIDER", "OPENTEAM_PI_MODEL", "OPENTEAM_PI_THINKING"];
  for (const key of runtimeKeys) {
    if (environmentValue(environment, key) !== undefined) {
      throw new Error(`${key} must not be persisted in the installation environment`);
    }
  }
  if (environment.includes(canarySecret)) {
    throw new Error("The provider secret leaked into the installation environment");
  }
  if ((statSync(environmentPath).mode & 0o777) !== 0o600) {
    throw new Error("The installation environment is not mode 0600");
  }
  for (const file of ["installation.json", "compose.yaml"]) {
    if (readFileSync(join(installationDirectory, file), "utf8").includes(canarySecret)) {
      throw new Error(`The provider secret leaked into ${file}`);
    }
  }

  const providers = resultText(cliCapture(["provider", "list", "--dir", installationDirectory]));
  if (!providers.includes(canaryProviderId) || !providers.includes(canaryProviderName)) {
    throw new Error(`The custom provider is missing from provider list:\n${providers}`);
  }
  const models = resultText(
    cliCapture(["model", "list", canaryProviderId, "--dir", installationDirectory])
  );
  if (!models.includes(`${canaryProviderId}/${canaryModelId}`)) {
    throw new Error(`The custom model is missing from model list:\n${models}`);
  }

  const computer = runningServiceContainer("computer");
  const selection = JSON.parse(
    resultText(docker(["exec", computer, "openteam-pi-auth", "selection"]))
  ) as Record<string, unknown>;
  if (
    selection.providerId !== canaryProviderId ||
    selection.modelId !== canaryModelId ||
    selection.reasoning !== thinking
  ) {
    throw new Error(`Unexpected durable inference settings: ${JSON.stringify(selection)}`);
  }
  const config = resultText(docker(["inspect", "--format", "{{json .Config}}", computer]));
  if (config.includes(canarySecret)) {
    throw new Error("The provider secret leaked into the computer container configuration");
  }
  const parsed = JSON.parse(config) as { Env?: unknown };
  const containerEnvironment = Array.isArray(parsed.Env) ? parsed.Env : [];
  for (const key of runtimeKeys) {
    if (containerEnvironment.some((entry) => String(entry).startsWith(`${key}=`))) {
      throw new Error(`The live computer container must not receive ${key}`);
    }
  }

  docker([
    "exec",
    computer,
    "sh",
    "-lc",
    [
      'test "$(stat -c %a /home/box/.pi/agent)" = 700',
      'test "$(stat -c %a /home/box/.pi/agent/auth.json)" = 600',
      'test "$(stat -c %a /home/box/.pi/agent/models.json)" = 600',
      "test -s /home/box/.pi/agent/auth.json",
      "test -s /home/box/.pi/agent/models.json",
    ].join(" && "),
  ]);
  docker([
    "exec",
    "--user",
    "1001:1001",
    computer,
    "sh",
    "-lc",
    "test ! -r /home/box/.pi/agent/auth.json",
  ]);
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
  run("bun", ["--filter", "@openteam/cli", "build"]);
  tagImages();

  console.log("\n[E2E] Stopping the idle development stack to release loopback ports…");
  run("bash", [developmentCompose, "stop"]);
  developmentStopped = true;
  await waitForDevelopmentPortsToRelease();

  console.log("\n[E2E] Installing a checksum-verified release with isolated Docker volumes…");
  cliInteractive(
    [
      "install",
      "--dir",
      installationDirectory,
      "--project-name",
      projectName,
      "--image-prefix",
      "openteam",
      "--version",
      firstVersion,
      "--allow-prerelease",
      "--allow-unsigned",
      ...releaseUrls(firstVersion),
    ],
    [
      "5",
      ownerUsername,
      ownerPassword,
      ownerPassword,
      "4",
      canaryProviderId,
      canaryProviderName,
      canaryBaseUrl,
      "2",
      canaryModelId,
      "no",
      "yes",
      canarySecret,
      "yes",
      "",
    ].join("\n")
  );
  await signInOwner();
  cli(["doctor", "--dir", installationDirectory]);
  cli(["status", "--dir", installationDirectory]);
  assertProviderConfiguration("high");

  console.log("\n[E2E] Applying and verifying a live model setting change…");
  cli([
    "model",
    "use",
    canaryProviderId,
    canaryModelId,
    "--thinking",
    "low",
    "--dir",
    installationDirectory,
  ]);
  assertProviderConfiguration("low");
  const selectedInference = resultText(
    docker(["exec", runningServiceContainer("computer"), "openteam-pi-auth", "selection"])
  );
  const invalidSelection = resultText(
    cliCapture(
      ["model", "use", canaryProviderId, "missing-model", "--dir", installationDirectory],
      1
    )
  );
  if (!invalidSelection.includes("does not provide")) {
    throw new Error(`Invalid model selection failed unclearly:\n${invalidSelection}`);
  }
  const inferenceAfterRejection = resultText(
    docker(["exec", runningServiceContainer("computer"), "openteam-pi-auth", "selection"])
  );
  if (inferenceAfterRejection !== selectedInference) {
    throw new Error("A rejected model selection changed the durable inference settings");
  }
  const activeRemoval = resultText(
    cliCapture(["provider", "remove", canaryProviderId, "--dir", installationDirectory], 1)
  );
  if (!activeRemoval.includes("Select a model from another provider")) {
    throw new Error(`Active provider removal failed unclearly:\n${activeRemoval}`);
  }

  const canaryBot = await createCanaryBot();
  await completeCanaryTurn(canaryBot.conversationId);

  const markerId = canaryBot.id;

  console.log("\n[E2E] Verifying stop and start…");
  cli(["stop", "--dir", installationDirectory]);
  cli(["status", "--dir", installationDirectory], 2);
  cli(["start", "--dir", installationDirectory]);
  assertProviderConfiguration("low");
  await assertPersistenceMarker(markerId);
  await completeCanaryTurn(canaryBot.conversationId);

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
  assertProviderConfiguration("low");
  await assertPersistenceMarker(markerId);
  await completeCanaryTurn(canaryBot.conversationId);
  const manifest = JSON.parse(
    readFileSync(join(installationDirectory, "installation.json"), "utf8")
  ) as { version?: unknown; projectName?: unknown };
  if (manifest.version !== secondVersion || manifest.projectName !== projectName) {
    throw new Error(`Update manifest is incorrect: ${JSON.stringify(manifest)}`);
  }

  console.log("\n[E2E] Verifying safe uninstall, recovery, and persisted data…");
  cli(["uninstall", "--dir", installationDirectory, "--yes"]);
  docker(["volume", "inspect", `${projectName}_openteam_postgres`]);
  cli(["start", "--dir", installationDirectory]);
  assertProviderConfiguration("low");
  await assertPersistenceMarker(markerId);
  await completeCanaryTurn(canaryBot.conversationId);
  await waitForMemoryInference(4);

  for (const service of ["server", "worker"]) {
    const logs = resultText(docker(["logs", runningServiceContainer(service)]));
    if (/EACCES|permission denied/i.test(logs)) {
      throw new Error(`The isolated ${service} logged a permission failure:\n${logs}`);
    }
  }
  if (canaryFailures.length) throw new Error(canaryFailures.join("; "));
  if (canaryVisibleDeliveryCount < 4 || canaryMemoryInferenceCount < 4 || canaryRequestCount < 12) {
    throw new Error(
      `Expected four visible deliveries, four memory inferences, and at least twelve provider calls; received ${canaryVisibleDeliveryCount}, ${canaryMemoryInferenceCount}, and ${canaryRequestCount}`
    );
  }

  console.log("\n[E2E] Verifying explicit purge…");
  cli(["uninstall", "--dir", installationDirectory, "--purge", "--yes"]);
  if (existsSync(installationDirectory)) throw new Error("Purge left the installation directory");
  docker(["volume", "inspect", `${projectName}_openteam_postgres`], 1);

  console.log("\nCLI end-to-end release lifecycle passed.");
};

try {
  await main();
} finally {
  canaryServer.stop(true);
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
    console.log("\n[E2E] Restoring the development OpenTeam stack…");
    run("bash", [developmentCompose, "up", "--detach"]);
    await waitForHealth();
    console.log("[E2E] Development stack restored and healthy.");
  }
}
