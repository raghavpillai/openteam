import { expect, test } from "bun:test";
import { once } from "node:events";
import { readFile, access } from "node:fs/promises";
import { desktopMemoryForSpawn, removeDesktopMemory } from "../src/desktop-memory";
import { spawnAgentProcess } from "../src/agent-process";

const enabled = process.env.OPENTEAM_TEST_DESKTOP_MEMORY === "1" && process.platform === "linux";
const options = (id: string) => ({ env: { PATH: "/usr/bin:/bin", OPENTEAM_DESKTOP_ID: id }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] });
async function output(command: string, args: string[], id: string) {
  const child = spawnAgentProcess(command, args, options(id));
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", b => chunks.push(b));
  child.stderr.on("data", b => errors.push(b));
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout: Buffer.concat(chunks).toString(), stderr: Buffer.concat(errors).toString() };
}

test.skipIf(!enabled)("10 GiB is per desktop and inherited by ordinary and sudo descendants", async () => {
  const ids = ["memory-a/../../supervisor", "memory-b"];
  const before = process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT;
  process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT = "10g";
  try {
    const [a, b] = ids.map(id => desktopMemoryForSpawn(id)!);
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/desktops\/[a-f0-9]{64}$/);
    for (const group of [a!, b!]) {
      expect((await readFile(`${group}/memory.max`, "utf8")).trim()).toBe("10737418240");
      expect((await readFile(`${group}/memory.swap.max`, "utf8")).trim()).toBe("0");
    }
    const result = await output("/bin/sh", ["-c", 'id -u; cat /proc/self/cgroup; sh -c "cat /proc/self/cgroup"; if echo max > "$1/memory.max" 2>/dev/null; then exit 20; fi; if echo 0 > /sys/fs/cgroup/supervisor/cgroup.procs 2>/dev/null; then exit 21; fi; exit 0', "probe", a!], ids[0]!);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("1000");
    expect(result.stdout.match(new RegExp(a!.split("/").at(-1)!, "g"))).toHaveLength(2);
    expect(await readFile("/proc/self/cgroup", "utf8")).toContain("/supervisor");
    const elevated = await output("/usr/bin/sudo", ["-n", "sh", "-c", "id -u; cat /proc/self/cgroup"], ids[0]!);
    expect(elevated.code).toBe(0);
    expect(elevated.stdout.split("\n")[0]).toBe("0");
    expect(elevated.stdout).toContain(a!.split("/").at(-1)!);
    expect((await output("/usr/bin/id", ["-G"], ids[0]!)).stdout.trim()).toBe("1000 998");
    // Orphan descendants retain membership after their launching shell exits.
    const orphan = await output("/bin/sh", ["-c", 'sleep 60 </dev/null >/dev/null 2>&1 &'], ids[0]!);
    expect(orphan.code).toBe(0);
    expect((await readFile(`${a}/cgroup.procs`, "utf8")).trim()).not.toBe("");
    await removeDesktopMemory(ids[0]!);
    await expect(access(a!)).rejects.toThrow();
  } finally {
    await Promise.all(ids.map(removeDesktopMemory));
    process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT = before;
  }
}, 15_000);

test.skipIf(!enabled)("an over-budget desktop OOM leaves its peer and supervisor alive", async () => {
  const before = process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT;
  process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT = "128m";
  const ids = ["memory-overload", "memory-survivor"];
  const peer = spawnAgentProcess("/bin/sleep", ["60"], options(ids[1]!));
  const peerClosed = once(peer, "close");
  try {
    // Touched allocations exceed the small real cgroup ceiling, not JS heap or
    // a fake RSS monitor. Use a scaled cap to keep the host safely below 3 GiB.
    const result = await output("/usr/bin/python3", ["-c", "chunks=[]\nwhile True: chunks.append(bytearray(16*1024*1024))"], ids[0]!);
    expect(result.signal).toBe("SIGKILL");
    const group = desktopMemoryForSpawn(ids[0]!)!;
    const events = await readFile(`${group}/memory.events`, "utf8");
    expect(Number(events.match(/^oom_kill (\d+)/m)![1])).toBeGreaterThan(0);
    expect(peer.exitCode).toBeNull();
    expect(peer.signalCode).toBeNull();
    expect((await output("/bin/echo", ["peer-alive"], ids[1]!)).stdout.trim()).toBe("peer-alive");
    expect(await readFile("/proc/self/cgroup", "utf8")).toContain("/supervisor");
    console.info("Verified real cgroup OOM, peer survives, supervisor survives");
  } finally {
    peer.kill("SIGTERM");
    await peerClosed;
    await Promise.all(ids.map(removeDesktopMemory));
    process.env.OPENTEAM_DESKTOP_MEMORY_LIMIT = before;
  }
}, 20_000);

test.skipIf(!enabled)("capped launch retains cancellation and process-group signalling", async () => {
  const id = "memory-cancel";
  try {
    const controller = new AbortController();
    const child = spawnAgentProcess("/bin/sleep", ["60"], { ...options(id), detached: true, signal: controller.signal });
    const errors: string[] = [];
    child.on("error", error => errors.push(error.name));
    const closed = new Promise(resolve => child.once("close", resolve));
    controller.abort();
    await closed;
    expect(errors).toEqual(["AbortError"]);
  } finally { await removeDesktopMemory(id); }
}, 5_000);
