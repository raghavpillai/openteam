import { expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignAgentOwnership, signalAgentProcess, spawnAgentProcess } from "../src/agent-process";
import { agentWriteStream } from "../src/agent-file-stream";
import { ScreenBroker } from "../src/screen-broker";
import { NativeToolExecutor } from "../src/native-tool-executor";

const enabled = process.platform === "linux" && process.getuid?.() === 0 && process.env.OPENTEAM_TEST_DROPPED_IDENTITY === "1";

test.skipIf(!enabled)("dropped child identity, private-file denial, cancellation and scoped ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-identity-"));
  try {
    await chmod(directory, 0o755);
    const secret = join(directory, "host-only");
    await writeFile(secret, "synthetic-host-secret", { mode: 0o600 });
    const child = spawnAgentProcess("/bin/sh", ["-c", 'id -u; if cat "$1" 2>/dev/null; then exit 20; fi', "probe", secret], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk));
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(Buffer.concat(output).toString().trim()).toBe("1001");

    const sleeper = spawnAgentProcess("/bin/sleep", ["30"], { stdio: "ignore" });
    const closed = once(sleeper, "close");
    expect(sleeper.kill()).toBe(true);
    expect((await closed)[1]).toBe("SIGTERM");

    const group = spawnAgentProcess("/bin/sh", ["-c", "echo ready; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    await once(group.stdout, "data");
    const groupClosed = once(group, "close");
    expect(signalAgentProcess(group, "SIGKILL", true)).toBe(true);
    expect((await groupClosed)[1]).toBe("SIGKILL");

    const controller = new AbortController();
    const cancelled = spawnAgentProcess("/bin/sleep", ["30"], { stdio: "ignore", signal: controller.signal });
    const errors: string[] = [];
    cancelled.on("error", error => errors.push(error.name));
    const cancellationClosed = new Promise(resolve => cancelled.once("close", resolve));
    controller.abort();
    await cancellationClosed;
    expect(errors).toEqual(["AbortError"]);

    const owned = join(directory, "owned");
    await writeFile(owned, "state");
    const link = join(directory, "link");
    await symlink(secret, link);
    await assignAgentOwnership([owned, link], true);
    expect((await stat(owned)).uid).toBe(1001);
    expect((await stat(secret)).uid).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test.skipIf(!enabled)("restricted file transfer writes intact bytes and cancels without replacing a destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transfer-"));
  await chown(directory, 1001, 1000);
  const target = join(directory, "destination");
  try {
    const payload = new TextEncoder().encode("verified-雪");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload); controller.close(); } });
    expect(await agentWriteStream(target, stream)).toBe(payload.length);
    expect(await readFile(target, "utf8")).toBe("verified-雪");
    expect((await stat(target)).uid).toBe(1001);
    const controller = new AbortController();
    const unfinished = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode("incomplete")); } });
    const writing = agentWriteStream(target, unfinished, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(writing).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("verified-雪");
    expect(await readdir(directory)).toEqual(["destination"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 10_000);

test.skipIf(!enabled)("native shell keeps its dropped identity and persists environment through a host-private capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-shell-"));
  await chmod(directory, 0o755);
  const working = join(directory, "working");
  const host = join(directory, "host");
  await mkdir(working);
  await mkdir(host, { mode: 0o700 });
  await chown(working, 1001, 1000);
  const executor = new NativeToolExecutor({ agentDir: host, controlToken: "synthetic-test-token" });
  try {
    const first = await executor.shell({ command: "id -u; export OPENTEAM_QA_VALUE=runtime923", block_until_ms: 5_000 }, working, undefined, undefined, "identity-test");
    expect(JSON.stringify(first.content)).toContain("1001");
    const next = await executor.shell({ command: 'printf "%s" "$OPENTEAM_QA_VALUE"', block_until_ms: 5_000 }, working, undefined, undefined, "identity-test");
    expect(JSON.stringify(next.content)).toContain("runtime923");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test.skipIf(!enabled)("actual restricted desktop starts VNC and Chrome and destroys its child processes", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-desktop-"));
  await chown(home, 1001, 1000);
  const broker = new ScreenBroker(home);
  const bot = crypto.randomUUID();
  try {
    const status = await broker.ensure(bot, "/workspace");
    expect(status.state).toBe("ready");
    const endpoint = await broker.browserEndpointForAgent(bot, "/workspace");
    const pages = await (await fetch(`${endpoint}/json/list`)).json() as {type: string; url: string}[];
    expect(pages.some(page => page.type === "page" && page.url === "about:blank")).toBe(true);
    const screenshot = await broker.screenshot(bot, "/workspace");
    expect(screenshot.subarray(1, 4).toString()).toBe("PNG");
    const session = (broker as any).sessions.get(bot);
    const children = [...session.processes];
    expect((await stat(join(session.runtimeDirectory, "config"))).uid).toBe(1001);
    await broker.destroy(bot);
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  } finally {
    await broker.destroy(bot);
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
