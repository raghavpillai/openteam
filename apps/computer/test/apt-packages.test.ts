import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aptPaths,
  archivesToPrune,
  nextRecordedList,
  packageSnapshot,
  parseAutoInstalled,
  parseInstalled,
  recordAfterApt,
  replayRecordedPackages,
  snapshotBeforeApt,
  type CommandRunner,
} from "../src/apt-packages";
import { AptReplayNotice } from "../src/runtime/apt-replay-notice";
import { withCurrentSearchPaths } from "../src/native-tool-executor";

const snapshot = (manual: string[], auto: string[] = []) =>
  packageSnapshot(Object.fromEntries([...manual, ...auto].map((name) => [name, "1"])), new Set(auto));

test("dpkg and apt state parse into installed and manual packages", () => {
  const installed = parseInstalled("ii \tjq\t1.7.1-6\nrc \told\t2\nii \tlibjq1\t1.7.1-6\niU \thalf\t3\n");
  expect(installed).toEqual({ jq: "1.7.1-6", libjq1: "1.7.1-6", half: "3" });
  const auto = parseAutoInstalled("Package: libjq1\nArchitecture: arm64\nAuto-Installed: 1\n\nPackage: jq\nArchitecture: arm64\nAuto-Installed: 0\n");
  expect([...auto]).toEqual(["libjq1"]);
  expect(packageSnapshot(installed, auto).manual).toEqual(["half", "jq"]);
});

test("the list records manual installs beyond the image, drops removals, and keeps packages that failed to come back", () => {
  const baseline = new Set(["bash", "curl"]);
  // A fresh install: the new manual package is recorded, its dependency and the image's packages are not.
  expect(nextRecordedList({ recorded: [], before: snapshot(["bash", "curl"]), after: snapshot(["bash", "curl", "cowsay"], ["libfoo"]), baseline })).toEqual(["cowsay"]);
  // A package installed with dpkg -i is picked up by the next apt run.
  expect(nextRecordedList({ recorded: ["cowsay"], before: snapshot(["bash", "cowsay", "local-tool"]), after: snapshot(["bash", "cowsay", "local-tool", "jq"]), baseline })).toEqual(["cowsay", "jq", "local-tool"]);
  // Removing a package takes it off the list.
  expect(nextRecordedList({ recorded: ["cowsay", "jq"], before: snapshot(["bash", "cowsay", "jq"]), after: snapshot(["bash", "jq"]), baseline })).toEqual(["jq"]);
  // fortune could not be reinstalled at start; an unrelated install must not forget it.
  expect(nextRecordedList({ recorded: ["cowsay", "fortune"], before: snapshot(["bash", "cowsay"]), after: snapshot(["bash", "cowsay", "jq"]), baseline })).toEqual(["cowsay", "fortune", "jq"]);
  // Without a snapshot (the pre-hook failed), nothing is dropped.
  expect(nextRecordedList({ recorded: ["cowsay"], after: snapshot(["bash"]), baseline })).toEqual(["cowsay"]);
});

test("the .deb cache keeps the newest download of each package within the cap", () => {
  const MB = 1024 ** 2;
  const entries = [
    { file: "jq_1.7.1-5_arm64.deb", size: MB, mtimeMs: 1 },
    { file: "jq_1.7.1-6_arm64.deb", size: MB, mtimeMs: 2 },
    { file: "cowsay_3.03%2bdfsg2-8_all.deb", size: MB, mtimeMs: 3 },
    { file: "big_1_arm64.deb", size: 8 * MB, mtimeMs: 4 },
    { file: "gone_1_arm64.deb", size: MB, mtimeMs: 5 },
    { file: "lock", size: 0, mtimeMs: 6 },
  ];
  expect(archivesToPrune(entries, new Set(["gone"]), 100 * MB)).toEqual(["gone_1_arm64.deb", "jq_1.7.1-5_arm64.deb"]);
  // Over the cap the oldest go first, until the rest fits.
  expect(archivesToPrune(entries, new Set(), 9 * MB)).toEqual(["cowsay_3.03%2bdfsg2-8_all.deb", "jq_1.7.1-5_arm64.deb", "jq_1.7.1-6_arm64.deb"]);
});

/** A fake dpkg/apt: `apt-get install` succeeds for what `available` allows in that mode. */
function fakeApt(root: string, initial: Record<string, string>, available: { offline: Set<string>; network: Set<string> }) {
  const installed = { ...initial };
  const calls: string[] = [];
  const extendedStates = join(root, "extended_states");
  const auto = new Set<string>();
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "dpkg-query")
      return { code: 0, output: Object.entries(installed).map(([name, version]) => `ii \t${name}\t${version}\n`).join("") };
    if (args.includes("update")) return { code: 0, output: "updated" };
    const names = args.slice(args.indexOf("install") + 1);
    const pool = args.includes("--no-download") ? available.offline : available.network;
    if (!names.every((name) => pool.has(name))) return { code: 100, output: "E: Unable to fetch some archives" };
    for (const name of names) installed[name] = "2";
    return { code: 0, output: "installed" };
  };
  return { installed, calls, run, extendedStates, auto, writeStates: () => writeFile(extendedStates, [...auto].map((name) => `Package: ${name}\nAuto-Installed: 1\n`).join("\n")) };
}

