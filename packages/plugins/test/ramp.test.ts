import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPackageArchive, importPackageArchive } from "@openteam/plugin-sdk/archive";
import { parsePluginRuntimeComponents } from "@openteam/plugin-sdk";
import { CLI_VERSION } from "../ramp/skills/ramp-openteam/scripts/ramp";
import { pluginCatalog } from "../src";

const wrapper = new URL("../ramp/skills/ramp-openteam/scripts/ramp.ts", import.meta.url).pathname;
const platforms: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-amd64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-amd64",
};

async function execute(root: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn(["bun", wrapper, ...args], {
    env: { ...process.env, OPENTEAM_RAMP_HOME: root, RAMP_PROFILE: "unrelated-profile", ...env },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function fixture(run: (root: string, executable: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ramp package "));
  const platform = platforms[`${process.platform}-${process.arch}`]!;
  const executable = join(root, "cli", CLI_VERSION, platform, `ramp-${platform}`);
  try {
    await mkdir(join(root, "cli", CLI_VERSION, platform), { recursive: true });
    await writeFile(
      executable,
      `#!/usr/bin/env bun
if (process.argv[2] === "--version") console.log("ramp-cli, version ${CLI_VERSION}");
else if (process.argv[2] === "fail") process.exit(17);
else console.log(JSON.stringify({args:process.argv.slice(2),configuration:process.env.XDG_CONFIG_HOME,profile:process.env.RAMP_PROFILE??null,input:await Bun.stdin.text()}));
`
    );
    await chmod(executable, 0o755);
    await run(root, executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Ramp exports preserve upstream playbooks and include working host setup assets", () => {
  const ramp = pluginCatalog.find((plugin) => plugin.key === "ramp")!;
  const { definition, warnings } = importPackageArchive(exportPackageArchive(ramp));
  expect(warnings).toEqual([]);
  expect(definition.skills).toHaveLength(30);
  expect(definition.connections[0]).toMatchObject({
    transport: "http",
    auth: "oauth",
    endpoint: "https://mcp.ramp.com/mcp",
    oauth: { registration: "dynamic", clientType: "public", shareClientCredentials: false },
  });
  for (const skill of definition.skills)
    expect(definition.files?.[`${skill.path}/SKILL.md`]).toBeTruthy();
  expect(
    definition.files?.["upstream/plugins/ramp/skills/ramp-agentic-purchase/browser-checkout.md"]
  ).toBeTruthy();
  expect(definition.files?.["skills/ramp-openteam/scripts/ramp.ts"]).toContain(CLI_VERSION);
  const components = parsePluginRuntimeComponents(definition.files ?? {});
  expect(components.rules).toMatchObject([{ name: "ramp-openteam", alwaysApply: true }]);
  expect(definition.files?.["LICENSE"]).toBe(definition.files?.["upstream/LICENSE"]);
});

test("CLI entry point isolates concurrent accounts and preserves arguments, stdin, and exit status", async () => {
  await fixture(async (root) => {
    const global = join(root, "global config");
    await mkdir(global);
    await writeFile(join(global, "sentinel"), "unrelated credentials");
    const [a, b] = await Promise.all([
      execute(
        root,
        ["--account", "account-a", "users", "me", "--json", '{"memo":"a b; $(echo nope)"}'],
        "input-a",
        { XDG_CONFIG_HOME: global }
      ),
      execute(root, ["--account", "account-b", "users", "me"], "input-b", {
        XDG_CONFIG_HOME: global,
      }),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(JSON.parse(a.stdout)).toEqual({
      args: ["users", "me", "--json", '{"memo":"a b; $(echo nope)"}'],
      configuration: join(root, "accounts", "account-a"),
      profile: null,
      input: "input-a",
    });
    expect(JSON.parse(b.stdout)).toMatchObject({
      configuration: join(root, "accounts", "account-b"),
      input: "input-b",
    });
    expect((await stat(join(root, "accounts", "account-a"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(global, "sentinel"), "utf8")).toBe("unrelated credentials");
    expect((await execute(root, ["--account", "account-a", "fail"])).code).toBe(17);
  });
});

test("CLI rejects traversal and symlinked account state", async () => {
  await fixture(async (root) => {
    expect((await execute(root, ["--account", "../outside", "users", "me"])).code).toBe(1);
    await mkdir(join(root, "accounts"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "accounts", "linked"));
    const result = await execute(root, ["--account", "linked", "users", "me"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must not be symlinks");
  });
});

test("CLI refuses an unexpected installed version without overwriting it", async () => {
  await fixture(async (root, executable) => {
    await writeFile(executable, "#!/bin/sh\necho unexpected-version\n");
    const result = await execute(root, ["install"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unexpected managed Ramp CLI version");
    expect(await readFile(executable, "utf8")).toContain("unexpected-version");
  });
});

test("CLI rejects a corrupted download before extraction or publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "ramp-bad-download-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const curl = join(bin, "curl");
    await writeFile(
      curl,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then printf corrupted > "$2"; exit 0; fi; shift; done\nexit 2\n'
    );
    await chmod(curl, 0o755);
    const result = await execute(root, ["install"], "", { PATH: `${bin}:${process.env.PATH}` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    const platform = platforms[`${process.platform}-${process.arch}`]!;
    expect(
      await Bun.file(join(root, "cli", CLI_VERSION, platform, `ramp-${platform}`)).exists()
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
