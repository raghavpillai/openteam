import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { InstallationPaths } from "./config";
import { parseEnvironment, writeFileAtomic } from "./config";
import type { ComposeProject } from "./docker";
import type { CommandRunner } from "./process";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const BACKUP_NAME =
  /^postgres-[0-9A-Za-z.+-]+-before-[0-9A-Za-z.+-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.sql$/;
export const DATABASE_BACKUPS_TO_KEEP = 3;

/** Reject symlinks in every path component, including the installation directory. */
export const assertMaintenancePath = (path: string): void => {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute || lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Maintenance skipped for ambiguous path: ${path}`);
  }
};

const readLedger = (paths: InstallationPaths, name: string): unknown => {
  assertMaintenancePath(paths.directory);
  const path = join(paths.directory, name);
  // existsSync follows symlinks, so also reject dangling links.
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertMaintenancePath(path);
  return JSON.parse(readFileSync(path, "utf8"));
};

const dockerJson = (runner: CommandRunner, args: string[]): unknown => {
  const result = runner.run("docker", args);
  if (result.status !== 0) throw new Error(`Docker inventory failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
};

const checkedIds = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((id) => typeof id === "string" && IMAGE_ID.test(id))
  ) {
    throw new Error("Invalid image retention history");
  }
  return [...new Set(value)];
};

