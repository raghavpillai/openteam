import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archivesToPrune,
  captureSources,
  classifyOrigin,
  forgetPackages,
  imagePackagePins,
  installFailureReason,
  installsPaths,
  installTarget,
  localDebArguments,
  nextRecordedList,
  packageSnapshot,
  parseAutoInstalled,
  parseInstalled,
  parsePolicy,
  parseSourceFile,
  readRecord,
  recordAfterApt,
  replayRecordedPackages,
  restoreSources,
  snapshotBeforeApt,
  unfetchedUrls,
  type CommandRunner,
} from "../src/apt-packages";
import { installNotice, InstallNotice } from "../src/runtime/install-notice";

const snapshot = (manual: string[], auto: string[] = []) =>
  packageSnapshot(Object.fromEntries([...manual, ...auto].map((name) => [name, "1"])), new Set(auto));

test("dpkg and apt state parse into installed and manual packages", () => {
  const installed = parseInstalled("ii \tjq\t1.7.1-6\nrc \told\t2\nii \tlibjq1\t1.7.1-6\niU \thalf\t3\n");
  expect(installed).toEqual({ jq: "1.7.1-6", libjq1: "1.7.1-6", half: "3" });
  const auto = parseAutoInstalled("Package: libjq1\nArchitecture: arm64\nAuto-Installed: 1\n\nPackage: jq\nArchitecture: arm64\nAuto-Installed: 0\n");
  expect([...auto]).toEqual(["libjq1"]);
  expect(packageSnapshot(installed, auto).manual).toEqual(["half", "jq"]);
});

test("the record keeps manual installs beyond the image, drops removals, and keeps packages that failed to come back", () => {
  const baseline = new Set(["bash", "curl"]);
  expect(nextRecordedList({ recorded: [], before: snapshot(["bash", "curl"]), after: snapshot(["bash", "curl", "cowsay"], ["libfoo"]), baseline })).toEqual(["cowsay"]);
  expect(nextRecordedList({ recorded: ["cowsay", "jq"], before: snapshot(["bash", "cowsay", "jq"]), after: snapshot(["bash", "jq"]), baseline })).toEqual(["jq"]);
  // fortune could not be reinstalled at start; an unrelated install must not forget it.
  expect(nextRecordedList({ recorded: ["cowsay", "fortune"], before: snapshot(["bash", "cowsay"]), after: snapshot(["bash", "cowsay", "jq"]), baseline })).toEqual(["cowsay", "fortune", "jq"]);
  // Without a snapshot (the pre-hook failed), nothing is dropped.
  expect(nextRecordedList({ recorded: ["cowsay"], after: snapshot(["bash"]), baseline })).toEqual(["cowsay"]);
});

test("the .deb cache evicts by download time, not by the server's file dates", () => {
  const MB = 1024 ** 2;
  const entries = [
    { file: "jq_1.7.1-5_arm64.deb", size: MB, downloadedMs: 1 },
    { file: "jq_1.7.1-6_arm64.deb", size: MB, downloadedMs: 2 },
    { file: "cowsay_3.03%2bdfsg2-8_all.deb", size: MB, downloadedMs: 3 },
    { file: "big_1_arm64.deb", size: 8 * MB, downloadedMs: 5 },
    { file: "gone_1_arm64.deb", size: MB, downloadedMs: 6 },
  ];
  expect(archivesToPrune(entries, new Set(["gone"]), 100 * MB)).toEqual(["gone_1_arm64.deb", "jq_1.7.1-5_arm64.deb"]);
  // A fresh large download evicts the earliest downloads, never itself.
  expect(archivesToPrune(entries, new Set(), 9 * MB)).toEqual(["cowsay_3.03%2bdfsg2-8_all.deb", "jq_1.7.1-5_arm64.deb", "jq_1.7.1-6_arm64.deb"]);
});

const POLICY = `gh:
  Installed: 2.103.0
  Candidate: 2.103.0
  Version table:
 *** 2.103.0 500
        500 https://cli.github.com/packages stable/main arm64 Packages
        100 /var/lib/dpkg/status
     2.46.0-3 500
        500 http://deb.debian.org/debian trixie/main arm64 Packages
jq:
  Installed: 1.7.1-6
  Candidate: 1.7.1-6
  Version table:
 *** 1.7.1-6 500
        500 http://deb.debian.org/debian trixie/main arm64 Packages
        100 /var/lib/dpkg/status
glow:
  Installed: 2.1.1
  Candidate: 2.1.1
  Version table:
 *** 2.1.1 100
        100 /var/lib/dpkg/status
vanished:
  Installed: (none)
  Candidate: (none)
  Version table:
`;
const IMAGE_SOURCES = new Set(["http://deb.debian.org/debian trixie", "http://deb.debian.org/debian-security trixie-security"]);

