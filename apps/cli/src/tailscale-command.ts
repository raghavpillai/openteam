import { readFileSync } from "node:fs";
import type { TailscaleStatus } from "@openteam/contracts/tailscale";
import type { CliOptions } from "./arguments";
import {
  installationExists,
  parseEnvironment,
  readManifest,
  replaceEnvironmentValue,
  writeFileAtomic,
  type InstallationPaths,
} from "./config";
import { PROJECT_NAME } from "./constants";
import { requireComposeProject } from "./docker";
import { CliError } from "./errors";
import { checkHealth } from "./health";
import type { CommandRunner } from "./process";
import { inspectPublicReadiness } from "./public-readiness";
import {
  assertOwnServer,
  assertPortsAvailable,
  portRequirementsFromEnvironment,
  runningServices,
} from "./stack";
import {
  assertTailscaleRouteAvailable,
  detectTailscaleHttps,
  inspectTailscale,
  readTailscaleServe,
  requireTailscale,
  tailscaleHttpsHost,
  tailscaleRoute,
} from "./tailscale-https";
import {
  cleanManagedTailscaleRoutes,
  ensureManagedTailscaleRoute,
  managedTailscaleRoutes,
  rollbackNewTailscaleRoutes,
  sameRoute,
} from "./tailscale-state";
import { acquireUpdateLock } from "./update-safety";

export async function tailscaleStatus(
  paths: InstallationPaths,
  runner: CommandRunner,
  verify = false
): Promise<TailscaleStatus> {
  const env = parseEnvironment(readFileSync(paths.environment, "utf8"));
  const enabled = env.get("OPENTEAM_ACCESS_MODE") === "tailscale";
  const publicUrl = env.get("OPENTEAM_PUBLIC_URL") || "";
  const backendPort = env.get("OPENTEAM_API_PORT") || "8787";
  const result: TailscaleStatus = {
    enabled,
    publicUrl,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    httpsPort: "443",
    hostname: null,
    route: enabled ? "unavailable" : "disabled",
    ownership: "none",
    issue: null,
    verified: false,
    managedRoutes: 0,
  };
  try {
    const routes = managedTailscaleRoutes(paths);
    result.managedRoutes = routes.length;
    const inspected = inspectTailscale(runner);
    result.hostname = inspected.node?.host ?? null;
    result.issue = inspected.issue;
    if (!enabled) {
      if (!inspected.issue)
        result.httpsPort = detectTailscaleHttps(runner, backendPort)?.port || "443";
      if (routes.length && !inspected.issue) {
        const serve = readTailscaleServe(runner);
        const changed = routes.some(
          (r) => tailscaleRoute(serve, r.host, r.backendPort, r.port) === "occupied"
        );
        result.issue = changed
          ? "An old OpenTeam-managed mapping changed externally and was preserved. Inspect tailscale serve status before removing it manually."
          : "Old OpenTeam-managed mappings remain. Run openteam tailscale disable to clean them up.";
      }
      return result;
    }
    const url = new URL(publicUrl);
    result.httpsPort = url.port || "443";
    const target = { host: url.hostname, port: result.httpsPort, backendPort };
    if (inspected.issue || !inspected.node) return result;
    if (url.protocol !== "https:" || url.hostname !== inspected.node.host)
      throw new CliError(
        "The configured Tailscale hostname no longer matches this node. Run openteam tailscale enable to update it, then reconnect your apps."
      );
    const route = tailscaleRoute(
      readTailscaleServe(runner),
      url.hostname,
      backendPort,
      result.httpsPort
    );
    result.route = route === "free" ? "missing" : route === "occupied" ? "conflict" : "matching";
    result.ownership = routes.some((r) => sameRoute(r, target))
      ? "openteam"
      : route === "matching"
        ? "external"
        : "none";
    if (route !== "matching")
      throw new CliError(
        route === "free"
          ? "The Tailscale Serve mapping is missing. Run openteam tailscale enable to restore it."
          : "The Tailscale Serve mapping changed or conflicts with another route. Inspect tailscale serve status; use openteam tailscale enable --https-port <free-port>."
      );
    if (
      env.get("OPENTEAM_BIND_HOST") !== "127.0.0.1" ||
      env.get("OPENTEAM_VIEWER_BIND_HOST") !== "127.0.0.1"
    )
      throw new CliError(
        "Tailscale mode requires loopback backend ports. Run openteam tailscale enable to repair the configuration."
      );
    if (verify) {
      await verifyTailscaleEndpoint(publicUrl);
      result.verified = true;
    }
  } catch (error) {
    result.issue = error instanceof Error ? error.message : "Tailscale status is unavailable.";
  }
  return result;
}
export async function verifyTailscaleEndpoint(url: string): Promise<void> {
  const readiness = await inspectPublicReadiness(url);
  const errors = [readiness.dns, readiness.endpoint, readiness.tls]
    .filter((c) => c && !c.ok)
    .map((c) => c!.detail);
  if (errors.length || !readiness.tls)
    throw new CliError(
      `Tailscale HTTPS verification failed: ${errors.join("; ") || "TLS was not checked"}. Check Tailscale connectivity and run openteam tailscale status.`
    );
}