const containerInventory = (
  runner: CommandRunner
): Array<{ Image: string; Config: { Labels: Record<string, string> | null } }> => {
  const result = runner.run("docker", ["container", "ls", "--all", "--quiet", "--no-trunc"]);
  if (result.status !== 0)
    throw new Error("Could not inventory all running and stopped containers");
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.every((id) => /^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid container inventory");
  if (!ids.length) return [];
  const containers = dockerJson(runner, ["container", "inspect", ...ids]);
  if (
    !Array.isArray(containers) ||
    containers.length !== ids.length ||
    containers.some(
      (c, index) =>
        c?.Id !== ids[index] ||
        !IMAGE_ID.test(c?.Image) ||
        !c?.Config ||
        !(
          c.Config.Labels === null ||
          (typeof c.Config.Labels === "object" && !Array.isArray(c.Config.Labels))
        )
    )
  ) {
    throw new Error("Incomplete container inventory");
  }
  return containers;
};

/** Capture before pulling mutable tags, including stopped one-shot services and all profiles. */
export const captureStackImages = (
  paths: InstallationPaths,
  project: ComposeProject,
  runner: CommandRunner
): string[] => {
  const result = project.run(["--profile", "*", "config", "--format", "json"]);
  if (result.status !== 0) throw new Error("Could not resolve full-stack image references");
  const config = JSON.parse(result.stdout);
  const services = Object.values(config.services ?? {}) as Array<{
    image?: string;
    profiles?: string[];
  }>;
  if (
    !services.length ||
    services.some(
      (service) =>
        typeof service.image !== "string" || !service.image || service.image.startsWith("-")
    )
  ) {
    throw new Error("Incomplete full-stack image configuration");
  }
  const ids: string[] = [];
  for (const ref of new Set(services.map((service) => service.image!))) {
    const result = runner.run("docker", ["image", "inspect", ref]);
    // Disabled optional profiles may never have been pulled. No local image means
    // nothing to retain; any other inventory failure disables maintenance.
    const optional = services
      .filter((service) => service.image === ref)
      .every((service) => Array.isArray(service.profiles) && service.profiles.length > 0);
    if (result.status !== 0) {
      if (optional && /No such image:/.test(result.stderr)) continue;
      throw new Error(`Could not inspect stack image ${ref}`);
    }
    const images = JSON.parse(result.stdout);
    if (!Array.isArray(images) || images.length !== 1)
      throw new Error("Incomplete full-stack image inventory");
    ids.push(...checkedIds(images.map((image) => image.Id)));
  }
  checkedIds(ids);
  for (const container of containerInventory(runner)) {
    const labels = container.Config.Labels;
    if (
      labels?.["com.docker.compose.project"] === project.projectName &&
      labels["com.docker.compose.project.working_dir"] === paths.directory
    )
      ids.push(container.Image);
  }
  return [...new Set(ids)];
};

interface ImageLedger {
  schemaVersion: 1;
  directory: string;
  project: string;
  owner: string;
  current: string[];
  rollback: string[];
  owned: string[];
}

/** Only called after successful readiness and CLI promotion. Never uses Docker prune or force. */
export const retainStackImages = (
  paths: InstallationPaths,
  project: ComposeProject,
  runner: CommandRunner,
  before: string[],
  after: string[]
): void => {
  checkedIds(before);
  checkedIds(after);
  const raw = readLedger(paths, "image-retention.json") as ImageLedger | undefined;
  if (
    raw !== undefined &&
    (!raw ||
      raw.schemaVersion !== 1 ||
      raw.directory !== paths.directory ||
      raw.project !== project.projectName ||
      !UUID.test(raw.owner))
  )
    throw new Error("Invalid image retention ledger");
  if (raw !== undefined) {
    checkedIds(raw.current);
    checkedIds(raw.rollback);
    checkedIds(raw.owned);
    if ([...raw.current, ...raw.rollback].some((id) => !raw.owned.includes(id)))
      throw new Error("Inconsistent image retention ledger");
  }
  const ledger: ImageLedger = {
    schemaVersion: 1,
    directory: paths.directory,
    project: project.projectName,
    owner: raw?.owner ?? randomUUID(),
    current: after,
    // Reinstalling/forcing the same image set must not consume the previous
    // distinct recovery point. Compare sets: Compose's service order can change.
    rollback:
      raw && raw.current.length === after.length && raw.current.every((id) => after.includes(id))
        ? raw.rollback
        : [...new Set([...(raw?.current ?? []), ...before])],
    owned: [...new Set([...(raw?.owned ?? []), ...before, ...after])],
  };
  const tag = (id: string) => `openteam-retention-${ledger.owner}:${id.slice(7)}`;
  const keep = new Set([...ledger.rollback, ...after]);
  for (const id of keep) {
    const result = runner.run("docker", ["image", "tag", id, tag(id)]);
    if (result.status !== 0) throw new Error(`Could not protect rollback image ${id}`);
  }
  // Persist protection before any removal; failures leave extra images, never less recovery material.
  writeFileAtomic(
    join(paths.directory, "image-retention.json"),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
  for (const id of ledger.owned) {
    if (keep.has(id)) continue;
    // Refresh for each deletion. Docker also refuses non-forced removal if a container races us.
    if (containerInventory(runner).some((container) => container.Image === id)) continue;
    const result = runner.run("docker", ["image", "inspect", tag(id)]);
    if (result.status !== 0) {
      // A missing marker grants no permission to remove by ID; other errors
      // mean inventory is unavailable, so stop the entire cleanup pass.
      if (/No such image:/.test(result.stderr)) continue;
      throw new Error(`Could not inspect retention marker for ${id}`);
    }
    const images = JSON.parse(result.stdout);
    if (
      !Array.isArray(images) ||
      images.length !== 1 ||
      images[0]?.Id !== id ||
      !Array.isArray(images[0].RepoTags)
    )
      throw new Error("Invalid owned image inventory");
    if (images[0].RepoTags.length !== 1 || images[0].RepoTags[0] !== tag(id)) continue;
    const removal = runner.run("docker", ["image", "rm", tag(id)]);
    if (removal.status !== 0)
      throw new Error(`Could not remove retired image ${id}: ${removal.stderr.trim()}`);
    ledger.owned = ledger.owned.filter((owned) => owned !== id);
  }
  writeFileAtomic(
    join(paths.directory, "image-retention.json"),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
};

interface BackupLedger {
  schemaVersion: 1;
  directory: string;
  files: string[];
}
const backupLedger = (paths: InstallationPaths): BackupLedger => {
  const raw = readLedger(paths, "backup-retention.json") as BackupLedger | undefined;
  if (
    raw !== undefined &&
    (!raw ||
      raw.schemaVersion !== 1 ||
      raw.directory !== paths.directory ||
      !Array.isArray(raw.files) ||
      !raw.files.every((name) => typeof name === "string" && BACKUP_NAME.test(name)))
  )
    throw new Error("Invalid backup retention ledger");
  return raw ?? { schemaVersion: 1, directory: paths.directory, files: [] };
};

/** Only explicitly registered dumps are owned; filename resemblance alone never grants ownership. */
export const registerDatabaseBackup = (paths: InstallationPaths, path: string): void => {
  assertMaintenancePath(paths.backups);
  assertMaintenancePath(path);
  const name = basename(path);
  if (join(paths.backups, name) !== path || !BACKUP_NAME.test(name) || !lstatSync(path).isFile())
    throw new Error("Invalid updater backup path");
  const ledger = backupLedger(paths);
  ledger.files = [...new Set([...ledger.files, name])];
  writeFileAtomic(
    join(paths.directory, "backup-retention.json"),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
};

export const retainDatabaseBackups = (
  paths: InstallationPaths,
  protectedPath: string | null
): void => {
  const setting =
    parseEnvironment(readFileSync(paths.environment, "utf8"))
      .get("OPENTEAM_BACKUP_RETENTION_COUNT")
      ?.trim() || String(DATABASE_BACKUPS_TO_KEEP);
  if (!/^(0|[1-9][0-9]*)$/.test(setting) || !Number.isSafeInteger(Number(setting))) {
    throw new Error(
      "OPENTEAM_BACKUP_RETENTION_COUNT must be a non-negative whole number; backups preserved"
    );
  }
  const count = Number(setting);
  if (count === 0) return; // Explicitly retain all updater restore points.
  const ledger = backupLedger(paths);
  assertMaintenancePath(paths.backups);
  // Inventory before deleting anything. Exported/missing files must not consume
  // retention slots and cause us to delete additional surviving restore points.
  const existing: string[] = [];
  const eligible = new Set<string>();
  for (const name of new Set(ledger.files)) {
    const path = join(paths.backups, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    assertMaintenancePath(path);
    existing.push(name);
    if (stat.isFile() && stat.nlink === 1 && stat.size > 0) eligible.add(name);
  }
  ledger.files = existing;
  const keep = new Set([...eligible].slice(-count));
  if (protectedPath) keep.add(basename(protectedPath));
  for (const name of [...ledger.files]) {
    if (keep.has(name) || !eligible.has(name)) continue;
    const path = join(paths.backups, name);
    if (!existsSync(path)) continue;
    assertMaintenancePath(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) continue;
    unlinkSync(path); // No recursion: manual directories and their contents are never removed.
    ledger.files = ledger.files.filter((file) => file !== name);
  }
  writeFileAtomic(
    join(paths.directory, "backup-retention.json"),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
};

export const maintenanceWarning = (action: string, operation: () => void): void => {
  try {
    operation();
  } catch (error) {
    console.warn(
      `OpenTeam disk maintenance skipped (${action}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
