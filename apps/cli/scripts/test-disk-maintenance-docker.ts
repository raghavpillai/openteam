/** Real-daemon regression. Select an isolated test daemon explicitly; never prunes it. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvironment, installationPaths } from "../src/config";
import { ComposeProject } from "../src/docker";
import { captureStackImages, retainStackImages } from "../src/disk-maintenance";
import { SystemCommandRunner } from "../src/process";
import type { CommandRunner, RunOptions } from "../src/process";

const context = process.env.OPENTEAM_TEST_DOCKER_CONTEXT;
if (!context || context === "default" || context === "desktop-linux") {
  throw new Error("Set OPENTEAM_TEST_DOCKER_CONTEXT to an isolated throwaway Docker context");
}
const system = new SystemCommandRunner();
const runner: CommandRunner = {
  run(command, args, options) {
    return system.run(command, command === "docker" ? ["--context", context, ...args] : args, {
      timeoutMs: 120_000,
      ...options,
    });
  },
};
const run = (args: string[], options?: RunOptions) => {
  const result = runner.run("docker", args, options);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const root = realpathSync(mkdtempSync(join(tmpdir(), "openteam-retention-docker-")));
const prefix = `openteam-retention-test-${randomUUID()}`;
const created: string[] = [];
const containers: string[] = [];
const exists = (id: string) => runner.run("docker", ["image", "inspect", id]).status === 0;
const makeInstallation = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  const paths = installationPaths(dir);
  writeFileSync(paths.environment, "");
  return {
    paths,
    project: new ComposeProject(
      paths,
      {
        executable: "docker",
        prefix: ["compose"],
        version: "2.30.0",
        supported: true,
      },
      runner,
      `${prefix}-${name}`
    ),
  };
};
try {
  run(["info", "--format", "{{.ServerVersion}}"]);
  const tar = join(root, "rootfs.tar");
  const makeImage = (name: string) => {
    writeFileSync(join(root, "marker"), `${prefix}:${name}`);
    const packed = system.run("tar", ["--no-xattrs", "-cf", tar, "-C", root, "marker"]);
    assert.equal(packed.status, 0, packed.stderr);
    const id = run(["image", "import", tar]);
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    created.push(id);
    return id;
  };
  const eligible = makeImage("eligible");
  const digestSeed = makeImage("digest-pulled");
  // Pull a unique fixture by digest through a local registry, without a mutable
  // tag. The containerd image store reports this digest reference in RepoTags.
  const registry = run([
    "run",
    "--detach",
    "--name",
    `${prefix}-registry`,
    "--publish",
    "127.0.0.1::5000",
    "--tmpfs",
    "/var/lib/registry",
    "registry:2",
  ]);
  containers.push(registry);
  const registryPort = JSON.parse(run(["container", "inspect", registry]))[0].NetworkSettings.Ports[
    "5000/tcp"
  ][0].HostPort;
  const pushed = `localhost:${registryPort}/${prefix}:retired`;
  run(["image", "tag", digestSeed, pushed]);
  run(["push", pushed]);
  const pinned = JSON.parse(run(["image", "inspect", pushed]))[0].RepoDigests[0] as string;
  run(["image", "rm", pushed]);
  run(["pull", pinned]);
  const pulled = JSON.parse(run(["image", "inspect", pinned]))[0].Id as string;
  created.push(pulled);
  const stopped = makeImage("stopped");
  const raced = makeImage("container-race");
  const manual = makeImage("manual");
  const shared = makeImage("other-install");
  const unknown = makeImage("unknown");
  const current = makeImage("current");
  const next = makeImage("next");
  const final = makeImage("final");
  run(["image", "tag", manual, `${prefix}:manual`]);
  const stoppedContainer = run([
    "container",
    "create",
    "--name",
    `${prefix}-stopped`,
    stopped,
    "/missing",
  ]);
  containers.push(stoppedContainer);

  // A real running process and registry digest exercise behavior fake runners cannot model.
  run(["pull", "alpine:3.22"]);
  const alpine = JSON.parse(run(["image", "inspect", "alpine:3.22"]))[0];
  const digest = alpine.RepoDigests[0] as string;
  writeFileSync(join(root, "marker"), `${prefix}:live`);
  writeFileSync(join(root, "Dockerfile"), `FROM ${digest}\nCOPY marker /retention-fixture\n`);
  const live = run(["build", "--quiet", "--file", join(root, "Dockerfile"), root]);
  created.push(live);
  const liveContainer = run(["run", "--detach", "--name", `${prefix}-live`, live, "sleep", "300"]);
  containers.push(liveContainer);
  const one = makeInstallation("one");
  writeFileSync(one.paths.compose, `services:\n  pinned:\n    image: ${digest}\n`);
  assert.deepEqual(captureStackImages(one.paths, one.project, runner), [alpine.Id]);
  retainStackImages(
    one.paths,
    one.project,
    runner,
    [eligible, pulled, stopped, raced, manual, shared, live],
    [current]
  );
  retainStackImages(one.paths, one.project, runner, [current], [current]);
  for (const id of [eligible, pulled, stopped, raced, manual, shared, live])
    assert.equal(exists(id), true);
  const two = makeInstallation("two");
  retainStackImages(two.paths, two.project, runner, [shared], [shared]);
  const initialLedger = JSON.parse(
    readFileSync(join(one.paths.directory, "image-retention.json"), "utf8")
  );
  const pulledMarker = `openteam-retention-${initialLedger.owner}:${pulled.slice(7)}`;
  const interrupted: CommandRunner = {
    run(command, args, options) {
      if (args[0] === "image" && args[1] === "rm" && args[2] === pulledMarker)
        return { status: 1, stdout: "", stderr: "fixture interrupted cleanup" };
      return runner.run(command, args, options);
    },
  };
  assert.throws(
    () => retainStackImages(one.paths, one.project, interrupted, [current], [next]),
    /fixture interrupted cleanup/
  );
  assert.equal(exists(pulledMarker), true, "interrupted cleanup must retain the ownership marker");
  assert.equal(
    JSON.parse(
      readFileSync(join(one.paths.directory, "image-retention.json"), "utf8")
    ).owned.includes(pulled),
    true
  );
  const racedMarker = `openteam-retention-${initialLedger.owner}:${raced.slice(7)}`;
  let racedContainer = "";
  const racing: CommandRunner = {
    run(command, args, options) {
      if (args[0] === "image" && args[1] === "rm" && args[2] === racedMarker) {
        racedContainer = run(["container", "create", raced, "/missing"]);
        containers.push(racedContainer);
      }
      return runner.run(command, args, options);
    },
  };
  assert.throws(() => retainStackImages(one.paths, one.project, racing, [current], [next]));
  assert.notEqual(racedContainer, "", "fixture must create a container after the inventory check");
  assert.equal(
    exists(racedMarker),
    true,
    "Docker must protect an image referenced by a new container"
  );
  retainStackImages(one.paths, one.project, runner, [current], [next]);
  assert.equal(exists(eligible), false, "retired exclusively owned image must really disappear");
  assert.equal(exists(pulled), false, "retired digest-pulled image must really disappear");
  assert.equal(exists(pinned), false, "retired registry digest reference must really disappear");
  for (const id of [stopped, raced, manual, shared, live, unknown, current, next])
    assert.equal(exists(id), true, `protected image disappeared: ${id}`);
  assert.equal(JSON.parse(run(["container", "inspect", liveContainer]))[0].State.Running, true);
  run(["container", "rm", stoppedContainer]);
  containers.splice(containers.indexOf(stoppedContainer), 1);
  run(["container", "rm", racedContainer]);
  containers.splice(containers.indexOf(racedContainer), 1);
  retainStackImages(one.paths, one.project, runner, [next], [final]);
  assert.equal(
    exists(stopped),
    false,
    "retired image becomes eligible after its stopped container is removed"
  );
  assert.equal(exists(current), false);
  assert.equal(exists(raced), false, "cleanup must retry after the racing container is removed");
  for (const id of [manual, shared, live, unknown, next, final]) assert.equal(exists(id), true);
  const ledger = JSON.parse(
    readFileSync(join(one.paths.directory, "image-retention.json"), "utf8")
  );
  assert.deepEqual(ledger.current, [final]);
  assert.deepEqual(ledger.rollback, [next]);
  assert.equal(exists(digest), true, "pre-existing/pulled base images must remain untouched");
  const rendered = makeInstallation("release-config");
  writeFileSync(
    rendered.paths.compose,
    readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8")
  );
  writeFileSync(
    rendered.paths.environment,
    createEnvironment({ version: "0.0.13", imagePrefix: "fixture/openteam" })
  );
  const compose = () => {
    const result = rendered.project.run(["--profile", "*", "config", "--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { services: Record<string, { logging: unknown }> };
  };
  for (const service of Object.values(compose().services))
    assert.deepEqual(service.logging, {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    });
  writeFileSync(
    rendered.paths.environment,
    `${readFileSync(rendered.paths.environment, "utf8")}\nOPENTEAM_LOG_MAX_SIZE=-1\nOPENTEAM_LOG_MAX_FILES=5\n`
  );
  for (const service of Object.values(compose().services))
    assert.deepEqual(service.logging, {
      driver: "json-file",
      options: { "max-size": "-1", "max-file": "5" },
    });
  const logged = run([
    "run",
    "--detach",
    "--name",
    `${prefix}-logging`,
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=64k",
    "--log-opt",
    "max-file=2",
    live,
    "sh",
    "-c",
    "yes retention-fixture | head -c 524288",
  ]);
  containers.push(logged);
  assert.equal(run(["wait", logged]), "0");
  const logConfig = JSON.parse(run(["container", "inspect", logged]))[0].HostConfig.LogConfig;
  assert.deepEqual(logConfig, {
    Type: "json-file",
    Config: { "max-size": "64k", "max-file": "2" },
  });
  const logBytes = run(["logs", logged]);
  assert(
    logBytes.length > 0 && logBytes.length < 524288,
    "Docker did not rotate the fixture's log history"
  );
  console.log(
    "PASS: real Docker deletion including digest-pulled images; interrupted cleanup and container race recovery; digest capture; force-update rollback, live/stopped, manual, unknown and other-install protection; Compose log defaults/overrides; actual log rotation"
  );
} finally {
  // Remove only exact resources created above, never daemon-wide prune or production resources.
  for (const id of containers) runner.run("docker", ["container", "rm", "--force", id]);
  for (const id of created) {
    const inspected = runner.run("docker", ["image", "inspect", id]);
    if (inspected.status !== 0) continue;
    const tags: string[] = JSON.parse(inspected.stdout)[0].RepoTags ?? [];
    for (const tag of tags) runner.run("docker", ["image", "rm", tag]);
    runner.run("docker", ["image", "rm", id]);
  }
  rmSync(root, { recursive: true, force: true });
}
