import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../plaid/skills/plaid-setup/scripts/ensure-cli.sh", import.meta.url)
  .pathname;
const version = "20260909-fcd14fe6";

async function fixture(run: (root: string, target: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "plaid-installer-"));
  try {
    await run(root, join(root, "managed CLI"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function execute(target: string, mode: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", script, mode], {
    env: { ...process.env, OPENTEAM_PLAID_CLI_DIR: target, ...env },
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

async function executable(path: string, body: string) {
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
}

test("Plaid CLI check does not install; a verified managed CLI is reused", async () => {
  await fixture(async (_root, target) => {
    expect((await execute(target, "--check")).code).toBe(1);
    expect(await Bun.file(join(target, "plaid")).exists()).toBe(false);
    await mkdir(target);
    await executable(join(target, "plaid"), `printf '%s\\n' '${version}'`);
    expect(await execute(target, "--check")).toEqual({
      code: 0,
      stdout: `${join(target, "plaid")}\n`,
      stderr: "",
    });
    expect((await execute(target, "--install")).stdout).toBe(`${join(target, "plaid")}\n`);
  });
});

test("Plaid CLI installer refuses to overwrite an unexpected executable", async () => {
  await fixture(async (_root, target) => {
    await mkdir(target);
    await executable(join(target, "plaid"), "echo another-version");
    const result = await execute(target, "--install");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unexpected CLI version");
    expect(await Bun.file(join(target, "plaid")).text()).toContain("another-version");
  });
});

test("Plaid CLI installer rejects unsupported hosts before downloading", async () => {
  await fixture(async (root, target) => {
    const mocks = join(root, "bin");
    await mkdir(mocks);
    await executable(join(mocks, "uname"), "echo unsupported");
    const result = await execute(target, "--install", { PATH: `${mocks}:${process.env.PATH}` });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Supported hosts");
    expect(await Bun.file(join(target, "plaid")).exists()).toBe(false);
  });
});

test("Plaid CLI installer rejects a corrupted archive without installing it", async () => {
  await fixture(async (root, target) => {
    const mocks = join(root, "bin");
    await mkdir(mocks);
    await executable(
      join(mocks, "uname"),
      'if [[ "$1" == "-s" ]]; then echo Linux; else echo x86_64; fi'
    );
    await executable(
      join(mocks, "curl"),
      'while [[ $# -gt 0 ]]; do if [[ "$1" == "--output" ]]; then printf corrupted > "$2"; exit 0; fi; shift; done; exit 2'
    );
    const result = await execute(target, "--install", { PATH: `${mocks}:${process.env.PATH}` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(target, "plaid")).exists()).toBe(false);
  });
});