test("the apt hooks record an install and a removal, and trim the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-apt-hooks-"));
  const paths = aptPaths(join(root, "state"));
  const baselinePath = join(root, "baseline");
  await writeFile(baselinePath, "bash\ncurl\n");
  await mkdir(paths.archives, { recursive: true });
  const apt = fakeApt(root, { bash: "5", curl: "8" }, { offline: new Set(), network: new Set() });
  await apt.writeStates();
  const options = { paths, baselinePath, run: apt.run, extendedStates: apt.extendedStates };

  await snapshotBeforeApt(options);
  apt.installed.cowsay = "3";
  apt.installed.libfoo = "1";
  apt.auto.add("libfoo");
  await apt.writeStates();
  for (const [file, time] of [["cowsay_2_all.deb", 1], ["cowsay_3_all.deb", 2], ["libfoo_1_arm64.deb", 3]] as const) {
    await writeFile(join(paths.archives, file), "deb");
    await utimes(join(paths.archives, file), time, time);
  }
  await recordAfterApt(options);
  expect(await readFile(paths.packages, "utf8")).toBe("cowsay\n");
  expect((await readdir(paths.archives)).sort()).toEqual(["cowsay_3_all.deb", "libfoo_1_arm64.deb"]);

  await snapshotBeforeApt(options);
  delete apt.installed.cowsay;
  delete apt.installed.libfoo;
  await recordAfterApt(options);
  expect(await readFile(paths.packages, "utf8")).toBe("");
  expect(await readdir(paths.archives)).toEqual([]);
});

test("replay installs from the cache offline when it can, and from the network otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-apt-replay-"));
  const paths = aptPaths(root);
  await writeFile(paths.packages, "cowsay\njq\n");
  const offline = fakeApt(root, { bash: "5", jq: "1" }, { offline: new Set(["cowsay"]), network: new Set() });
  const status = await replayRecordedPackages({ paths, run: offline.run, log: () => {} });
  expect(status).toMatchObject({ state: "done", restored: ["cowsay"], failed: [] });
  // Already installed packages are not reinstalled, and no network step ran.
  expect(offline.calls.filter((call) => call.startsWith("apt-get"))).toEqual([
    "apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --no-download install cowsay",
  ]);

  const network = fakeApt(root, { bash: "5" }, { offline: new Set(), network: new Set(["cowsay", "jq"]) });
  expect(await replayRecordedPackages({ paths, run: network.run, log: () => {} })).toMatchObject({ restored: ["cowsay", "jq"], failed: [] });
  expect(network.calls.some((call) => call === "apt-get -q update")).toBe(true);
});

test("a package that can't be reinstalled is reported alone, and each bot hears once", async () => {
  const root = await mkdtemp(join(tmpdir(), "openteam-apt-failed-"));
  const paths = aptPaths(root);
  await writeFile(paths.packages, "cowsay\nvanished\n");
  const apt = fakeApt(root, { bash: "5" }, { offline: new Set(), network: new Set(["cowsay"]) });
  const lines: string[] = [];
  const status = await replayRecordedPackages({ paths, run: apt.run, log: (line) => lines.push(line) });
  expect(status).toMatchObject({ restored: ["cowsay"], failed: ["vanished"] });
  expect(lines.join("\n")).toContain("could not reinstall vanished");
  expect(await readFile(paths.log, "utf8")).toContain("failed: vanished");
  // The list keeps it, so a later start tries again.
  expect(await readFile(paths.packages, "utf8")).toBe("cowsay\nvanished\n");

  const notice = new AptReplayNotice(join(root, "told.json"), paths, apt.run);
  const claimed = await notice.claim("bot-a");
  expect(claimed?.content).toContain("could not be reinstalled: vanished.");
  await notice.commit("bot-a", claimed!.episode);
  expect(await new AptReplayNotice(join(root, "told.json"), paths, apt.run).claim("bot-a")).toBeNull();
  expect(await notice.claim("bot-b")).not.toBeNull();
  // Once someone installs it again, nobody else is told.
  apt.installed.vanished = "1";
  expect(await notice.claim("bot-b")).toBeNull();
});

test("a saved Shell environment gains the image's newer search paths", () => {
  const current = { PATH: "/home/box/.local/bin:/home/box/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin", NODE_PATH: "/home/box/.local/lib/node_modules:/usr/local/lib/node_modules" };
  const saved = { PATH: "/workspace/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin", NODE_PATH: "/usr/local/lib/node_modules", FOO: "1" };
  expect(withCurrentSearchPaths(saved, current)).toEqual({
    // An activated virtualenv stays in front.
    PATH: "/workspace/venv/bin:/home/box/.local/bin:/home/box/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin",
    NODE_PATH: "/home/box/.local/lib/node_modules:/usr/local/lib/node_modules",
    FOO: "1",
  });
  expect(withCurrentSearchPaths(current, current)).toEqual(current);
});
