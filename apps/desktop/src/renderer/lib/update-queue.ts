import {
  compareOpenTeamVersions,
  isOpenTeamVersion,
} from "@openteam/contracts/version-compatibility";
import type { ServerUpdateView } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";

export interface UpdateQueueState {
  targetVersion: string;
  status: "running" | "error" | "complete";
  step: "server" | "desktop";
  serverComplete: boolean;
  serverRequested: boolean;
  message: string;
}

export interface UpdateQueueDependencies {
  server: () => Promise<{ version: string; update: ServerUpdateView }>;
  busy: () => Promise<boolean>;
  startServer: (version: string) => Promise<unknown>;
  desktop: () => Promise<OpenTeamUpdateStatus>;
  checkDesktop: () => Promise<OpenTeamUpdateStatus>;
  downloadDesktop: (version: string) => Promise<void>;
  wait: () => Promise<void>;
  now: () => number;
  save: (state: UpdateQueueState | null) => void;
}

/** One owner survives settings navigation. Only the existing restart dialog installs the app. */
export class UpdateQueue {
  private state: UpdateQueueState | null;
  private running = false;
  private pendingDownload: {
    targetVersion: string;
    settled: boolean;
    failed: boolean;
    error?: unknown;
  } | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly dependencies: UpdateQueueDependencies,
    restored: unknown = null
  ) {
    const value = restored as Partial<UpdateQueueState> | null;
    this.state =
      value &&
      typeof value.targetVersion === "string" &&
      isOpenTeamVersion(value.targetVersion) &&
      !value.targetVersion.includes("-") &&
      ["running", "error", "complete"].includes(value.status ?? "") &&
      ["server", "desktop"].includes(value.step ?? "") &&
      typeof value.serverComplete === "boolean" &&
      typeof value.serverRequested === "boolean" &&
      typeof value.message === "string"
        ? (value as UpdateQueueState)
        : null;
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<UpdateQueueState>) {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.dependencies.save(this.state);
    for (const listener of this.listeners) listener();
  }

  start = async (targetVersion: string) => {
    if (this.running || this.state?.status === "running") return;
    if (!isOpenTeamVersion(targetVersion) || targetVersion.includes("-"))
      throw new Error("Choose a stable release to update.");
    this.state = {
      targetVersion,
      status: "running",
      step: "server",
      serverComplete: false,
      serverRequested: false,
      message: "Checking the connected server…",
    };
    await this.run();
  };

  resume = async () => {
    if (this.state?.status === "running") await this.run();
  };

  retry = async () => {
    if (this.state?.status !== "error" || this.running) return;
    this.publish({
      status: "running",
      serverRequested: this.state.serverComplete ? this.state.serverRequested : false,
      message: "Checking update progress…",
    });
    await this.run();
  };

  private async run() {
    if (!this.state || this.running) return;
    this.running = true;
    const deps = this.dependencies;
    const target = this.state.targetVersion;
    const previouslyComplete = this.state.serverComplete;
    // A persisted checkpoint is history, not a fresh health check or permission to restart.
    this.publish({ status: "running", serverComplete: false, step: "server" });
    try {
      if (
        this.pendingDownload &&
        !this.pendingDownload.settled &&
        this.pendingDownload.targetVersion !== target
      )
        throw new Error(
          "A desktop download is already starting for a different release. Wait for it to finish."
        );
      {
        this.publish({ step: "server", message: "Checking the connected server…" });
        const reconnectDeadline = deps.now() + 15 * 60_000;
        let current = await deps.server().catch(() => null);
        while (!current) {
          this.publish({ message: "Reconnecting to the server. Desktop is queued next." });
          if (deps.now() >= reconnectDeadline)
            throw new Error("Could not reconnect to the server. Retry to check its progress.");
          await deps.wait();
          current = await deps.server().catch(() => null);
        }
        if ((this.state.serverRequested || previouslyComplete) && current.update.status === "error")
          throw new Error(current.update.message || "The server update failed.");
        if (previouslyComplete && (compareOpenTeamVersions(current.version, target) ?? -1) < 0)
          throw new Error(
            "The server is no longer on the queued release. Retry to update the server before continuing."
          );
        if (current.update.phase === "rolling-back")
          throw new Error("The server is restoring its previous version. Desktop update paused.");
        if (
          (compareOpenTeamVersions(current.version, target) ?? -1) < 0 ||
          current.update.status === "updating"
        ) {
          if (current.update.status === "updating") {
            if (current.update.targetVersion !== target)
              throw new Error(
                "A different server update is already running. Wait for it to finish."
              );
            // An adopted host job must also remain observation-only after reopening.
            this.publish({ serverRequested: true });
          } else {
            if (this.state.serverRequested)
              throw new Error(
                current.update.message || "The server update did not finish. Retry to continue."
              );
            if (await deps.busy())
              throw new Error(
                "Bots are still working. Wait for them to finish, then retry the queue."
              );
            await deps.startServer(target);
            this.publish({ serverRequested: true });
          }
          this.publish({ message: "Updating the server. Desktop is queued next." });
          const deadline = deps.now() + 15 * 60_000;
          for (;;) {
            if (deps.now() >= deadline)
              throw new Error("The server is still reconnecting. Retry to check its progress.");
            await deps.wait();
            // Connection loss is expected while the host restarts. Both live endpoints must return.
            const next = await deps.server().catch(() => null);
            if (!next) continue;
            if (next.update.status === "error")
              throw new Error(next.update.message || "The server update failed.");
            if (next.update.phase === "rolling-back")
              throw new Error(
                "The server is restoring its previous version. Desktop update paused."
              );
            if (
              next.update.status !== "updating" &&
              (compareOpenTeamVersions(next.version, target) ?? -1) >= 0
            )
              break;
            if (next.update.status === "updated")
              throw new Error("The server restarted on an older version. Desktop update paused.");
          }
        }
        this.publish({ serverComplete: true, serverRequested: true });
      }
      this.publish({ step: "desktop", message: "Server updated. Preparing the desktop update…" });
      let desktop = await deps.desktop();
      if (["error", "idle", "checking"].includes(desktop.status))
        desktop = await deps.checkDesktop();
      if ((compareOpenTeamVersions(desktop.currentVersion, target) ?? -1) >= 0) {
        this.publish({ status: "complete", message: "Server and desktop are up to date." });
        return;
      }
      if (desktop.latestVersion !== target)
        throw new Error(
          "The desktop release changed. Check for updates, then update the desktop separately."
        );
      const deadline = deps.now() + 30 * 60_000;
      let download = this.pendingDownload;
      if (desktop.status === "available" && !download) {
        this.publish({ message: "Server updated. Downloading the desktop update…" });
        // Electron's download IPC resolves only after the entire download finishes. Observe it
        // without blocking polling, so a hung request cannot bypass the deadline or progress UI.
        const request = {
          targetVersion: target,
          settled: false,
          failed: false,
          error: undefined as unknown,
        };
        download = request;
        this.pendingDownload = request;
        void deps.downloadDesktop(target).then(
          () => {
            request.settled = true;
            if (this.pendingDownload === request) this.pendingDownload = null;
          },
          (error: unknown) => {
            request.settled = true;
            request.failed = true;
            request.error = error;
            if (this.pendingDownload === request) this.pendingDownload = null;
          }
        );
        desktop = await deps.desktop();
      }
      while (
        desktop.status === "downloading" ||
        (desktop.status === "available" && download && !download.settled)
      ) {
        if (download?.failed) throw download.error;
        if (desktop.latestVersion !== target)
          throw new Error(
            "The desktop release changed. Check for updates, then update the desktop separately."
          );
        this.publish({
          message: `Server updated. Downloading desktop ${Math.round(desktop.progress ?? 0)}%.`,
        });
        if (deps.now() >= deadline)
          throw new Error(
            "The desktop download is taking longer than expected. Retry to check its progress."
          );
        await deps.wait();
        desktop = await deps.desktop();
      }
      if (download?.failed) throw download.error;
      if (desktop.latestVersion !== target)
        throw new Error(
          "The desktop release changed. Check for updates, then update the desktop separately."
        );
      if (desktop.status === "available" && download?.settled) {
        this.publish({
          status: "complete",
          message: "Server updated. Complete the desktop update from the download page.",
        });
        return;
      }
      if (!["downloaded", "installing"].includes(desktop.status))
        throw new Error(
          desktop.message || "The desktop update could not be downloaded. Retry the desktop update."
        );
      this.publish({
        status: "complete",
        message: "Server updated. Desktop is ready to restart when you are.",
      });
    } catch (error) {
      this.publish({
        status: "error",
        message: clientErrorMessage(error, "The update queue stopped. Retry to continue."),
      });
    } finally {
      this.running = false;
    }
  }
}
