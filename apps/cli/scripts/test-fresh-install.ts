/** Fresh Linux installer/preflight smoke test. Uses its own Docker-in-Docker engine. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { installScript } from "../../landing/lib/install-script";

const root = resolve(import.meta.dir, "../../..");
const output = resolve(root, "output/fresh-install");
const assets = resolve(output, "assets");
mkdirSync(assets, { recursive: true });
const recordings = resolve(output, "recordings");
mkdirSync(recordings, { recursive: true });
chmodSync(recordings, 0o777);
const log: string[] = [];
async function run(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  log.push(`$ ${args.join(" ")}\n${stdout}${stderr}`);
  writeFileSync(resolve(output, "harness.log"), log.join("\n"));
  if (code && !allowFailure) throw new Error(`${args[0]} exited ${code}: ${stderr.slice(-3000)}`);
  return { stdout, stderr, code };
}

const architecture = (await run(["docker", "info", "--format", "{{.Architecture}}"])).stdout.trim();
const arm = ["aarch64", "arm64"].includes(architecture);
if (!arm && !["x86_64", "amd64"].includes(architecture))
  throw new Error(`Unsupported engine: ${architecture}`);
const filename = `openteam-linux-${arm ? "arm64" : "x64"}`;
console.log("Building the standalone Linux CLI and fresh test environment…");
await run([
  process.execPath,
  "build",
  "apps/cli/src/main.ts",
  "--compile",
  "--minify",
  `--target=bun-linux-${arm ? "arm64" : "x64-baseline"}`,
  `--outfile=${resolve(assets, filename)}`,
]);
const binary = new Uint8Array(await Bun.file(resolve(assets, filename)).arrayBuffer());
await Bun.write(resolve(assets, `${filename}.gz`), Bun.gzipSync(binary));
const compose =
  "name: openteam\nservices:\n  server:\n    image: busybox:1.37\n    labels:\n      test.release: ${OPENTEAM_VERSION}\nvolumes:\n  openteam_workspace:\n";
writeFileSync(resolve(assets, "openteam-compose.yaml"), compose);
writeFileSync(
  resolve(assets, "SHA256SUMS"),
  `${createHash("sha256").update(binary).digest("hex")}  ${filename}\n` +
    `${createHash("sha256").update(compose).digest("hex")}  openteam-compose.yaml\n`
);
writeFileSync(resolve(assets, "bad-checksums"), `${"0".repeat(64)}  ${filename}\n`);
writeFileSync(resolve(assets, "latest.json"), JSON.stringify({ tag_name: "v0.0.1" }));
writeFileSync(resolve(output, "install.sh"), installScript);
copyFileSync(
  resolve(root, "apps/cli/test/fixtures/fresh-install.py"),
  resolve(output, "fresh-install.py")
);

const id = `openteam-preflight-${randomUUID().slice(0, 8)}`;
const engine = `${id}-engine`;
try {
  await run([
    "docker",
    "build",
    "-f",
    "apps/cli/test/fixtures/fresh-install.Dockerfile",
    "-t",
    "openteam-preflight-test:local",
    "apps/cli/test/fixtures",
  ]);
  await run(["docker", "network", "create", id]);
  await run([
    "docker",
    "run",
    "--detach",
    "--privileged",
    "--name",
    engine,
    "--network",
    id,
    "--network-alias",
    "engine",
    "--env",
    "DOCKER_TLS_CERTDIR=",
    "docker:29-dind",
    "--storage-driver=vfs",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await run(
      ["docker", "exec", engine, "docker", "info", "--format", "{{.ServerVersion}}"],
      true
    );
    if (result.code === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!ready) throw new Error("The isolated test engine did not start");
  console.log("Testing downloads, missing prerequisites, recovery, and the first setup screen…");
  const result = await run([
    "docker",
    "run",
    "--name",
    `${id}-client`,
    "--network",
    id,
    "--mount",
    `type=bind,src=${output},dst=/fixtures,readonly`,
    "--mount",
    `type=bind,src=${recordings},dst=/recordings`,
    "openteam-preflight-test:local",
  ]);
  writeFileSync(resolve(output, "results.txt"), result.stdout);
  console.log(result.stdout.trim());
} finally {
  await run(["docker", "rm", "--force", "--volumes", `${id}-client`, engine], true);
  await run(["docker", "network", "rm", id], true);
}
console.log(`Report: ${resolve(output, "results.txt")}`);