/** Changing access restarts the stack, preserving all unrelated environment settings. */
export async function configureTailscale(
  paths: InstallationPaths,
  runner: CommandRunner,
  action: "enable" | "disable",
  httpsPort?: string,
  dependencies = { health: checkHealth, verify: verifyTailscaleEndpoint, waitMs: 180_000 }
): Promise<void> {
  if (!installationExists(paths)) throw new CliError("Install OpenTeam with openteam setup first.");
  const release = acquireUpdateLock(paths);
  try {
    const manifest = readManifest(paths)!;
    if (!manifest.ownerUsername)
      throw new CliError("Finish account setup with openteam setup before enabling remote access.");
    const previous = readFileSync(paths.environment, "utf8");
    const env = parseEnvironment(previous);
    const oldRoutes = managedTailscaleRoutes(paths);
    const backendPort = env.get("OPENTEAM_API_PORT") || "8787";
    const enabled = env.get("OPENTEAM_ACCESS_MODE") === "tailscale";
    const oldUrl = env.get("OPENTEAM_PUBLIC_URL") || "";
    const node =
      action === "enable"
        ? requireTailscale(
            runner,
            httpsPort ||
              (enabled ? new URL(oldUrl).port : detectTailscaleHttps(runner, backendPort)?.port) ||
              "443"
          )
        : null;
    if (node) assertTailscaleRouteAvailable(runner, node, backendPort);
    if (!node && !enabled) {
      cleanManagedTailscaleRoutes(paths, runner);
      return;
    }
    const project = requireComposeProject(paths, runner, manifest.projectName || PROJECT_NAME);
    const running = runningServices(project);
    assertOwnServer(runner, await dependencies.health(paths), running, env);
    const url = node ? `https://${tailscaleHttpsHost(node)}` : `http://127.0.0.1:${backendPort}`;
    const values = {
      OPENTEAM_ACCESS_MODE: node ? "tailscale" : "local",
      OPENTEAM_BIND_HOST: "127.0.0.1",
      OPENTEAM_VIEWER_BIND_HOST: "127.0.0.1",
      OPENTEAM_PUBLIC_HOST: "127.0.0.1",
      OPENTEAM_PUBLIC_URL: url,
      OPENTEAM_AUTH_URL: url,
      COMPOSE_PROFILES: "direct",
    };
    let next = previous;
    for (const [key, value] of Object.entries(values))
      next = replaceEnvironmentValue(next, key, value);
    await assertPortsAvailable(
      runner,
      portRequirementsFromEnvironment(parseEnvironment(next), running)
    );
    let applied = false;
    try {
      writeFileAtomic(paths.environment, next, 0o600);
      project.runOrThrow(["config", "--quiet"]);
      applied = true;
      project.runOrThrow(["stop", "caddy"]);
      project.runOrThrow(["up", "--detach", "--remove-orphans"]);
      const deadline = Date.now() + dependencies.waitMs;
      let health = await dependencies.health(paths);
      while (!health.ok && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        health = await dependencies.health(paths);
      }
      if (!health.ok) throw new CliError(`OpenTeam did not become ready: ${health.detail}`);
      if (node) {
        ensureManagedTailscaleRoute(paths, runner, node, backendPort);
        await dependencies.verify(url);
      }
    } catch (error) {
      const cleanupErrors = rollbackNewTailscaleRoutes(paths, runner, oldRoutes);
      writeFileAtomic(paths.environment, previous, 0o600);
      const restored = !applied || project.run(["up", "--detach", "--remove-orphans"]).status === 0;
      throw new CliError(
        `${error instanceof Error ? error.message : error} Previous configuration restored${restored ? "" : "; restart failed, run openteam start"}.${cleanupErrors.length ? ` Route cleanup needs attention: ${cleanupErrors.join("; ")}` : ""}`,
        2
      );
    }
    // Commit before retiring the old route: cleanup failure must not remove the new,
    // verified endpoint or overwrite an unrelated route. State retains any leftovers.
    try {
      cleanManagedTailscaleRoutes(
        paths,
        runner,
        node ? { host: node.host, port: node.port || "443", backendPort } : undefined
      );
    } catch (error) {
      throw new CliError(
        `Connection is configured at ${url}, but an old route was preserved: ${error instanceof Error ? error.message : error} Run openteam tailscale status.`,
        2
      );
    }
  } finally {
    release();
  }
}

export async function tailscaleCommand(
  paths: InstallationPaths,
  options: CliOptions,
  runner: CommandRunner
): Promise<void> {
  if (!installationExists(paths)) throw new CliError("Install OpenTeam with openteam setup first.");
  if (options.command !== "tailscale-status")
    await configureTailscale(
      paths,
      runner,
      options.command === "tailscale-enable" ? "enable" : "disable",
      options.httpsPort
    );
  const status = await tailscaleStatus(paths, runner, true);
  if (options.json) console.log(JSON.stringify(status));
  else {
    console.log(
      `Tailscale HTTPS: ${status.enabled ? "enabled" : "disabled"}\nServer: ${status.publicUrl}\nBackend: ${status.backendUrl}\nRoute: ${status.route} (${status.ownership})`
    );
    if (status.issue) console.log(status.issue);
    if (status.managedRoutes) console.log(`OpenTeam-managed mappings: ${status.managedRoutes}`);
    if (options.command !== "tailscale-status")
      console.log(
        "Reconnect your apps using the server address above. Reused user-managed Serve mappings are preserved."
      );
  }
  if ((status.enabled || status.managedRoutes > 0) && status.issue) process.exitCode = 2;
}
