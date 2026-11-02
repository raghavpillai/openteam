import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftRunningProcesses, processNotice, ProcessNotice } from "../src/runtime/process-notice";

let root: string;
let proc: string;
let terminals: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "process-notice-"));
  proc = join(root, "proc");
  terminals = join(root, "terminals");
  await mkdir(terminals, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const processEntry = async (pid: number, input: { shellId?: string; comm: string; ppid: number; state?: string; startTime?: string }) => {
  await mkdir(join(proc, String(pid)), { recursive: true });
  const environment = ["PATH=/usr/bin", ...(input.shellId ? [`OPENTEAM_SHELL_ID=${input.shellId}`] : [])].join("\0");
  await writeFile(join(proc, String(pid), "environ"), `${environment}\0`);
  // Field 22 is the start time; a name with spaces and parentheses must not shift the fields.
  const tail = [input.state ?? "S", input.ppid, ...Array.from({ length: 17 }, () => 0), input.startTime ?? `${pid}00`, 0, 0];
  await writeFile(join(proc, String(pid), "stat"), `${pid} (${input.comm}) ${tail.join(" ")}\n`);
};

const receipt = (id: string, scope: string, title: string, finished = true) =>
  writeFile(join(terminals, `${id}.log.job.json`), JSON.stringify({
    id, scope, title, outputPath: join(terminals, `${id}.log`), outputOffset: 0, startedAt: 1,
    ...(finished ? { outcome: { exitCode: 0, finishedAt: 2 } } : {}),
  }));

test("names a command by what the bot typed, from its output file, rather than its description", async () => {
  await receipt("111", "bot-a", "Start the preview server");
  await writeFile(join(terminals, "111.log"), `---\npid: 9\ncwd: "/home/box"\ncommand: "cd ~/site && nohup python3 -m http.server 8765 > \\"log\\" &"\ntitle: "Start the preview server"\nstatus: succeeded\n---\n\noutput`);
  await processEntry(200, { shellId: "111", comm: "python3", ppid: 1 });
  expect((await leftRunningProcesses(terminals, proc))["bot-a"]?.[0]?.command).toBe('cd ~/site && nohup python3 -m http.server 8765 > "log" &');
});

test("lists programs left running by finished or background Shell commands, by bot, naming programs rather than shells", async () => {
  await receipt("111", "bot-a", "cd /workspace/site && nohup python3 -m http.server 8765 &");
  await receipt("112", "bot-a", "sleep 600", false);
  await receipt("113", "bot-b", "nohup my (odd) server &");
  await processEntry(199, { shellId: "111", comm: "bash", ppid: 1 });
  await processEntry(200, { shellId: "111", comm: "python3", ppid: 199 });
  await processEntry(201, { shellId: "111", comm: "python3", ppid: 200 });
  await processEntry(300, { shellId: "112", comm: "sleep", ppid: 299 });
  await processEntry(400, { shellId: "113", comm: "my (odd) server", ppid: 1 });
  await processEntry(401, { shellId: "113", comm: "defunct", ppid: 1, state: "Z" });
  await processEntry(500, { comm: "Xvfb", ppid: 1 });
  await processEntry(600, { shellId: "999", comm: "orphan", ppid: 1 });
  // A Shell command sent to the background, whose subshell runs the server.
  await receipt("114", "bot-b", "npm run dev", false);
  await writeFile(join(terminals, "114.log.job.json"), JSON.stringify({ ...JSON.parse(await Bun.file(join(terminals, "114.log.job.json")).text()), background: true }));
  await processEntry(700, { shellId: "114", comm: "bash", ppid: 1 });
  await processEntry(701, { shellId: "114", comm: "bash", ppid: 700 });
  await processEntry(702, { shellId: "114", comm: "node", ppid: 701 });
  await processEntry(703, { shellId: "114", comm: "esbuild", ppid: 702 });

  const found = await leftRunningProcesses(terminals, proc);

  expect(found).toEqual({
    "bot-a": [{ shellId: "111", command: "cd /workspace/site && nohup python3 -m http.server 8765 &", programs: ["python3"], pid: 200, startTime: "20000" }],
    "bot-b": [
      { shellId: "113", command: "nohup my (odd) server &", programs: ["my (odd) server"], pid: 400, startTime: "40000" },
      { shellId: "114", command: "npm run dev", programs: ["node"], pid: 702, startTime: "70200" },
    ],
  });
});

test("each bot hears once, on its next turn, and earlier stops are kept until then", async () => {
  const ledger = join(root, "stopped-processes.json");
  await receipt("111", "bot-a", "nohup python3 -m http.server 8765 > server.log 2>&1 &");
  await processEntry(200, { shellId: "111", comm: "python3", ppid: 1 });
  await new ProcessNotice(terminals, ledger, proc).record();
  // A later stop before bot-a's next turn adds to what it will hear rather than replacing it.
  await receipt("112", "bot-a", "nohup sleep 86400 &");
  await processEntry(300, { shellId: "112", comm: "sleep", ppid: 1 });
  await new ProcessNotice(terminals, ledger, proc).record();

  // After the restart those processes are gone.
  await rm(proc, { recursive: true });
  const notice = new ProcessNotice(terminals, ledger, proc);
  expect(await notice.claim("bot-b")).toBeNull();
  const claimed = await notice.claim("bot-a");
  expect(claimed?.content).toBe(
    "<system_reminder>\nThe computer restarted, which stopped programs your earlier Shell commands had left running:\n" +
      "- `nohup python3 -m http.server 8765 > server.log 2>&1 &` (python3)\n- `nohup sleep 86400 &` (sleep)\n" +
      "If you still need them, start them again.\n</system_reminder>"
  );
  await notice.commit("bot-a", claimed!.keys);
  expect(await notice.claim("bot-a")).toBeNull();
});

test("a program still running is not reported, but one whose pid was reused is", async () => {
  const ledger = join(root, "stopped-processes.json");
  await receipt("111", "bot-a", "nohup python3 -m http.server &");
  await processEntry(200, { shellId: "111", comm: "python3", ppid: 1 });
  const notice = new ProcessNotice(terminals, ledger, proc);
  await notice.record();
  expect(await notice.claim("bot-a")).toBeNull();
  await notice.record();
  // After the restart another process has the same pid with a different start time.
  await rm(proc, { recursive: true });
  await processEntry(200, { comm: "bash", ppid: 1, startTime: "999999" });
  expect((await notice.claim("bot-a"))?.content).toContain("`nohup python3 -m http.server &` (python3)");
});

test("the reminder stays short with many programs", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({ shellId: String(index), command: `server ${index}`, programs: [], pid: index, startTime: "1" }));
  const text = processNotice(entries)!;
  expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
  expect(text).toContain("- and 3 more");
  expect(processNotice([])).toBeNull();
});
