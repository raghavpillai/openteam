import { assertDesktopUpdateTarget } from "./update-status";

/** Own the native request outside renderer lifetimes, including its asynchronous setup. */
export class DesktopDownloadGate {
  private active: { targetVersion: string | null; promise: Promise<void> } | null = null;

  run(
    expectedVersion: unknown,
    latestVersion: string | null,
    download: () => Promise<void>
  ): Promise<void> {
    assertDesktopUpdateTarget(this.active?.targetVersion ?? latestVersion, expectedVersion);
    if (this.active) return this.active.promise;
    const active = { targetVersion: latestVersion, promise: Promise.resolve() };
    active.promise = Promise.resolve()
      .then(download)
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    this.active = active;
    return active.promise;
  }
}