test("apt-cache policy tells where each installed version came from", () => {
  const policy = parsePolicy(POLICY);
  expect(policy.gh!.versions).toEqual([
    { version: "2.103.0", sources: [{ uri: "https://cli.github.com/packages", suite: "stable" }] },
    { version: "2.46.0-3", sources: [{ uri: "http://deb.debian.org/debian", suite: "trixie" }] },
  ]);
  expect(policy.vanished).toEqual({ installed: undefined, candidate: undefined, versions: [] });
  expect(classifyOrigin(policy.gh, IMAGE_SOURCES)).toEqual({ origin: "https://cli.github.com/packages stable" });
  expect(classifyOrigin(policy.jq, IMAGE_SOURCES)).toEqual({});
  expect(classifyOrigin(policy.glow, IMAGE_SOURCES)).toEqual({ local: true });
  // A package from a bot's source comes back only at a version that source has, never Debian's.
  expect(installTarget("gh", { origin: "https://cli.github.com/packages stable" }, policy.gh)).toBe("gh=2.103.0");
  const withoutRepo = parsePolicy(POLICY.replace("        500 https://cli.github.com/packages stable/main arm64 Packages\n", ""));
  expect(installTarget("gh", { origin: "https://cli.github.com/packages stable" }, withoutRepo.gh)).toBeUndefined();
  expect(installTarget("jq", {}, policy.jq)).toBe("jq");
  expect(installTarget("vanished", {}, policy.vanished)).toBeUndefined();
});

test("apt source files of both formats name their sources", () => {
  expect(parseSourceFile("Types: deb\nURIs: http://deb.debian.org/debian/\nSuites: trixie trixie-updates\nComponents: main\n\nTypes: deb\nURIs: http://deb.debian.org/debian-security\nSuites: trixie-security\n"))
    .toEqual(["http://deb.debian.org/debian trixie", "http://deb.debian.org/debian trixie-updates", "http://deb.debian.org/debian-security trixie-security"]);
  expect(parseSourceFile("# comment\ndeb [arch=arm64 signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main\n")).toEqual(["https://cli.github.com/packages stable"]);
});

test("dpkg's command line names the local .debs to keep", () => {
  expect(localDebArguments(["dpkg", "-i", "glow.deb", "/tmp/x/tool_1_arm64.deb"], "/workspace", "/cache/archives")).toEqual(["/workspace/glow.deb", "/tmp/x/tool_1_arm64.deb"]);
  expect(localDebArguments(["/usr/bin/dpkg", "--status-fd", "15", "--unpack", "/cache/archives/jq_1_arm64.deb"], "/", "/cache/archives")).toEqual([]);
});

test("apt errors read as reasons a bot can act on", () => {
  expect(installFailureReason("E: Unable to correct problems, you have held broken packages.")).toBe("its dependencies can't be met without replacing packages the computer's image provides");
  expect(installFailureReason("Reading...\nE: Sub-process /usr/bin/dpkg returned an error code (1)\n")).toBe("apt failed: Sub-process /usr/bin/dpkg returned an error code (1)");
  expect(unfetchedUrls("Hit:1 http://deb.debian.org/debian trixie InRelease\nErr:2 https://cli.github.com/packages stable InRelease\n  Could not resolve 'cli.github.com'\nW: Failed to fetch https://cli.github.com/packages/dists/stable/InRelease  Could not resolve\n"))
    .toEqual(["https://cli.github.com/packages", "https://cli.github.com/packages/dists/stable/InRelease"]);
});

interface FakeRepo { [name: string]: Array<{ version: string; uri: string; suite: string }> }

