/** Isolated, authenticated production server + worker + Postgres + real Pi runtime.
 * No inference stubs. Requires the existing local computer image and signed-in
 * provider. Credentials travel through stdin into a disposable tmpfs only.
 * The control endpoint is loopback-only and exists only for this test process.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPrismaClient } from "../../../packages/db/src/index";

const root = resolve(process.env.SWIFT_REAL_QA_OUTPUT ?? "output/swift-live-gestures-0916");
await mkdir(root, { recursive: true });
const base = "http://127.0.0.1:20020";
const computerName = "openteam-swift-real-qa-0916";
const databaseName = `swiftqa_reallive_${Date.now()}`;
const runtimeRoot = join(root, databaseName);
const databaseURL = `postgresql://swiftqa:swiftqa-disposable-only@127.0.0.1:20002/${databaseName}`;
const username = "swift.live.qa", password = randomBytes(24).toString("hex");
const env = {
  ...process.env, DATABASE_URL: databaseURL, OPENTEAM_PORT: "20020",
  OPENTEAM_AUTH_MODE: "required", OPENTEAM_AUTH_URL: base,
  OPENTEAM_AUTH_SECRET: randomBytes(32).toString("hex"),
  OPENTEAM_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  OPENTEAM_COMPUTER_URL: "http://127.0.0.1:20021",
  OPENTEAM_SERVER_URL: "http://host.docker.internal:20020",
  OPENTEAM_AGENT_DATA_ROOT: join(runtimeRoot, "agent-data"),
  OPENTEAM_AGENT_DATA_CANONICAL_ROOT: join(runtimeRoot, "canonical-agent-data"),
  OPENTEAM_WORKSPACE_ROOT: join(runtimeRoot, "workspace"),
  OPENTEAM_ASSET_ROOT: join(runtimeRoot, "assets"),
  OPENTEAM_PI_AGENT_DIR: "/home/box/.pi/agent",
  OPENTEAM_BOX_STORE_ROOT: "/box-store", OPENTEAM_BOX_COPY_IN: "false",
  OPENTEAM_MEMORY_DREAMING: "false", OPENTEAM_TIME_ZONE: "America/New_York",
  OPENTEAM_WORKER_CONCURRENCY: "2",
};
// A simulator token must never be dispatched to the real APNs service.
for (const key of Object.keys(env)) if (key.startsWith("OPENTEAM_APNS_")) delete (env as any)[key];
const children: ReturnType<typeof Bun.spawn>[] = [];
let computerStarted = false;
const serverImage = process.env.SWIFT_REAL_QA_SERVER_IMAGE;
const serverName = "openteam-swift-qa-server";
let serverStarted = false;
let control: ReturnType<typeof Bun.serve> | undefined;
const prisma = createPrismaClient(databaseURL);
const run = async (cmd: string[], input?: string | Uint8Array, cwd = process.cwd(), processEnv = env) => {
  const p = Bun.spawn(cmd, { cwd, env: processEnv, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (input) { (p.stdin as any).write(input); (p.stdin as any).end(); }
  const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (status !== 0) throw new Error(`${cmd[0]} ${cmd[1]} failed: ${stderr.slice(-1800)}`);
  return stdout;
};
const cleanup = async () => {
  control?.stop(true);
  for (const p of children) p.kill();
  if (serverStarted) await run(["docker", "stop", "-t", "5", serverName]).catch(() => {});
  if (computerStarted) await run(["docker", "stop", "-t", "5", computerName]).catch(() => {});
  await prisma.$disconnect();
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));
try {
  // The gateway checks its unprivileged agent's workspace before the server
  // creates bot directories. This is a disposable, cross-UID container mount.
  await mkdir(env.OPENTEAM_WORKSPACE_ROOT, { recursive: true });
  await chmod(env.OPENTEAM_WORKSPACE_ROOT, 0o777);
  await run(["docker", "start", "openteam-swift-fullqa-db-0916"]);
  for (let attempt = 0; ; attempt++) {
    try { await run(["docker", "exec", "openteam-swift-fullqa-db-0916", "pg_isready", "-U", "swiftqa"]); break; }
    catch { if (attempt >= 60) throw new Error("QA PostgreSQL did not become ready"); await Bun.sleep(300); }
  }
  await run(["docker", "exec", "openteam-swift-fullqa-db-0916", "createdb", "-U", "swiftqa", databaseName]);
  await run(["bun", "run", "db:push"], undefined, resolve("packages/db"));
  // This database belongs exclusively to this harness; never reset a live owner.
  if (await prisma.user.count()) throw new Error("QA database already has an owner; use the running harness instead of resetting credentials.");
  await run(["bun", "apps/server/src/main.ts", "owner-credentials"], JSON.stringify({ operation: "setup", username, password }));
  const keys = ["OPENTEAM_CONTROL_TOKEN", "OPENTEAM_SERVER_URL", "OPENTEAM_AGENT_DATA_ROOT", "OPENTEAM_AGENT_DATA_CANONICAL_ROOT", "OPENTEAM_WORKSPACE_ROOT", "OPENTEAM_PI_AGENT_DIR", "OPENTEAM_BOX_STORE_ROOT", "OPENTEAM_BOX_COPY_IN", "OPENTEAM_TIME_ZONE"];
  await run(["bun", "build", "apps/computer/src/main.ts", "apps/computer/src/provider-cli.ts", "--outdir", join(root, "computer-build"), "--target", "bun", "--external", "@earendil-works/pi-coding-agent", "--external", "playwright-core"]);
  await run(["docker", "run", "-d", "--rm", "--name", computerName,
    "-p", "127.0.0.1:20021:8790", "--tmpfs", "/home/box:rw", "--tmpfs", "/box-store:rw",
    ...(process.env.SWIFT_VNC_QA === "1" ? ["-p", "127.0.0.1:20025:8791"] : []),
    "-v", `${root}:${root}`,
    "-v", `${root}/computer-build/main.js:/app/apps/computer/dist/main.js:ro`,
    "-v", `${root}/computer-build/provider-cli.js:/app/apps/computer/dist/provider-cli.js:ro`,
    ...keys.flatMap(key => ["-e", key]),
    "openteam-memory-computer:20260913"]);
  computerStarted = true;
  const credentials = await run(["docker", "exec", "openteam-computer-1", "cat", "/home/box/.pi/agent/auth.json"]);
  await run(["docker", "exec", "-i", computerName, "sh", "-c", "umask 077; cat > /home/box/.pi/agent/auth.json"], credentials);
  for (let attempt = 0; ; attempt++) {
    try {
      const health = await fetch(env.OPENTEAM_COMPUTER_URL + "/health", { signal: AbortSignal.timeout(2_000) });
      if (health.ok) break;
    } catch {}
    if (attempt >= 100) throw new Error("Real computer/provider did not become ready");
    await Bun.sleep(300);
  }
  if (serverImage) {
    const serverEnv = {
      ...env,
      DATABASE_URL: databaseURL.replace("@127.0.0.1:", "@host.docker.internal:"),
      OPENTEAM_COMPUTER_URL: "http://host.docker.internal:20021",
    };
    // Keep credentials in the child environment, never in argv or a checked-in file.
    const keys = Object.keys(serverEnv).filter(key => key === "DATABASE_URL" || key.startsWith("OPENTEAM_"));
    await run(["docker", "run", "-d", "--rm", "--name", serverName,
      "--user", `${process.getuid!()}:${process.getgid!()}`,
      "-p", "127.0.0.1:20020:20020", "-v", `${runtimeRoot}:${runtimeRoot}`,
      ...keys.flatMap(key => ["-e", key]), serverImage], undefined, process.cwd(), serverEnv);
    serverStarted = true;
  }
  for (const service of serverImage ? ["worker"] : ["server", "worker"]) children.push(Bun.spawn(["bun", `apps/${service}/src/main.ts`], {
    env, stdout: Bun.file(join(root, `${service}.log`)), stderr: Bun.file(join(root, `${service}-error.log`)),
  }));
  const deadline = Date.now() + 90_000;
  while (true) {
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(2_000) })).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("Production server did not start; inspect its logs");
    await Bun.sleep(300);
  }
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, rememberMe: true }) });
  if (!login.ok) throw new Error(`QA owner login failed (${login.status})`);
  const token = login.headers.get("set-auth-token")!;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const model = await fetch(base + "/api/v0/server-settings/inference", { method: "PATCH", headers, body: JSON.stringify({ providerId: "openai-codex", modelId: "gpt-5.5", reasoning: "low" }), signal: AbortSignal.timeout(45_000) });
  if (!model.ok) throw new Error(`Model selection failed (${model.status}): ${await model.text()}`);
  await writeFile(join(root, "environment.json"), JSON.stringify({ base, auth: "required", database: databaseName, server: serverImage ?? "current workspace", worker: "current workspace", computer: "current workspace bundle on existing Linux runtime image", computerImage: "openteam-memory-computer:20260913", model: "openai-codex/gpt-5.5", inferenceStub: false, apnsDeliveryConfigured: false }, null, 2));
  control = Bun.serve({ hostname: "127.0.0.1", port: 20022, async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    if (url.pathname === "/config") return Response.json({ base, username, password }, { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/state") return Response.json({
      bots: await prisma.bot.findMany({ select: { id: true, name: true, status: true } }),
      messages: await prisma.channelMessage.findMany({ select: { id: true, clientId: true, channelId: true, sender: true, senderBotId: true, content: true, metadata: true, sequence: true }, orderBy: { sequence: "asc" } }).then(rows => rows.map(row => ({ ...row, sequence: row.sequence.toString() }))),
      runs: await prisma.run.findMany({ select: { id: true, botId: true, status: true, error: true } }),
    });
    // Authenticated public API passthrough for test setup/assertions, never model output.
    if (url.pathname.startsWith("/api/")) return fetch(base + url.pathname + url.search, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
    return new Response(null, { status: 404 });
  }});
  console.log(`Real server ready: ${base}; isolated QA control on 127.0.0.1:20022`);
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  if (computerStarted) {
    const logs = await run(["docker", "logs", "--tail", "100", computerName]).catch(error => String(error));
    await writeFile(join(root, "computer-startup-error.log"), logs);
  }
  await cleanup();
  process.exit(1);
}
