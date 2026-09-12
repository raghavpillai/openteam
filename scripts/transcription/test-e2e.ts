/** Disposable PostgreSQL + real app server + native Chromium capture + configured STT service.
 * macOS example: bun scripts/transcription/test-e2e.ts --api-key-file ~/.local/share/openteam/transcription/api-key
 * Does not modify the installed server, access the physical microphone, or send chat messages.
 */
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createOpenTeamClient } from "../../packages/client-core/src/client";
import { createOpenTeamAuthClient } from "../../packages/client-core/src/auth";
import { checkTranscription } from "../../apps/cli/src/transcription-check";
import { installationPaths } from "../../apps/cli/src/config";
import { testNativeVoiceNote } from "./test-native";

const argument = (name: string, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const repository = resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(join(tmpdir(), "openteam-transcription-e2e-"));
const name = `openteam-transcription-qa-${randomUUID().slice(0, 8)}`;
const secret = () => randomBytes(32).toString("hex");
const dbPassword = secret(),
  controlToken = secret(),
  authSecret = secret(),
  ownerPassword = secret();
const providerUrl = argument("--provider-url", "http://127.0.0.1:18080/v1");
const model = argument("--model", "mlx-community/parakeet-tdt-0.6b-v3");
const keyFile = argument("--api-key-file");
const apiKey = keyFile ? (await readFile(resolve(keyFile), "utf8")).trim() : undefined;
const reports: unknown[] = [];
let server: ReturnType<typeof Bun.spawn> | undefined;
let createdDatabase = false;
let nativeDatabase = false;
let passed = false;
const computer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === "/health"
      ? Response.json({ status: "ready", inference: { ready: true, authenticated: true } })
      : Response.json({ ok: true });
  },
});
const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reserved.port!;
await reserved.stop(true);
const baseUrl = `http://127.0.0.1:${port}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  OPENTEAM_PORT: String(port),
  OPENTEAM_SERVER_HOST: "127.0.0.1",
  OPENTEAM_AUTH_MODE: "required",
  OPENTEAM_AUTH_URL: baseUrl,
  OPENTEAM_AUTH_SECRET: authSecret,
  OPENTEAM_CONTROL_TOKEN: controlToken,
  OPENTEAM_AGENT_DATA_ROOT: join(directory, "agent-data"),
  OPENTEAM_WORKSPACE_ROOT: join(directory, "workspace"),
  OPENTEAM_ASSET_ROOT: join(directory, "assets"),
  OPENTEAM_COMPUTER_URL: computer.url.origin,
};
const run = async (command: string[], options: { env?: typeof env; input?: string } = {}) => {
  const child = Bun.spawn(command, {
    cwd: repository,
    env: options.env ?? env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 180_000);
  if (options.input !== undefined) {
    (child.stdin as any).write(options.input);
    (child.stdin as any).end();
  }
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(deadline);
  if (status !== 0) throw new Error(`${command[0]} failed (${status}): ${stderr.slice(-3000)}`);
  return stdout.trim();
};
const waitFor = async (ready: () => Promise<boolean>, label: string, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (!(await ready().catch(() => false))) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}; logs: ${directory}`);
    await Bun.sleep(200);
  }
};
const record = (name: string, details?: unknown) => {
  reports.push({ name, details });
  console.log(`PASS ${name}${details ? ` ${JSON.stringify(details)}` : ""}`);
};
try {
  if (process.argv.includes("--native-postgres")) {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const dbPort = reservation.port!;
    await reservation.stop(true);
    const passwordFile = join(directory, "postgres-password");
    await writeFile(passwordFile, dbPassword, { mode: 0o600 });
    await run([
      "initdb",
      "-D",
      join(directory, "postgres"),
      "-U",
      "openteam_qa",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--no-locale",
    ]);
    await rm(passwordFile);
    await run([
      "pg_ctl",
      "-D",
      join(directory, "postgres"),
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${dbPort}`,
      "-w",
      "start",
    ]);
    nativeDatabase = true;
    await run(
      ["createdb", "-h", "127.0.0.1", "-p", String(dbPort), "-U", "openteam_qa", "openteam_qa"],
      { env: { ...env, PGPASSWORD: dbPassword } }
    );
    env.DATABASE_URL = `postgresql://openteam_qa:${dbPassword}@127.0.0.1:${dbPort}/openteam_qa`;
  } else {
    await run(
      [
        "docker",
        "run",
        "--detach",
        "--name",
        name,
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        "POSTGRES_USER=openteam_qa",
        "--env",
        "POSTGRES_DB=openteam_qa",
        "--publish",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      ],
      { env: { ...env, POSTGRES_PASSWORD: dbPassword } }
    );
    createdDatabase = true;
    const dbPort = JSON.parse(
      await run([
        "docker",
        "inspect",
        name,
        "--format",
        '{{json (index .NetworkSettings.Ports "5432/tcp")}}',
      ])
    )[0].HostPort;
    env.DATABASE_URL = `postgresql://openteam_qa:${dbPassword}@127.0.0.1:${dbPort}/openteam_qa`;
    await waitFor(async () => {
      await run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "openteam_qa"]);
      return true;
    }, "test database");
  }
  await run([process.execPath, "packages/db/scripts/deploy-schema.ts"]);
  await run([process.execPath, "apps/server/src/main.ts", "owner-credentials"], {
    input: JSON.stringify({ operation: "setup", username: "voice.qa", password: ownerPassword }),
  });
  server = Bun.spawn([process.execPath, "apps/server/src/main.ts"], {
    cwd: repository,
    env,
    stdout: Bun.file(join(directory, "server.log")),
    stderr: Bun.file(join(directory, "server.log")),
  });
  await waitFor(async () => (await fetch(`${baseUrl}/api/v0/health`)).ok, "current app server");
  record("disposable current server boots with real PostgreSQL and owner authentication");

  for (const [path, method] of [
    ["/api/v0/transcriptions", "POST"],
    ["/api/v0/server-settings/transcription", "GET"],
    ["/api/v0/internal/server-settings/transcription/check", "POST"],
  ]) {
    assert.equal(
      (await fetch(baseUrl + path, { method })).status,
      401,
      `${path} requires authentication`
    );
  }
  record("audio, settings, and internal doctor endpoints reject unauthenticated requests");
  const { token } = await createOpenTeamAuthClient({ baseUrl }).signIn("voice.qa", ownerPassword);
  const client = createOpenTeamClient({ baseUrl, getAuthToken: () => token });
  assert.equal((await client.transcriptionSettings()).configured, false);
  assert.equal((await client.runtime()).runtime.transcription, "missing");
  await assert.rejects(
    client.transcribeAudio(new Blob([new Uint8Array(128)], { type: "audio/wav" })),
    /Set up transcription/
  );
  record("missing configuration disables runtime capability and refuses audio");

  const settings = {
    enabled: true,
    provider: "openai-compatible" as const,
    baseUrl: providerUrl,
    model,
    language: "",
  };
  const saved = await client.updateTranscriptionSettings({ ...settings, apiKey });
  assert.equal(saved.configured, true);
  if (apiKey) {
    assert(!JSON.stringify(saved).includes(apiKey));
    assert(
      !(await readFile(join(directory, "agent-data/transcription.json"), "utf8")).includes(apiKey)
    );
  }
  await writeFile(
    installationPaths(directory).environment,
    `OPENTEAM_CONTROL_TOKEN=${controlToken}\nOPENTEAM_BIND_HOST=127.0.0.1\nOPENTEAM_API_PORT=${port}\n`,
    { mode: 0o600 }
  );
  assert.equal((await checkTranscription(installationPaths(directory))).level, "pass");
  record("owner saves encrypted provider settings and real CLI doctor verifies Parakeet");

  const fixture = join(directory, "speech.wav");
  await run([
    "say",
    "-v",
    "Samantha",
    "-o",
    join(directory, "speech.aiff"),
    "Please send the project update tomorrow morning.",
  ]);
  await run([
    "ffmpeg",
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    join(directory, "speech.aiff"),
    "-ac",
    "1",
    "-ar",
    "16000",
    fixture,
  ]);
  await run([
    "ffmpeg",
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    fixture,
    "-c:a",
    "libopus",
    join(directory, "speech.webm"),
  ]);
  for (const [extension, mime] of [
    ["wav", "audio/wav"],
    ["webm", "audio/webm"],
  ]) {
    const start = performance.now();
    const result = await client.transcribeAudio(
      new Blob([await Bun.file(join(directory, `speech.${extension}`)).arrayBuffer()], {
        type: mime,
      })
    );
    assert(result.text.toLowerCase().includes("project update tomorrow morning"));
    record(`real ${extension} upload through client and app HTTP route`, {
      text: result.text,
      milliseconds: Math.round(performance.now() - start),
    });
  }
  await assert.rejects(
    client.transcribeAudio(new Blob(["bad"], { type: "text/plain" })),
    /WAV|recording/
  );
  await client.updateTranscriptionSettings({ ...settings, apiKey: "invalid-test-key" });
  assert.equal((await checkTranscription(installationPaths(directory))).level, "fail");
  await assert.rejects(
    client.transcribeAudio(
      new Blob([await Bun.file(fixture).arrayBuffer()], { type: "audio/wav" })
    ),
    /rejected the API key/
  );
  await client.updateTranscriptionSettings({ ...settings, apiKey: apiKey ?? null });
  record("invalid audio and wrong provider credentials produce actionable failures, then recover");

  const browserDirectory = join(directory, "browser");
  await mkdir(browserDirectory);
  const build = await Bun.build({
    entrypoints: [join(repository, "apps/desktop/test/browser/voice-note-live.tsx")],
    outdir: browserDirectory,
    target: "browser",
    format: "esm",
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env.VITE_OPENTEAM_API_URL": JSON.stringify(baseUrl),
    },
  });
  assert(build.success, build.logs.join("\n"));
  const css = (await readdir(join(repository, "apps/desktop/dist/assets"))).find((file) =>
    /^index-.*\.css$/.test(file)
  );
  await writeFile(
    join(browserDirectory, "style.css"),
    css ? await readFile(join(repository, "apps/desktop/dist/assets", css)) : ""
  );
  await writeFile(
    join(browserDirectory, "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body style="padding:40px;max-width:850px"><div id="root"></div><script type="module" src="voice-note-live.js"></script></body></html>'
  );
  await writeFile(
    join(browserDirectory, "main.cjs"),
    `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
    app.setPath('userData',path.join(__dirname,'profile'));
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:1000,height:520,webPreferences:{backgroundThrottling:false}});
      const log=(value)=>fs.appendFileSync(path.join(__dirname,'browser.log'),value+'\\n');
      win.webContents.on('console-message',event=>log(event.message));
      win.webContents.on('render-process-gone',(_event,details)=>log(JSON.stringify(details)));
      log('Loading fixture');
      await win.loadFile(path.join(__dirname,'index.html'));
      log('Running fixture');
      const deadline=setTimeout(()=>{log('Browser deadline exceeded');app.exit(1);},150000);
      await win.webContents.executeJavaScript('window.runVoiceLive('+JSON.stringify({username:'voice.qa',password:process.env.QA_OWNER_PASSWORD,audioBase64:fs.readFileSync(process.env.QA_AUDIO_FILE).toString('base64')})+')',true);
      clearTimeout(deadline);
      const result=await win.webContents.executeJavaScript('window.voiceLiveResults');
      fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result));
      fs.writeFileSync(path.join(__dirname,'transcript.png'),(await win.webContents.capturePage()).toPNG());
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1);});
  `
  );
  const electron = createRequire(join(repository, "apps/desktop/package.json"))(
    "electron"
  ) as string;
  await run([electron, join(browserDirectory, "main.cjs")], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: undefined,
      QA_AUDIO_FILE: fixture,
      QA_OWNER_PASSWORD: ownerPassword,
    },
  });
  record(
    "native Chromium capture and real UI",
    JSON.parse(await readFile(join(browserDirectory, "results.json"), "utf8"))
  );
  const iosApp = argument("--ios-app");
  if (iosApp)
    record(
      "iPhone native upload and permission handling",
      await testNativeVoiceNote({
        appPath: resolve(iosApp),
        repository,
        directory,
        audio: fixture,
        serverUrl: baseUrl,
        username: "voice.qa",
        password: ownerPassword,
      })
    );
  assert.equal((await readdir(join(directory, "assets")).catch(() => [])).length, 0);
  record("voice-note transcription creates no stored chat attachments");
  passed = true;
} finally {
  if (server) {
    server.kill();
    await server.exited;
  }
  await computer.stop(true);
  if (createdDatabase) {
    await writeFile(
      join(directory, "postgres.log"),
      await run(["docker", "logs", name]).catch(() => "Logs unavailable")
    );
    await run(["docker", "rm", "--force", "--volumes", name]);
  }
  if (nativeDatabase)
    await run(["pg_ctl", "-D", join(directory, "postgres"), "-m", "fast", "-w", "stop"]);
  for (const path of [
    "agent-data",
    "workspace",
    "assets",
    ".env",
    "browser/profile",
    "postgres",
    "postgres-password",
  ])
    await rm(join(directory, path), { recursive: true, force: true });
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify({ status: passed ? "passed" : "failed", reports }, null, 2)
  );
  console.log(`Test artifacts: ${directory}`);
}