/** A fake dpkg/apt over a scratch tree. Repos list what each source offers; `cached` is what installs offline. */
async function fakeSystem(installed: Record<string, string>, repos: FakeRepo, options: { cached?: Set<string>; broken?: Set<string>; offlineNetwork?: boolean; unreachable?: Set<string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openteam-installs-"));
  const paths = installsPaths(join(root, "state"));
  const system = (path: string) => join(root, "system", path);
  const image = { baseline: join(root, "image/apt-baseline"), sourcesBaseline: join(root, "image/apt-sources-baseline"), buildId: join(root, "image/build-id") };
  await mkdir(dirname(image.baseline), { recursive: true });
  await writeFile(image.baseline, "bash\ncurl\n");
  await writeFile(image.sourcesBaseline, "/etc/apt/sources.list.d/debian.sources\n");
  await writeFile(image.buildId, "build-1\n");
  await mkdir(system("etc/apt/sources.list.d"), { recursive: true });
  await writeFile(system("etc/apt/sources.list.d/debian.sources"), "Types: deb\nURIs: http://deb.debian.org/debian\nSuites: trixie\nComponents: main\n");
  await mkdir(paths.archives, { recursive: true });
  await mkdir(paths.lists, { recursive: true });
  const auto = new Set<string>();
  const extendedStates = join(root, "extended_states");
  const calls: string[] = [];
  const configured = async () => new Set((await readdirDeep(system(""))).flatMap((file) => parseSourceFile(String(file.text))));
  const run: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "dpkg-query" && args[0] === "-W") return { code: 0, output: Object.entries(installed).map(([name, version]) => `ii \t${name}\t${version}\n`).join("") };
    if (command === "dpkg-query" && args[0] === "-S") return { code: 1, output: args.slice(1).map((path) => `dpkg-query: no path found matching pattern ${path}`).join("\n") };
    if (command === "dpkg" || command === "cp") return { code: 0, output: "" };
    const sources = await configured();
    const offered = (name: string) => (repos[name] ?? []).filter((entry) => sources.has(`${entry.uri} ${entry.suite}`) && !(options.offlineNetwork && !(options.cached?.has(name))));
    if (command === "apt-cache") {
      const names = args.slice(args.indexOf("policy") + 1);
      return { code: 0, output: names.map((name) => {
        const versions = offered(name);
        const own = installed[name];
        const table = versions.map((entry) => ` ${entry.version === own ? "***" : "   "} ${entry.version} 500\n        500 ${entry.uri} ${entry.suite}/main arm64 Packages\n`).join("");
        const status = own && !versions.some((entry) => entry.version === own) ? ` *** ${own} 100\n        100 /var/lib/dpkg/status\n` : "";
        return `${name}:\n  Installed: ${own ?? "(none)"}\n  Candidate: ${versions[0]?.version ?? "(none)"}\n  Version table:\n${table}${status}`;
      }).join("") };
    }
    if (args.includes("update")) {
      const failing = [...sources].filter((pair) => options.offlineNetwork || options.unreachable?.has(pair.split(" ")[0]!));
      return { code: 0, output: failing.map((pair, index) => `Err:${index + 1} ${pair.split(" ")[0]} ${pair.split(" ")[1]} InRelease\n  Temporary failure resolving`).join("\n") };
    }
    const targets = args.slice(args.indexOf("install") + 1);
    const offline = args.includes("--no-download");
    const names = targets.map((target) => (target.includes("/") ? basenameOf(target) : target.split("=")[0]!));
    const missing = (index: number) => offline && !targets[index]!.includes("/") && !options.cached?.has(names[index]!);
    if (offline && args.includes("--ignore-missing")) {
      targets.forEach((target, index) => { if (!missing(index) && !options.broken?.has(names[index]!)) installed[names[index]!] = repos[names[index]!]?.[0]?.version ?? "1"; });
      return { code: 0, output: "installed what the cache has" };
    }
    const bad = names.filter((name, index) => options.broken?.has(name) || missing(index));
    if (bad.length) return { code: 100, output: options.broken?.has(bad[0]!) ? "E: Unable to correct problems, you have held broken packages." : "E: Unable to fetch some archives" };
    if (args[0] === "-s") return { code: 0, output: "Inst" };
    targets.forEach((target, index) => (installed[names[index]!] = target.includes("=") ? target.split("=")[1]! : repos[names[index]!]?.[0]?.version ?? "1"));
    return { code: 0, output: "installed" };
  };
  return { root, paths, image, system, run, calls, installed, auto, extendedStates, writeStates: () => writeFile(extendedStates, [...auto].map((name) => `Package: ${name}\nAuto-Installed: 1\n`).join("\n")) };
}
const basenameOf = (path: string) => path.split("/").pop()!.split("_")[0]!;
async function readdirDeep(directory: string): Promise<Array<{ path: string; text: Buffer }>> {
  const out: Array<{ path: string; text: Buffer }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await readdirDeep(path)));
    else out.push({ path, text: await readFile(path) });
  }
  return out;
}

const DEBIAN = "http://deb.debian.org/debian";
const GH = "https://cli.github.com/packages";

