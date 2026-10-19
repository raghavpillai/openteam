import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnAgentProcess } from "../src/agent-process";

// Run only in the disposable containers created by test-computer-admin.sh.
const enabled = process.platform === "linux" && process.getuid?.() === 0 &&
  process.env.OPENTEAM_TEST_COMPUTER_ADMIN === "1";

async function agent(command: string) {
  const child = spawnAgentProcess("/bin/sh", ["-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", chunk => stdout.push(chunk));
  child.stderr!.on("data", chunk => stderr.push(chunk));
  const [code] = await once(child, "close");
  return { code, stdout: Buffer.concat(stdout).toString().trim(), stderr: Buffer.concat(stderr).toString().trim() };
}

test.skipIf(!enabled)("computer grants sudo by default while ordinary commands remain non-root", async () => {
  expect(await agent("id -u")).toMatchObject({ code: 0, stdout: process.env.OPENTEAM_AGENT_UID || "1001" });
  expect(await agent("sudo -n id -u")).toMatchObject({ code: 0, stdout: "0" });
  expect(await agent("sudo -n sh -c 'printf verified > /usr/local/share/openteam-admin-probe'")).toMatchObject({ code: 0 });
  expect(await readFile("/usr/local/share/openteam-admin-probe", "utf8")).toBe("verified");
});

test.skipIf(!enabled)("sudo installs a local package and runs its maintainer script without network access", async () => {
  const directory = await mkdtemp("/tmp/openteam-admin-package-");
  await chmod(directory, 0o755);
  const root = join(directory, "package");
  await mkdir(join(root, "DEBIAN"), { recursive: true });
  await mkdir(join(root, "usr/share/openteam-admin-smoke"), { recursive: true });
  for (const path of ["", "DEBIAN", "usr", "usr/share", "usr/share/openteam-admin-smoke"]) {
    await chmod(join(root, path), 0o755);
  }
  await writeFile(join(root, "usr/share/openteam-admin-smoke/installed"), "installed\n");
  await writeFile(join(root, "DEBIAN/control"), "Package: openteam-admin-smoke\nVersion: 1.0\nArchitecture: all\nMaintainer: OpenTeam Test <test@example.invalid>\nDescription: Disposable admin capability test\n");
  await writeFile(join(root, "DEBIAN/postinst"), "#!/bin/sh\nset -eu\nid -u > /etc/openteam-admin-smoke\n", { mode: 0o755 });
  await chmod(join(root, "DEBIAN/postinst"), 0o755);
  const archive = join(directory, "openteam-admin-smoke.deb");
  const built = spawnSync("dpkg-deb", ["--build", root, archive], { encoding: "utf8" });
  expect(built, built.stderr).toMatchObject({ status: 0 });
  // Entrypoint umask is intentionally restrictive; make the fixture readable by runner.
  await chmod(archive, 0o644);
  const installed = await agent(`sudo -n apt-get install -y '${archive}'`);
  expect(installed, installed.stderr).toMatchObject({ code: 0 });
  expect(await readFile("/usr/share/openteam-admin-smoke/installed", "utf8")).toBe("installed\n");
  expect(await readFile("/etc/openteam-admin-smoke", "utf8")).toBe("0\n");
}, 30_000);
