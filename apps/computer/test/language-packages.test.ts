import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../src/apt-packages";
import { rebuildLanguagePackages, requestedDistributions, uvToolsOn } from "../src/language-packages";

async function distribution(sitePackages: string, name: string, requested: boolean) {
  const info = join(sitePackages, `${name.toLowerCase()}-1.0.dist-info`);
  await mkdir(info, { recursive: true });
  await writeFile(join(info, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: 1.0\n`);
  if (requested) await writeFile(join(info, "REQUESTED"), "");
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "openteam-languages-"));
  const home = join(root, "home");
  await distribution(join(root, "usr/local/lib/python3.12/dist-packages"), "Rich", true);
  await distribution(join(root, "usr/local/lib/python3.12/dist-packages"), "markdown-it-py", false);
  await distribution(join(home, ".local/lib/python3.12/site-packages"), "humanize", true);
  for (const [tool, config] of [["ruff", "home = /usr/bin\nversion_info = 3.12.9\n"], ["black", "home = /home/box/.local/share/uv/python/cpython-3.11/bin\nversion_info = 3.11.2\n"]] as const) {
    await mkdir(join(home, ".local/share/uv/tools", tool), { recursive: true });
    await writeFile(join(home, ".local/share/uv/tools", tool, "pyvenv.cfg"), config);
  }
  await mkdir(join(root, "usr/local/lib/node_modules/better-sqlite3"), { recursive: true });
  return { root, home };
}

test("pip's REQUESTED marker and uv's venv config name what a Python change breaks", async () => {
  const { root, home } = await scratch();
  expect(await requestedDistributions(join(root, "usr/local/lib/python3.12/dist-packages"))).toEqual(["Rich"]);
  expect(await requestedDistributions(join(root, "missing"))).toEqual([]);
  // A tool on uv's own Python doesn't depend on the image's.
  expect(await uvToolsOn(join(home, ".local/share/uv/tools"), "3.12")).toEqual(["ruff"]);
});

test("a Python or Node version change reinstalls and rebuilds the bots' packages", async () => {
  const { root, home } = await scratch();
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code: args.includes("oops") ? 1 : 0, output: "" };
  };
  const result = await rebuildLanguagePackages({ build: "a", python: "3.12", node: "20" }, { build: "b", python: "3.13", node: "22" }, { run, root, home });
  expect(result).toEqual({
    python: { from: "3.12", to: "3.13", reinstalled: ["Rich", "humanize", "ruff"], failed: [] },
    node: { from: "20", to: "22", rebuilt: true },
  });
  expect(calls).toEqual([
    "/usr/bin/python3 -I -m pip install --break-system-packages --no-input --disable-pip-version-check --root-user-action=ignore Rich",
    "/usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups -- /usr/bin/python3 -m pip install --break-system-packages --no-input --disable-pip-version-check --user humanize",
    "/usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups -- /usr/lib/openteam/bin/uv tool install --reinstall --python /usr/bin/python3 ruff",
    "/usr/bin/npm rebuild --global",
  ]);
  // Same versions, or no versions recorded before this start: nothing to do.
  expect(await rebuildLanguagePackages({ build: "a", python: "3.13", node: "22" }, { build: "b", python: "3.13", node: "22" }, { run, root, home })).toBeUndefined();
  expect(await rebuildLanguagePackages(null, { build: "b", python: "3.13", node: "22" }, { run, root, home })).toBeUndefined();
});

test("one package pip can't reinstall doesn't stop the others", async () => {
  const { root, home } = await scratch();
  await distribution(join(root, "usr/local/lib/python3.12/dist-packages"), "oops", true);
  const run: CommandRunner = async (_command, args) => ({ code: args.includes("oops") ? 1 : 0, output: "" });
  const result = await rebuildLanguagePackages({ build: "a", python: "3.12", node: "22" }, { build: "b", python: "3.13", node: "22" }, { run, root, home });
  expect(result?.python).toEqual({ from: "3.12", to: "3.13", reinstalled: ["Rich", "humanize", "ruff"], failed: ["oops"] });
  expect(result?.node).toBeUndefined();
});