test("the hooks record origins, kept .debs and the bot's apt sources, and drop a removal with its files", async () => {
  const fake = await fakeSystem({ bash: "5", curl: "8" }, { cowsay: [{ version: "3", uri: DEBIAN, suite: "trixie" }], gh: [{ version: "2.103.0", uri: GH, suite: "stable" }] });
  const options = { paths: fake.paths, image: fake.image, run: fake.run, extendedStates: fake.extendedStates, systemPath: fake.system, sourceLocations: ["/etc/apt/sources.list.d", "/etc/apt/keyrings"] };
  await mkdir(fake.system("etc/apt/keyrings"), { recursive: true });
  await writeFile(fake.system("etc/apt/keyrings/gh.gpg"), "key");
  await writeFile(fake.system("etc/apt/sources.list.d/gh.list"), `deb [signed-by=/etc/apt/keyrings/gh.gpg] ${GH} stable main\n`);

  await snapshotBeforeApt(options);
  Object.assign(fake.installed, { cowsay: "3", gh: "2.103.0", libfoo: "1", glow: "2.1.1", tool: "1.0" });
  fake.auto.add("libfoo");
  await fake.writeStates();
  // glow came through `apt install ./glow.deb` (apt's cache); tool through `dpkg -i` (kept by the pre-invoke hook).
  await writeFile(join(fake.paths.archives, "glow_2.1.1_arm64.deb"), "glow");
  await mkdir(fake.paths.local, { recursive: true });
  await writeFile(join(fake.paths.local, "tool_1.0_arm64.deb"), "tool");
  await recordAfterApt(options);
  expect(await readRecord(fake.paths)).toEqual({
    cowsay: { version: "3" },
    gh: { version: "2.103.0", origin: `${GH} stable` },
    glow: { version: "2.1.1", deb: "glow_2.1.1_arm64.deb" },
    tool: { version: "1.0", deb: "tool_1.0_arm64.deb" },
  });
  expect((await readdir(fake.paths.local)).sort()).toEqual(["glow_2.1.1_arm64.deb", "tool_1.0_arm64.deb"]);
  // The image's own source isn't copied; the bot's source and key are.
  expect((await readdirDeep(fake.paths.sources)).map(({ path }) => path.slice(fake.paths.sources.length)).sort()).toEqual(["/etc/apt/keyrings/gh.gpg", "/etc/apt/sources.list.d/gh.list"]);

  await snapshotBeforeApt(options);
  delete fake.installed.tool;
  await recordAfterApt(options);
  expect(Object.keys(await readRecord(fake.paths))).toEqual(["cowsay", "gh", "glow"]);
  expect(await readdir(fake.paths.local)).toEqual(["glow_2.1.1_arm64.deb"]);
});

test("kept sources come back where they are missing, and only a finished replay lets a removal through", async () => {
  const fake = await fakeSystem({ bash: "5" }, {});
  const options = { paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, sourceLocations: ["/etc/apt/sources.list.d"] };
  await writeFile(fake.system("etc/apt/sources.list.d/gh.list"), `deb ${GH} stable main\n`);
  await captureSources(options);
  const { rm } = await import("node:fs/promises");
  await rm(fake.system("etc/apt/sources.list.d/gh.list"));
  // A recreated computer before its replay: the copy stays and comes back.
  await captureSources({ ...options, removeGone: false });
  expect(await restoreSources(options)).toEqual(["/etc/apt/sources.list.d/gh.list"]);
  await rm(fake.system("etc/apt/sources.list.d/gh.list"));
  await captureSources({ ...options, removeGone: true });
  expect(await restoreSources(options)).toEqual([]);
});

test("replay installs offline when it can, and from its own lists otherwise", async () => {
  const fake = await fakeSystem({ bash: "5", curl: "8", jq: "1" }, { cowsay: [{ version: "3", uri: DEBIAN, suite: "trixie" }], jq: [{ version: "1", uri: DEBIAN, suite: "trixie" }], sl: [{ version: "5", uri: DEBIAN, suite: "trixie" }] }, { cached: new Set(["cowsay"]) });
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { cowsay: {}, jq: {}, sl: {} } }));
  const options = { paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} };
  const status = await replayRecordedPackages(options);
  expect(status).toMatchObject({ state: "done", failed: [], pending: [] });
  expect(status.restored.sort()).toEqual(["cowsay", "sl"]);
  const apt = fake.calls.filter((call) => call.startsWith("apt-get"));
  expect(apt[0]).toContain("--no-download --ignore-missing install cowsay sl");
  // The refresh and the online install use the replay's own lists, so a bot's `apt-get update` never waits on them.
  expect(apt[1]).toContain(`-o Dir::State::Lists=${fake.paths.replayLists}`);
  expect(apt[1]).toEndWith("-q update");
  expect(apt[2]).toEndWith("install sl");
  expect(fake.calls[0]).toBe("dpkg --configure -a");
  // With no source a bot added, there is nothing to pin.
  expect(fake.calls.some((call) => call.includes("Dir::Etc::Preferences"))).toBe(false);
});

