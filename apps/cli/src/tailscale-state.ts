import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type InstallationPaths, writeFileAtomic } from "./config";
import { CliError } from "./errors";
import type { CommandRunner } from "./process";
import {
  configureTailscaleRoute,
  readTailscaleServe,
  removeTailscaleRoute,
  tailscaleRoute,
  type TailscaleHttps,
} from "./tailscale-https";

export interface ManagedTailscaleRoute {
  host: string;
  port: string;
  backendPort: string;
}
const file = (paths: InstallationPaths) => join(paths.directory, "tailscale-routes.json");
export const sameRoute = (a: ManagedTailscaleRoute, b: ManagedTailscaleRoute) =>
  a.host === b.host && a.port === b.port && a.backendPort === b.backendPort;
export function managedTailscaleRoutes(paths: InstallationPaths): ManagedTailscaleRoute[] {
  if (!existsSync(file(paths))) return [];
  try {
    const data = JSON.parse(readFileSync(file(paths), "utf8"));
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.routes) ||
      !data.routes.every(
        (r: ManagedTailscaleRoute) =>
          typeof r.host === "string" &&
          /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(r.host) &&
          [r.port, r.backendPort].every(
            (p) => typeof p === "string" && /^\d+$/.test(p) && Number(p) > 0 && Number(p) <= 65535
          )
      )
    )
      throw new Error();
    return data.routes;
  } catch {
    throw new CliError(
      "OpenTeam's tailscale-routes.json is invalid. Restore it from backup before managing Serve; existing routes were preserved."
    );
  }
}
function save(paths: InstallationPaths, routes: ManagedTailscaleRoute[]): void {
  writeFileAtomic(file(paths), `${JSON.stringify({ schemaVersion: 1, routes }, null, 2)}\n`, 0o600);
}
export function ensureManagedTailscaleRoute(
  paths: InstallationPaths,
  runner: CommandRunner,
  node: TailscaleHttps,
  backendPort: string
): ManagedTailscaleRoute | null {
  const routes = managedTailscaleRoutes(paths);
  const entry = { host: node.host, port: node.port || "443", backendPort };
  const wasFree =
    tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, node.port) === "free";
  let created = false;
  try {
    created = configureTailscaleRoute(runner, node, backendPort);
  } catch (error) {
    // A timeout can occur after tailscaled applied the command. Track a verified new
    // mapping so rollback and later disable can safely clean it up.
    try {
      if (
        wasFree &&
        tailscaleRoute(readTailscaleServe(runner), node.host, backendPort, node.port) === "matching"
      )
        save(paths, [...routes.filter((r) => !sameRoute(r, entry)), entry]);
    } catch {
      /* Preserve the original error; never blindly remove an unverified route. */
    }
    throw error;
  }
  if (created) {
    try {
      save(paths, [...routes.filter((r) => !sameRoute(r, entry)), entry]);
    } catch (error) {
      removeTailscaleRoute(runner, node, backendPort);
      throw error;
    }
  }
  return created ? entry : null;
}
export function removeManagedTailscaleRoute(
  paths: InstallationPaths,
  runner: CommandRunner,
  entry: ManagedTailscaleRoute
): void {
  const routes = managedTailscaleRoutes(paths);
  if (!routes.some((r) => sameRoute(r, entry))) return;
  removeTailscaleRoute(runner, { ...entry, addresses: [] }, entry.backendPort);
  save(
    paths,
    routes.filter((r) => !sameRoute(r, entry))
  );
}
export function cleanManagedTailscaleRoutes(
  paths: InstallationPaths,
  runner: CommandRunner,
  keep?: ManagedTailscaleRoute
): void {
  for (const entry of managedTailscaleRoutes(paths))
    if (!keep || !sameRoute(entry, keep)) removeManagedTailscaleRoute(paths, runner, entry);
}

/** Best-effort cleanup must never prevent restoring the previous server configuration. */
export function rollbackNewTailscaleRoutes(
  paths: InstallationPaths,
  runner: CommandRunner,
  previous: ManagedTailscaleRoute[]
): string[] {
  const errors: string[] = [];
  try {
    for (const route of managedTailscaleRoutes(paths)) {
      if (!previous.some((old) => sameRoute(old, route))) {
        try {
          removeManagedTailscaleRoute(paths, runner, route);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
