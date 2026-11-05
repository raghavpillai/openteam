/**
 * After the image's Python minor or Node major version changes, bots' language packages in the
 * kept volumes stop loading: pip installs live in python3.X folders the new Python doesn't read,
 * uv tools point at the old interpreter, and native npm addons were built for the old Node. The
 * replay records the image's build and versions in the /usr/local volume, and on a change
 * reinstalls the pip packages bots asked for by name, reinstalls uv tools on the old Python and
 * rebuilds global npm packages.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKAGE_TOOL_ENVIRONMENT, runCommand, writeAtomic, type CommandRunner, type InstallsPaths } from "./apt-packages";

export interface ImageInfo { build: string; python: string; node: string }

export interface LanguageRebuild {
  python?: { from: string; to: string; reinstalled: string[]; failed: string[] };
  node?: { from: string; to: string; rebuilt: boolean };
}

export async function currentImage(run: CommandRunner = runCommand, buildIdPath = "/usr/lib/openteam/build-id"): Promise<ImageInfo> {
  const [build, python, node] = await Promise.all([
    readFile(buildIdPath, "utf8").then((text) => text.trim(), () => "unknown"),
    run("/usr/bin/python3", ["-I", "-S", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]),
    run("/usr/bin/node", ["-p", "process.versions.node.split('.')[0]"]),
  ]);
  return { build, python: python.output.trim(), node: node.output.trim() };
}

export async function readSavedImage(paths: InstallsPaths): Promise<ImageInfo | null> {
  try {
    const saved = JSON.parse(await readFile(paths.image, "utf8")) as ImageInfo;
    return typeof saved?.build === "string" && typeof saved.python === "string" && typeof saved.node === "string" ? saved : null;
  } catch {
    return null;
  }
}

export const saveImage = (paths: InstallsPaths, image: ImageInfo) => writeAtomic(paths.image, `${JSON.stringify(image)}\n`);

/** Distributions pip installed because they were asked for by name (its REQUESTED marker); dependencies follow them. */
export async function requestedDistributions(sitePackages: string): Promise<string[]> {
  const entries = await readdir(sitePackages).catch(() => [] as string[]);
  const names: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".dist-info")).sort()) {
    const info = join(sitePackages, entry);
    const requested = await readFile(join(info, "REQUESTED")).then(() => true, () => false);
    const name = requested ? /^Name:\s*(\S+)/m.exec(await readFile(join(info, "METADATA"), "utf8").catch(() => ""))?.[1] : undefined;
    if (name) names.push(name);
  }
  return names;
}

/** uv tools whose environment runs the image's Python at the old version. */
export async function uvToolsOn(toolsDirectory: string, python: string): Promise<string[]> {
  const tools: string[] = [];
  for (const tool of (await readdir(toolsDirectory).catch(() => [] as string[])).sort()) {
    const config = await readFile(join(toolsDirectory, tool, "pyvenv.cfg"), "utf8").catch(() => "");
    const home = /^home\s*=\s*(\S+)/m.exec(config)?.[1];
    const version = /^version_info\s*=\s*(\d+\.\d+)/m.exec(config)?.[1];
    if (home === "/usr/bin" && version === python) tools.push(tool);
  }
  return tools;
}

export interface LanguageOptions {
  run?: CommandRunner;
  /** The filesystem root and the bots' home; tests point these at a scratch tree. */
  root?: string;
  home?: string;
  agent?: { uid: number; gid: number };
}

/** Reinstalls or rebuilds what the version change broke; nothing when the versions match or nothing was recorded before. */
export async function rebuildLanguagePackages(previous: ImageInfo | null, current: ImageInfo, options: LanguageOptions = {}): Promise<LanguageRebuild | undefined> {
  if (!previous) return undefined;
  const run = options.run ?? runCommand;
  const root = options.root ?? "/";
  const home = options.home ?? "/home/box";
  const agent = options.agent ?? { uid: 1000, gid: 1000 };
  const asAgent = (command: string, args: readonly string[]) =>
    run("/usr/bin/setpriv", [`--reuid=${agent.uid}`, `--regid=${agent.gid}`, "--init-groups", "--", command, ...args], {
      timeoutMs: 15 * 60_000,
      env: { ...PACKAGE_TOOL_ENVIRONMENT, HOME: home, PATH: `/usr/bin:/bin:${home}/.local/bin` },
    });
  const asRoot = (command: string, args: readonly string[]) => run(command, args, { timeoutMs: 15 * 60_000 });
  const result: LanguageRebuild = {};

  if (previous.python && current.python && previous.python !== current.python) {
    const reinstalled: string[] = [];
    const failed: string[] = [];
    // pip installs all or nothing, so after a failed run each package gets its own try.
    const reinstall = async (names: string[], install: (names: string[]) => Promise<{ code: number | null }>) => {
      if (!names.length) return;
      if ((await install(names)).code === 0) { reinstalled.push(...names); return; }
      for (const name of names) ((await install([name])).code === 0 ? reinstalled : failed).push(name);
    };
    const pip = ["-m", "pip", "install", "--break-system-packages", "--no-input", "--disable-pip-version-check"];
    await reinstall(await requestedDistributions(join(root, `usr/local/lib/python${previous.python}/dist-packages`)),
      (names) => asRoot("/usr/bin/python3", ["-I", ...pip, "--root-user-action=ignore", ...names]));
    await reinstall(await requestedDistributions(join(home, `.local/lib/python${previous.python}/site-packages`)),
      (names) => asAgent("/usr/bin/python3", [...pip, "--user", ...names]));
    for (const tool of await uvToolsOn(join(home, ".local/share/uv/tools"), previous.python))
      ((await asAgent("/usr/lib/openteam/bin/uv", ["tool", "install", "--reinstall", "--python", "/usr/bin/python3", tool])).code === 0 ? reinstalled : failed).push(tool);
    if (reinstalled.length || failed.length) result.python = { from: previous.python, to: current.python, reinstalled, failed };
  }

  if (previous.node && current.node && previous.node !== current.node) {
    const globals = (await readdir(join(root, "usr/local/lib/node_modules")).catch(() => [] as string[])).filter((name) => !name.startsWith("."));
    if (globals.length) result.node = { from: previous.node, to: current.node, rebuilt: (await asRoot("/usr/bin/npm", ["rebuild", "--global"])).code === 0 };
  }
  return result.python || result.node ? result : undefined;
}