test("while a bot's sources are configured, the image's packages can't come from them", async () => {
  expect(imagePackagePins(["bash", "curl"], ["cli.github.com"])).toBe(
    "Explanation: OpenTeam replay: the image's packages never come from a source a bot added.\nPackage: bash curl\nPin: origin \"cli.github.com\"\nPin-Priority: -1\n"
  );
  const fake = await fakeSystem({ bash: "5" }, { jq: [{ version: "1", uri: DEBIAN, suite: "trixie" }] });
  await writeFile(fake.system("etc/apt/sources.list.d/gh.list"), `deb ${GH} stable main\n`);
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { jq: {} } }));
  let pins = "";
  const run: CommandRunner = async (command, args, options) => {
    const preferences = args.find((arg) => arg.startsWith("Dir::Etc::Preferences="));
    if (preferences && !pins) pins = await readFile(preferences.split("=")[1]!, "utf8");
    return fake.run(command, args, options);
  };
  expect((await replayRecordedPackages({ paths: fake.paths, image: fake.image, run, systemPath: fake.system, log: () => {} })).restored).toEqual(["jq"]);
  expect(pins).toContain('Pin: origin "cli.github.com"');
  expect(pins).not.toContain("deb.debian.org");
  // The pins last only for the replay.
  expect(await stat(fake.paths.pins).catch(() => null)).toBeNull();
});

test("a package from a bot's source comes back from that source after its source is restored", async () => {
  const fake = await fakeSystem({ bash: "5" }, { gh: [{ version: "2.103.0", uri: GH, suite: "stable" }, { version: "2.46.0-3", uri: DEBIAN, suite: "trixie" }] });
  await mkdir(join(fake.paths.sources, "etc/apt/sources.list.d"), { recursive: true });
  await writeFile(join(fake.paths.sources, "etc/apt/sources.list.d/gh.list"), `deb ${GH} stable main\n`);
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { gh: { origin: `${GH} stable` } } }));
  const status = await replayRecordedPackages({ paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} });
  expect(status).toMatchObject({ restored: ["gh"], failed: [] });
  expect(fake.installed.gh).toBe("2.103.0");
  expect(fake.calls.some((call) => / install gh=2\.103\.0$/.test(call))).toBe(true);
});

test("one package that can't come back doesn't slow the rest, is marked once per image build, and the bot can forget it", async () => {
  const repos: FakeRepo = Object.fromEntries(["a", "b", "c", "d", "conflict"].map((name) => [name, [{ version: "1", uri: DEBIAN, suite: "trixie" }]]));
  const fake = await fakeSystem({ bash: "5" }, repos, { broken: new Set(["conflict"]) });
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { a: {}, b: {}, c: {}, d: {}, conflict: {}, vanished: {}, glow: { local: true }, gh: { origin: `${GH} stable` } } }));
  const options = { paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} };
  const status = await replayRecordedPackages(options);
  expect(status.restored.sort()).toEqual(["a", "b", "c", "d"]);
  expect(Object.fromEntries(status.failed.map(({ name, reason }) => [name, reason]))).toEqual({
    conflict: "its dependencies can't be met without replacing packages the computer's image provides",
    vanished: "no apt source the computer has offers it any more",
    glow: "it was installed from a .deb file that was not kept",
    gh: `its apt source (${GH} stable) no longer offers it`,
  });
  // The healthy packages went in together after a dry run set the conflict aside, not one by one.
  const installs = fake.calls.filter((call) => call.startsWith("apt-get") && !call.startsWith("apt-get -s") && call.includes(" install "));
  expect(installs.filter((call) => !call.includes("--no-download")).map((call) => call.slice(call.indexOf(" install ") + 9))).toEqual(["a b c d conflict", "a b c d"]);
  expect((await readRecord(fake.paths)).conflict?.failed?.build).toBe("build-1");

  // The next start on the same image is quiet about them and doesn't try again.
  fake.calls.length = 0;
  const again = await replayRecordedPackages(options);
  expect(again).toMatchObject({ restored: [], failed: [], pending: [] });
  expect(fake.calls.filter((call) => call.startsWith("apt-get"))).toEqual([]);
  // A new image tries each once more.
  await writeFile(fake.image.buildId, "build-2\n");
  expect((await replayRecordedPackages(options)).failed.map(({ name }) => name).sort()).toEqual(["conflict", "gh", "glow", "vanished"]);

  expect(await forgetPackages(["glow", "nope"], options)).toEqual({ forgotten: ["glow"], unknown: ["nope"] });
  expect(Object.keys(await readRecord(fake.paths))).not.toContain("glow");
});

