import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../plaid/skills/plaid-setup/scripts/ensure-cli.sh", import.meta.url)
  .pathname;

async function fixture(run: (root: string, target: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "plaid-installer-"));
  try {
    await run(root, join(root, "managed CLI"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
const execute = (target: string, mode: string, env: Record<string, string> = {}) =>
  run(["bash", script, mode], { OPENTEAM_PLAID_CLI_DIR: target, ...env });

async function executable(path: string, body: string) {
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
}

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

test("Plaid read-only API and Hosted Link helpers keep selection, credential and duplicate-exchange guarantees", async () => {
  const result = await run(["python3", "-I", new URL("./plaid.test.py", import.meta.url).pathname]);
  expect(result).toMatchObject({ code: 0, stdout: "" });
  expect(result.stderr).toContain("OK");
});
