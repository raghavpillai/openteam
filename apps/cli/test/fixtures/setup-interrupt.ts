import {
  createEnvironment,
  installationPaths,
  replaceEnvironmentValue,
  writeFileAtomic,
  writeManifest,
} from "../../src/config";
import type { CommandRunner, RunResult } from "../../src/process";
import { setupCommand } from "../../src/setup";
import type { SetupPresentation } from "../../src/ui";

// Ctrl-C lands while the owner step's Docker command is still starting: the command fails with a
// plain status 1, and setup must still report the queued signal as an interruption.
const paths = installationPaths(process.argv[2]!);
const health = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json({ status: "ready", runtime: {}, release: { releaseVersion: "1.2.3" } }),
});
const port = String(health.port);
writeFileAtomic(paths.compose, "name: openteam\nservices:\n  server:\n    image: example/server\n");
writeFileAtomic(
  paths.environment,
  replaceEnvironmentValue(
    createEnvironment({ version: "1.2.3", workerConcurrency: "8" }),
    "OPENTEAM_API_PORT",
    port
  )
);
const now = new Date().toISOString();
writeManifest(paths, {
  schemaVersion: 1,
  repository: "owner/repo",
  version: "1.2.3",
  composeUrl: "https://example.com/openteam-compose.yaml",
  installedAt: now,
  updatedAt: now,
});
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const runner: CommandRunner = {
  run(command, args) {
    if (command === "tailscale") return ok("{}");
    if (command === "docker" && args[0] === "--version") return ok("Docker version 29.0.0");
    if (command === "docker" && args[0] === "info") return ok("29.0.0");
    if (args[0] === "compose" && args[1] === "version") return ok("Docker Compose version v2.30.0");
    if (args.includes("ps") && args.includes("--services")) {
      return ok("postgres\nserver\nworker\ncomputer\n");
    }
    if (args.includes("exec")) {
      process.kill(process.pid, "SIGINT");
      return { status: 1, stdout: "", stderr: "" };
    }
    return ok();
  },
};
const quiet: SetupPresentation = {
  start() {},
  stage() {},
  choices() {},
  message() {},
  summary() {},
  next() {},
};
try {
  await setupCommand(
    paths,
    runner,
    { presentation: quiet },
    {
      question: async () => "",
      secret: async () => "",
      close() {},
      session: async () => ({
        accessMode: "local",
        bindHost: "127.0.0.1",
        viewerBindHost: "127.0.0.1",
        publicHost: "127.0.0.1",
        publicUrl: `http://127.0.0.1:${port}`,
        composeProfiles: "direct",
        ownerUsername: "owner",
        ownerPassword: "correct horse battery staple",
        apiPort: port,
        workerConcurrency: "8",
      }),
    }
  );
  console.log("setup finished");
} catch (error) {
  console.log(`setup failed: ${error instanceof Error ? error.message : error}`);
} finally {
  health.stop(true);
}