test("without the network, packages wait for the next start instead of failing", async () => {
  const fake = await fakeSystem({ bash: "5" }, { cowsay: [{ version: "3", uri: DEBIAN, suite: "trixie" }] }, { offlineNetwork: true });
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { cowsay: {} } }));
  const status = await replayRecordedPackages({ paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} });
  expect(status).toMatchObject({ restored: [], failed: [], pending: ["cowsay"] });
  expect((await readRecord(fake.paths)).cowsay?.failed).toBeUndefined();
});

test("a kept .deb comes back by its file", async () => {
  const fake = await fakeSystem({ bash: "5" }, {});
  await mkdir(fake.paths.local, { recursive: true });
  await writeFile(join(fake.paths.local, "glow_2.1.1_arm64.deb"), "glow");
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { glow: { deb: "glow_2.1.1_arm64.deb" } } }));
  const status = await replayRecordedPackages({ paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} });
  expect(status.restored).toEqual(["glow"]);
  expect(fake.calls.some((call) => call.endsWith(`--no-download --ignore-missing install ${join(fake.paths.local, "glow_2.1.1_arm64.deb")}`))).toBe(true);
});

test("each bot hears once what the last start couldn't bring back", async () => {
  const fake = await fakeSystem({ bash: "5" }, {});
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { vanished: {}, glow: { local: true } } }));
  await replayRecordedPackages({ paths: fake.paths, image: fake.image, run: fake.run, systemPath: fake.system, log: () => {} });
  const notice = new InstallNotice(join(fake.root, "told.json"), fake.paths, fake.run);
  const claimed = await notice.claim("bot-a");
  expect(claimed?.content).toContain("could not reinstall these apt packages installed on it earlier: glow (it was installed from a .deb file that was not kept); vanished (no apt source the computer has offers it any more).");
  expect(claimed?.content).toContain("It won't try again until the computer's image changes.");
  expect(claimed?.content).toContain("`sudo openteam-installs forget glow vanished`");
  // Never the advice that can't work for a package whose source is gone.
  expect(claimed?.content).not.toContain("sudo apt-get install");
  await notice.commit("bot-a", claimed!.episode);
  expect(await new InstallNotice(join(fake.root, "told.json"), fake.paths, fake.run).claim("bot-a")).toBeNull();
  expect(await notice.claim("bot-b")).not.toBeNull();
  fake.installed.vanished = "1";
  fake.installed.glow = "1";
  expect(await notice.claim("bot-b")).toBeNull();
});

test("the notice says what a version change rebuilt", () => {
  const status = { id: "x", state: "done" as const, startedAt: "", restored: [], failed: [], pending: ["sl"], languages: { python: { from: "3.12", to: "3.13", reinstalled: ["rich", "ruff"], failed: ["oldpkg"] }, node: { from: "20", to: "22", rebuilt: true } } };
  const text = installNotice(status, {}, "/log")!;
  expect(text).toContain("not back yet, because the network or their apt source was unreachable at start: sl.");
  expect(text).toContain("Python changed from 3.12 to 3.13, so pip packages and uv tools installed for 3.12 were reinstalled for it: rich, ruff. These could not be reinstalled: oldpkg.");
  expect(text).toContain("Node.js changed from 20 to 22, so global npm packages in /usr/local were rebuilt for it.");
  expect(installNotice({ ...status, pending: [], languages: undefined }, {}, "/log")).toBeNull();
});

test("record files are readable by bots", async () => {
  const fake = await fakeSystem({ bash: "5" }, {});
  await forgetPackages([], { paths: fake.paths });
  await writeFile(fake.paths.packages, JSON.stringify({ packages: { a: {} } }));
  await forgetPackages(["a"], { paths: fake.paths });
  expect((await stat(fake.paths.packages)).mode & 0o044).toBe(0o044);
});
