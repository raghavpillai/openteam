import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Linux inotify regression: Bun 1.3.8 replays a stale buffered suffix forever.
// SIGSTOP targets only this test's fresh child to queue a deterministic burst.
test.skipIf(process.platform !== "linux")("file watcher drains a burst and receives later changes without spinning", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-watcher-regression-"));
  const source = `const fs=require('node:fs');const seen=new Set();
    fs.watch(process.argv[1],(_event,file)=>seen.add(String(file)));
    process.stdin.on('data',()=>console.log(JSON.stringify({seen:[...seen]})));
    console.log(JSON.stringify({ready:true}));`;
  const child = spawn(process.execPath, ["--eval", source, root], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const rows: any[] = [];
  let pending = "";
  child.stdout!.on("data", (chunk) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      rows.push(JSON.parse(pending.slice(0, index)));
      pending = pending.slice(index + 1);
    }
  });
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 3_000;
    while (!await predicate()) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Watcher fixture did not respond");
      await Bun.sleep(10);
    }
  };
  const ticks = async () => {
    let total = 0;
    for (const tid of await readdir(`/proc/${child.pid}/task`)) {
      try {
        const text = await readFile(`/proc/${child.pid}/task/${tid}/stat`, "utf8");
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        total += Number(fields[11]) + Number(fields[12]);
      } catch { /* A helper thread can exit between reads. */ }
    }
    return total;
  };
  try {
    await until(() => rows.some(row => row.ready));
    child.kill("SIGSTOP");
    await until(async () => /State:\s+T/.test(await readFile(`/proc/${child.pid}/status`, "utf8")));
    for (let i = 0; i < 200; i++) await writeFile(join(root, `f${i}`), "fixture");
    child.kill("SIGCONT");
    await Bun.sleep(250);
    const before = await ticks();
    await Bun.sleep(1_000);
    const consumed = await ticks() - before;
    await writeFile(join(root, "marker"), "later event");
    await Bun.sleep(300);
    child.stdin!.write("stats\n");
    await until(() => rows.some(row => row.seen));
    const seen = rows.find(row => row.seen).seen as string[];
    expect(seen).toContain("marker");
    expect(seen.filter(name => /^f\d+$/.test(name))).toHaveLength(200);
    expect(consumed).toBeLessThan(25); // USER_HZ=100; catches a full-core spin.
  } finally {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
